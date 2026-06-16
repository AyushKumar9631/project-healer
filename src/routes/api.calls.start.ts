// Unified call-start endpoint. Dispatches to Twilio or Plivo based on
// the CALL_PROVIDER env var (defaults to "twilio" to preserve current
// production behavior). Flip CALL_PROVIDER=plivo in runtime secrets to
// route all "Call patient now" + campaign calls through Plivo without
// any code change. Now with Patient Context Memory injection.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { authenticateRequest, startCallForPatient } from "@/lib/calls.server";
import { startPlivoCallForPatient } from "@/lib/plivo-call.server";
import { fetchPatientCallHistoryContext } from "@/lib/call-memory.server";

const InputSchema = z.object({
  patientId: z.string().uuid(),
  campaignId: z.string().uuid().nullable().optional(),
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function resolveProvider(): "twilio" | "plivo" {
  const raw = (process.env.CALL_PROVIDER ?? "twilio").trim().toLowerCase();
  return raw === "plivo" ? "plivo" : "twilio";
}

export const Route = createFileRoute("/api/calls/start")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let supabase, userId;
        try {
          ({ supabase, userId } = await authenticateRequest(request));
        } catch (e) {
          if (e instanceof Response) return e;
          return json({ error: String(e) }, 500);
        }

        let payload: unknown;
        try {
          payload = await request.json();
        } catch {
          return json({ error: "Invalid JSON body" }, 400);
        }

        const parsed = InputSchema.safeParse(payload);
        if (!parsed.success) {
          return json({ error: "Invalid input", issues: parsed.error.issues }, 400);
        }

        const provider = resolveProvider();
        const patientId = parsed.data.patientId;
        console.log(`[calls.start] provider=${provider} patient=${patientId}`);

        // Fetch chronological historical summaries compiled from past calls instead of an unstable profile column
        let memoryContext: string | null = null;
        try {
          memoryContext = await fetchPatientCallHistoryContext({ patientId, supabase });
          if (memoryContext) {
            console.log(`[calls.start] Successfully fetched compiled memory timeline for patient ${patientId}`);
          } else {
            console.log(`[calls.start] No historical call timeline summaries found for patient ${patientId}`);
          }
        } catch (err) {
          console.error(`[calls.start Warning] Failed to query patient chronological timeline:`, err);
        }

        try {
          if (provider === "plivo") {
            const result = await startPlivoCallForPatient({
              request,
              supabase,
              patientId: patientId,
              campaignId: parsed.data.campaignId ?? null,
              memoryContext, // Injected down the telephony bridge runtime stack
            } as any);
            return json({ ok: true, provider, ...result, userId }, 200);
          }
          const result = await startCallForPatient({
            request,
            supabase,
            patientId: patientId,
            campaignId: parsed.data.campaignId ?? null,
            memoryContext, // Injected down the telephony bridge runtime stack
          } as any);
          return json({ ok: true, provider, ...result, userId }, 200);
        } catch (e) {
          if (e instanceof Response) return e;
          const msg = e instanceof Error ? e.message : String(e);
          return json({ error: msg, provider }, 500);
        }
      },
    },
  },
});