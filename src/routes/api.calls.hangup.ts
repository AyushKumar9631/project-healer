import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { authenticateRequest, hangupCallById } from "@/lib/calls.server";

const InputSchema = z.object({ callId: z.string().uuid() });

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/calls/hangup")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let supabase;
        try {
          ({ supabase } = await authenticateRequest(request));
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
          const result = await hangupCallById({ supabase, callId: parsed.data.callId });
          return json(result, 200);
        } catch (e) {
          if (e instanceof Response) return e;
          const msg = e instanceof Error ? e.message : String(e);
          return json({ error: msg }, 500);
        }
      },
    },
  },
});
