// Campaign call dispatcher — production version.
//
// Replaces the branch's fetch-to-/api/calls/start implementation, which required
// a user bearer token and therefore could not run from pg_cron. We now call
// startCallForPatient / startPlivoCallForPatient directly in-process with the
// admin Supabase client. RLS is bypassed intentionally — the queue row's
// clinic_id is the source of truth and is preserved on the calls row.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { startCallForPatient } from "@/lib/calls.server";
import { startPlivoCallForPatient } from "@/lib/plivo-call.server";
import type { CampaignDispatchResult } from "../types";
import type { CampaignCallQueueService } from "./campaign-call-queue.service";

export interface DispatchCampaignQueueItemInput {
  // `request` is optional now — present when invoked from an authenticated
  // user-facing route, absent when invoked from the pg_cron public hook.
  request?: Request;
  queueItemId: string;
  patientId: string;
  campaignId: string;
}

function resolveProvider(): "twilio" | "plivo" {
  return "plivo";
}

// Synthesises a Request when the dispatcher is called from a cron context with
// no incoming HTTP request. startCallForPatient only uses the request to derive
// callback URLs, and it already prefers PUBLIC_APP_BASE_URL when that env is set.
function syntheticRequest(): Request {
  const base = (process.env.PUBLIC_APP_BASE_URL ?? "https://placeholder.invalid").replace(
    /\/+$/,
    "",
  );
  return new Request(`${base}/internal/campaign-dispatcher`);
}

export class CampaignCallDispatcherService {
  constructor(private readonly queueService: CampaignCallQueueService) {}

  async dispatch(input: DispatchCampaignQueueItemInput): Promise<CampaignDispatchResult> {
    await this.queueService.update(input.queueItemId, {
      status: "dialing",
      started_at: new Date().toISOString(),
      last_error: null,
    });

    const provider = resolveProvider();
    const request = input.request ?? syntheticRequest();

    try {
      const result =
        provider === "plivo"
          ? await startPlivoCallForPatient({
              request,
              supabase: supabaseAdmin,
              patientId: input.patientId,
              campaignId: input.campaignId,
            })
          : await startCallForPatient({
              request,
              supabase: supabaseAdmin,
              patientId: input.patientId,
              campaignId: input.campaignId,
            });

      await this.queueService.update(input.queueItemId, {
        call_id: result.callId,
        status: "in_progress",
        last_error: null,
      });

      return {
        queueItemId: input.queueItemId,
        callId: result.callId,
        provider,
        ok: true,
        phone: result.phone,
      };
    } catch (e) {
      // startCallForPatient throws Response objects on validation errors and
      // plain Error on telephony failures. Normalise both to a string.
      let message: string;
      if (e instanceof Response) {
        try {
          const body = await e.clone().json();
          message = (body as { error?: string }).error ?? `HTTP ${e.status}`;
        } catch {
          message = `HTTP ${e.status}`;
        }
      } else {
        message = e instanceof Error ? e.message : String(e);
      }

      await this.queueService.update(input.queueItemId, {
        status: "failed",
        last_error: message,
      });

      return {
        queueItemId: input.queueItemId,
        callId: null,
        provider,
        ok: false,
        phone: null,
        error: message,
      };
    }
  }
}
