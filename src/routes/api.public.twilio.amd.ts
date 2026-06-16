import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { twilioPost } from "@/lib/twilio";

// Async AMD callback. Twilio posts the answering-machine verdict here AFTER
// the call is already answered and the media stream is flowing. We act on
// machine_* / fax to flip the call to `voicemail` and hang up gracefully.
//
// Synchronous MachineDetection (the previous setup) would hold media for
// 3-8 seconds while AMD analysed the line — that was the entire root cause
// of the "नमस्ते" delay. AsyncAmd lets the prelude play immediately.

export const Route = createFileRoute("/api/public/twilio/amd")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const callId = url.searchParams.get("callId");

        let form: FormData;
        try {
          form = await request.formData();
        } catch (e) {
          console.error(
            "[twilio/amd] formData parse failed:",
            e instanceof Error ? e.message : e,
          );
          return new Response("ok", { status: 200 });
        }

        const answeredBy = String(form.get("AnsweredBy") ?? "").toLowerCase();
        const sid = String(form.get("CallSid") ?? "");
        console.log("[twilio/amd] hit", { callId, answeredBy, sid });

        if (!callId) return new Response("ok", { status: 200 });

        const isMachine = answeredBy.startsWith("machine_") || answeredBy === "fax";

        try {
          const { data: existing } = await supabaseAdmin
            .from("calls")
            .select("id,clinic_id,status,twilio_call_sid")
            .eq("id", callId)
            .maybeSingle();
          if (!existing) return new Response("ok", { status: 200 });

          await supabaseAdmin.from("call_events").insert({
            call_id: callId,
            clinic_id: existing.clinic_id,
            event_type: "twilio_amd_result",
            payload: { AnsweredBy: answeredBy, CallSid: sid, isMachine },
          });

          if (isMachine) {
            await supabaseAdmin
              .from("calls")
              .update({
                status: "voicemail",
                ended_at: new Date().toISOString(),
                notes: "voicemail / answering machine detected (async AMD)",
              })
              .eq("id", callId);
            const targetSid = sid || existing.twilio_call_sid;
            if (targetSid) {
              try {
                await twilioPost(`/Calls/${targetSid}.json`, {
                  Status: "completed",
                });
                console.log(`[twilio/amd] hung up voicemail sid=${targetSid}`);
              } catch (e) {
                console.error(
                  "[twilio/amd] hangup failed:",
                  e instanceof Error ? e.message : e,
                );
              }
            }
          }
        } catch (e) {
          console.error(
            "[twilio/amd] handler failed:",
            e instanceof Error ? e.message : e,
          );
        }

        return new Response("ok", { status: 200 });
      },
    },
  },
});
