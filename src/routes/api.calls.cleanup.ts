import { createFileRoute } from "@tanstack/react-router";
import { authenticateRequest } from "@/lib/calls.server";

// Marks any of the caller's recent calls stuck in non-terminal states
// (starting | dialing | ringing) older than 5 minutes as "failed".
// Used by the dashboard to clean up rows when Twilio's status webhook
// never delivered a terminal event.
export const Route = createFileRoute("/api/calls/cleanup")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let supabase;
        try {
          ({ supabase } = await authenticateRequest(request));
        } catch (e) {
          if (e instanceof Response) return e;
          return Response.json({ error: String(e) }, { status: 500 });
        }

        // Stale dialing/ringing calls almost always mean the patient never
        // picked up — mark as no_answer (not failed).
        const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const { data, error } = await supabase
          .from("calls")
          .update({
            status: "no_answer",
            notes: "auto-cleanup: ring timeout, no answer received",
            ended_at: new Date().toISOString(),
          })
          .in("status", ["starting", "dialing", "ringing"])
          .lt("created_at", cutoff)
          .select("id");

        if (error) return Response.json({ error: error.message }, { status: 500 });
        return Response.json({ ok: true, cleaned: data?.length ?? 0 });
      },
    },
  },
});
