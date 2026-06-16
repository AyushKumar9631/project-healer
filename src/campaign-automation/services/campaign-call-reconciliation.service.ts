import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import type {
  CampaignCallTerminalState,
  CampaignCallQueueOutcome,
  CampaignCallQueueRow,
} from "../types";
import type { CampaignCallQueueService } from "./campaign-call-queue.service";

type CallRow = {
  id: string;
  status: string;
  ended_at: string | null;
  callback_requested: boolean;
  appointment_time: string | null;
  intent: string | null;
  notes: string | null;
};
type CallOutcomeRow = { call_id: string; success: boolean; structured: Json };

export interface ReconcileCampaignCallsInput {
  campaignId?: string;
}
export interface ReconcileCampaignCallsResult {
  checkedCount: number;
  updatedCount: number;
  updatedQueueItemIds: string[];
}

export class CampaignCallReconciliationService {
  constructor(private readonly queueService: CampaignCallQueueService) {}

  async reconcile(input: ReconcileCampaignCallsInput = {}): Promise<ReconcileCampaignCallsResult> {
    const rows = await this.queueService.list(
      input.campaignId ? { campaign_id: input.campaignId } : {},
    );
    const activeRows = rows.filter(
      (row) => row.call_id && (row.status === "dialing" || row.status === "in_progress"),
    );
    const updatedQueueItemIds: string[] = [];

    for (const row of activeRows) {
      const state = await this.resolveTerminalState(row);
      if (!state) continue;

      await this.queueService.update(row.id, {
        status: state.status,
        outcome: state.outcome,
        completed_at: state.completedAt,
        last_error: state.lastError,
        retry_count: (state as any).retryCount ?? row.retry_count,
      });
      updatedQueueItemIds.push(row.id);
    }
    return {
      checkedCount: activeRows.length,
      updatedCount: updatedQueueItemIds.length,
      updatedQueueItemIds,
    };
  }

  private async resolveTerminalState(
    row: CampaignCallQueueRow,
  ): Promise<CampaignCallTerminalState | null> {
    const { data: call, error: callError } = await supabaseAdmin
      .from("calls")
      .select("id,status,ended_at,callback_requested,appointment_time,intent,notes")
      .eq("id", row.call_id!)
      .maybeSingle();
    if (callError) throw callError;
    if (!call) return null;

    const isTerminal =
      !!call.ended_at ||
      ["completed", "failed", "busy", "no_answer", "voicemail", "declined"].includes(call.status);
    if (!isTerminal) return null;

    const { data: callOutcome, error: outcomeError } = await supabaseAdmin
      .from("call_outcomes")
      .select("call_id,success,structured")
      .eq("call_id", call.id)
      .maybeSingle();
    if (outcomeError) throw outcomeError;

    const outcome = this.resolveQueueOutcome(call as CallRow, callOutcome as CallOutcomeRow | null);

    // NEW: Added callback_requested to the retryable list!
    const isRetryable =
      outcome === "busy" ||
      outcome === "no_answer" ||
      outcome === "failed" ||
      outcome === "callback_requested";
    let finalStatus: "completed" | "failed" | "retry_scheduled";
    let newRetryCount = row.retry_count || 0;

    // NEW: Removed the 'maxRetries' limit! It will always flag for retry now.
    if (isRetryable) {
      finalStatus = "retry_scheduled";
      newRetryCount += 1;
    } else if (call.status === "completed") {
      finalStatus = "completed";
    } else {
      finalStatus = "failed";
    }

    return {
      status: finalStatus,
      outcome,
      retryCount: newRetryCount,
      lastError:
        finalStatus !== "completed"
          ? (call.notes ?? `Call ended with status ${call.status}`)
          : null,
      completedAt: call.ended_at ?? new Date().toISOString(),
    } as any;
  }

  private resolveQueueOutcome(
    call: CallRow,
    callOutcome: CallOutcomeRow | null,
  ): CampaignCallQueueOutcome | null {
    if (call.appointment_time) return "appointment_booked";
    if (call.callback_requested) return "callback_requested";
    if (call.status === "busy") return "busy";
    if (call.status === "no_answer") return "no_answer";
    if (call.status === "failed") return "failed";
    const intent = call.intent ?? this.readStructuredString(callOutcome?.structured, "intent");
    if (intent === "interested") return "interested";
    if (intent === "not_interested") return "not_interested";
    if (intent === "busy") return "busy";
    const structuredOutcome = this.readStructuredString(callOutcome?.structured, "outcome");
    if (structuredOutcome === "interested") return "interested";
    if (structuredOutcome === "not_interested") return "not_interested";
    if (structuredOutcome === "busy") return "busy";
    if (structuredOutcome === "no_answer") return "no_answer";
    if (structuredOutcome === "appointment_booked") return "appointment_booked";
    if (structuredOutcome === "callback_requested") return "callback_requested";
    if (structuredOutcome === "failed") return "failed";
    return call.status === "completed" ? "interested" : null;
  }

  private readStructuredString(payload: Json | undefined, key: string): string | null {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const value = payload[key];
    return typeof value === "string" ? value : null;
  }
}
