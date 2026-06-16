// Plivo Record callbackUrl. Plivo POSTs here when the session recording is
// uploaded to its CDN (typically a few seconds after hangup). We persist
// the URL + metadata on the calls row and audit-log the raw payload.
//
// Plivo callback fields (see https://www.plivo.com/docs/voice/xml/record):
//   RecordUrl, RecordingID, RecordingDuration, RecordingDurationMs,
//   RecordingStartMs, RecordingEndMs
//
// The recording itself sits behind Basic auth on api.plivo.com; the browser
// streams it through /api/calls/recording which proxies with our credentials.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const Route = createFileRoute("/api/public/plivo/recording")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const callId = url.searchParams.get("callId");
        if (!callId) {
          console.warn("[plivo/recording] missing callId");
          return new Response("ok", { status: 200 });
        }

        let form: FormData;
        try {
          form = await request.formData();
        } catch (e) {
          console.error(
            `[plivo/recording] failed to parse form: ${e instanceof Error ? e.message : e}`,
          );
          return new Response("ok", { status: 200 });
        }

        const recordUrl = String(form.get("RecordUrl") ?? "").trim();
        const recordingId = String(form.get("RecordingID") ?? "").trim();
        const durationRaw = form.get("RecordingDuration");
        const duration = Number(durationRaw ?? 0);
        const durationMs = Number(form.get("RecordingDurationMs") ?? 0);
        const startMs = Number(form.get("RecordingStartMs") ?? 0);
        const endMs = Number(form.get("RecordingEndMs") ?? 0);

        console.log("[plivo/recording] hit", {
          callId, recordingId, duration, recordUrl: recordUrl ? "set" : "missing",
        });

        try {
          const { data: existing } = await supabaseAdmin
            .from("calls")
            .select("id,clinic_id")
            .eq("id", callId)
            .maybeSingle();
          if (!existing) {
            console.warn(`[plivo/recording] call ${callId} not found`);
            return new Response("ok", { status: 200 });
          }

          await supabaseAdmin
            .from("calls")
            .update({
              recording_url: recordUrl || null,
              recording_id: recordingId || null,
              recording_duration_seconds: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
              recording_ready_at: new Date().toISOString(),
            })
            .eq("id", callId);

          await supabaseAdmin.from("call_events").insert({
            call_id: callId,
            clinic_id: existing.clinic_id,
            event_type: "plivo_recording_ready",
            payload: {
              RecordUrl: recordUrl,
              RecordingID: recordingId,
              RecordingDuration: duration,
              RecordingDurationMs: durationMs,
              RecordingStartMs: startMs,
              RecordingEndMs: endMs,
            },
          });
        } catch (e) {
          console.error(
            "[plivo/recording] handler failed:",
            e instanceof Error ? e.message : e,
          );
        }

        return new Response("ok", { status: 200 });
      },
    },
  },
});
