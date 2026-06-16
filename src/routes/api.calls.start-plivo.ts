// Plivo-only call-start endpoint. Kept as a thin alias so the manual
// "Test via Plivo" button and diagnostics always exercise the Plivo path
// regardless of the CALL_PROVIDER feature flag. Real production traffic
// goes through /api/calls/start.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { authenticateRequest } from "@/lib/calls.server";
import { startPlivoCallForPatient } from "@/lib/plivo-call.server";

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

export const Route = createFileRoute("/api/calls/start-plivo")({
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

        try {
          const result = await startPlivoCallForPatient({
            request,
            supabase,
            patientId: parsed.data.patientId,
            campaignId: parsed.data.campaignId ?? null,
          });
          return json({ ok: true, provider: "plivo", ...result, userId }, 200);
        } catch (e) {
          if (e instanceof Response) return e;
          const msg = e instanceof Error ? e.message : String(e);
          return json({ error: msg, provider: "plivo" }, 500);
        }
      },
    },
  },
});
