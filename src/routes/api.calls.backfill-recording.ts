// Authenticated backfill: pull the Plivo session recording for an existing
// call row that's missing recording_url. Useful when the original
// `<Record callbackUrl>` never fired, or for any historical call.
import { createFileRoute } from "@tanstack/react-router";
import { authenticateRequest } from "@/lib/calls.server";
import { fetchAndStorePlivoRecording } from "@/lib/plivo-recording.server";

export const Route = createFileRoute("/api/calls/backfill-recording")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let supabase;
        try {
          ({ supabase } = await authenticateRequest(request));
        } catch (e) {
          if (e instanceof Response) return e;
          return new Response("auth failed", { status: 500 });
        }

        let body: { callId?: string };
        try {
          body = (await request.json()) as { callId?: string };
        } catch {
          return new Response("invalid json", { status: 400 });
        }
        const callId = body.callId?.trim();
        if (!callId) return new Response("missing callId", { status: 400 });

        // RLS-scoped lookup confirms the user owns this call.
        const { data: call, error } = await supabase
          .from("calls")
          .select("id,plivo_call_uuid,recording_url")
          .eq("id", callId)
          .maybeSingle();
        if (error) return new Response(error.message, { status: 500 });
        if (!call) return new Response("not found", { status: 404 });
        if (!call.plivo_call_uuid) {
          return new Response(
            JSON.stringify({ ok: false, reason: "no plivo_call_uuid on row" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }

        const result = await fetchAndStorePlivoRecording({
          callId,
          callUuid: call.plivo_call_uuid,
          force: true,
        });
        return new Response(JSON.stringify(result), {
          status: result.ok ? 200 : 502,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});
