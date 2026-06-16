// Plivo machine_detection_url callback. Plivo posts the MD verdict
// asynchronously (after the call connects). When it's a machine, we mark
// the call as voicemail and hang it up via REST.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { plivoHangup } from "@/lib/plivo";

export const Route = createFileRoute("/api/public/plivo/amd")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const callId = url.searchParams.get("callId");

        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return new Response("ok", { status: 200 });
        }

        // Plivo posts MachineDetection: "human" | "machine" | "unknown"
        const md = String(form.get("MachineDetection") ?? form.get("Machine") ?? "").toLowerCase();
        const callUuid = String(form.get("CallUUID") ?? "");
        console.log("[plivo/amd] hit", { callId, md, callUuid });

        if (!callId) return new Response("ok", { status: 200 });
        const isMachine = md === "machine";

        try {
          const { data: existing } = await supabaseAdmin
            .from("calls")
            .select("id,clinic_id,plivo_call_uuid")
            .eq("id", callId)
            .maybeSingle();
          if (!existing) return new Response("ok", { status: 200 });

          await supabaseAdmin.from("call_events").insert({
            call_id: callId,
            clinic_id: existing.clinic_id,
            event_type: "plivo_amd_result",
            payload: { MachineDetection: md, CallUUID: callUuid, isMachine },
          });

          if (isMachine) {
            await supabaseAdmin
              .from("calls")
              .update({
                status: "voicemail",
                ended_at: new Date().toISOString(),
                notes: "voicemail / answering machine detected (Plivo AMD)",
                plivo_call_uuid: callUuid || existing.plivo_call_uuid,
              })
              .eq("id", callId);
            const target = callUuid || existing.plivo_call_uuid;
            if (target) {
              try { await plivoHangup(target); }
              catch (e) { console.error("[plivo/amd] hangup failed:", e instanceof Error ? e.message : e); }
            }
          }
        } catch (e) {
          console.error("[plivo/amd] handler failed:", e instanceof Error ? e.message : e);
        }
        return new Response("ok", { status: 200 });
      },
    },
  },
});
