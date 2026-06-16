// Plivo stream lifecycle callback. Plivo POSTs here when the AudioStream
// WebSocket is started, stopped, or fails to start. We log every event into
// `call_events` so silent failures (e.g. WS handshake rejected by edge) are
// visible in the database without grepping Railway logs.
//
// Plivo sends: CallUUID, StreamID, Event ("started" | "stopped" | "failed"),
//              StatusReason, From, To, Direction, Timestamp, Duration.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const Route = createFileRoute("/api/public/plivo/stream-status")({
  server: {
    handlers: {
      POST: async ({ request }) => handle(request),
      GET: async ({ request }) => handle(request),
    },
  },
});

async function handle(request: Request) {
  const url = new URL(request.url);
  const callId = url.searchParams.get("callId");

  let payload: Record<string, string> = {};
  try {
    if (request.headers.get("content-type")?.includes("application/json")) {
      payload = (await request.json()) as Record<string, string>;
    } else {
      const fd = await request.formData();
      for (const [k, v] of fd.entries()) payload[k] = String(v);
    }
  } catch {
    // body is optional in some edge cases
  }

  const event = String(payload.Event ?? "").toLowerCase() || "unknown";
  console.log(
    `[plivo/stream-status] callId=${callId} event=${event} reason=${payload.StatusReason ?? ""} streamId=${payload.StreamID ?? ""}`,
  );

  if (callId) {
    try {
      const { data: call } = await supabaseAdmin
        .from("calls")
        .select("clinic_id")
        .eq("id", callId)
        .maybeSingle();
      if (call) {
        await supabaseAdmin.from("call_events").insert({
          call_id: callId,
          clinic_id: call.clinic_id,
          event_type: `plivo_stream_${event}`,
          payload,
        });
      }
    } catch (e) {
      console.error(
        "[plivo/stream-status] db insert failed:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  return new Response("ok", { status: 200 });
}
