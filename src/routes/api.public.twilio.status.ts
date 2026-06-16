import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { TablesUpdate } from "@/integrations/supabase/types";
import { mirrorOutcomeFromCall } from "@/lib/playbooks/_mirror";

// Twilio call lifecycle webhook. Maps Twilio status → our DB status and timestamps.
// Uses AnsweredBy (from MachineDetection) to distinguish:
//   - voicemail (machine_*)
//   - declined (human picked up but hung up almost instantly, < 6s, before bridge marked answered)
//   - completed (normal)
// Never downgrades a terminal state; logs every event into call_events for visibility.

const TERMINAL_STATES = new Set([
  "completed",
  "busy",
  "no_answer",
  "failed",
  "voicemail",
  "declined",
]);
const STATUS_RANK: Record<string, number> = {
  starting: 0,
  dialing: 1,
  queued: 1,
  initiated: 1,
  ringing: 2,
  in_progress: 3,
  completed: 4,
  busy: 4,
  no_answer: 4,
  failed: 4,
  voicemail: 4,
  declined: 4,
};

export const Route = createFileRoute("/api/public/twilio/status")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const callId = url.searchParams.get("callId");

        let form: FormData;
        try {
          form = await request.formData();
        } catch (e) {
          console.error("[twilio/status] formData parse failed:", e instanceof Error ? e.message : e);
          return new Response("ok", { status: 200 });
        }

        const callStatus = String(form.get("CallStatus") ?? "").toLowerCase();
        const callDuration = Number(form.get("CallDuration") ?? 0);
        const sid = String(form.get("CallSid") ?? "");
        const errorCode = form.get("ErrorCode");
        const answeredByRaw = form.get("AnsweredBy");
        const answeredBy = answeredByRaw ? String(answeredByRaw).toLowerCase() : "";

        console.log("[twilio/status] hit", { callId, callStatus, sid, callDuration, errorCode, answeredBy });
        if (!callId) return new Response("missing callId", { status: 200 });

        const baseMap: Record<string, string> = {
          queued: "dialing",
          initiated: "dialing",
          ringing: "ringing",
          "in-progress": "in_progress",
          answered: "in_progress",
          completed: "completed",
          busy: "busy",
          "no-answer": "no_answer",
          failed: "failed",
          canceled: "no_answer",
        };
        let mapped = baseMap[callStatus] ?? callStatus;

        // Voicemail / answering machine — overrides both in_progress and completed.
        const isMachine = answeredBy.startsWith("machine_") || answeredBy === "fax";
        if (isMachine && (mapped === "in_progress" || mapped === "completed")) {
          mapped = "voicemail";
        }

        try {
          const { data: existing } = await supabaseAdmin
            .from("calls")
            .select("id,clinic_id,status,started_at")
            .eq("id", callId)
            .maybeSingle();

          if (!existing) {
            console.warn(`[twilio/status] call ${callId} not found`);
            return new Response("ok", { status: 200 });
          }

          // Declined: human picked up then hung up almost instantly, and the
          // bridge never advanced the call past ringing/dialing (i.e. no
          // greeting playback completed). Detect on the final 'completed' event.
          if (
            mapped === "completed" &&
            (answeredBy === "human" || answeredBy === "unknown" || !answeredBy) &&
            callDuration > 0 &&
            callDuration < 6 &&
            (existing.status === "ringing" || existing.status === "dialing" || existing.status === "starting")
          ) {
            mapped = "declined";
          }

          // Always log the raw event for audit/debug.
          try {
            await supabaseAdmin.from("call_events").insert({
              call_id: callId,
              clinic_id: existing.clinic_id,
              event_type: `twilio_status_${callStatus || "unknown"}`,
              payload: {
                CallStatus: callStatus,
                CallDuration: callDuration,
                CallSid: sid,
                ErrorCode: errorCode ? String(errorCode) : null,
                AnsweredBy: answeredBy || null,
                MappedStatus: mapped,
              },
            });
          } catch (e) {
            console.error("[twilio/status] call_events insert failed:", e instanceof Error ? e.message : e);
          }

          // If row is already terminal, we still want to backfill missing
          // duration_seconds from Twilio's authoritative CallDuration. Don't
          // change status though.
          if (TERMINAL_STATES.has(existing.status)) {
            if (
              callDuration > 0 &&
              callStatus === "completed" &&
              (existing as { duration_seconds?: number | null }).duration_seconds == null
            ) {
              await supabaseAdmin
                .from("calls")
                .update({ duration_seconds: callDuration })
                .eq("id", callId);
              console.log(
                `[twilio/status] backfilled duration=${callDuration}s on terminal call ${callId}`,
              );
            } else {
              console.log(
                `[twilio/status] ignoring ${mapped} for already-terminal ${existing.status}`,
              );
            }
            // Re-mirror to guarantee an outcome row even if bridge.end's
            // parallel mirror call lost the race or errored. Idempotent.
            await mirrorOutcomeFromCall(supabaseAdmin, callId);
            return new Response("ok", { status: 200 });
          }
          const currentRank = STATUS_RANK[existing.status] ?? 0;
          const newRank = STATUS_RANK[mapped] ?? 0;
          if (newRank < currentRank && !TERMINAL_STATES.has(mapped)) {
            console.log(`[twilio/status] ignoring lower-rank ${mapped} (current=${existing.status})`);
            return new Response("ok", { status: 200 });
          }

          const update: TablesUpdate<"calls"> = { status: mapped };
          if (sid) update.twilio_call_sid = sid;
          if (
            (callStatus === "in-progress" || callStatus === "answered") &&
            !existing.started_at &&
            !isMachine
          ) {
            update.started_at = new Date().toISOString();
          }
          if (TERMINAL_STATES.has(mapped)) {
            update.ended_at = new Date().toISOString();
            if (callDuration > 0) update.duration_seconds = callDuration;
            if (mapped === "voicemail") {
              update.notes = "voicemail / answering machine detected";
            } else if (mapped === "declined") {
              update.notes = "patient hung up before greeting";
            } else if (mapped === "no_answer" && callStatus === "canceled") {
              update.notes = "ring timeout — no answer";
            }
          }

          await supabaseAdmin.from("calls").update(update).eq("id", callId);
          console.log(`[twilio/status] update ok callId=${callId} ${existing.status} -> ${mapped}`);
          if (TERMINAL_STATES.has(mapped)) {
            await mirrorOutcomeFromCall(supabaseAdmin, callId);
          }
        } catch (e) {
          console.error("[twilio/status] handler failed:", e instanceof Error ? e.message : e);
        }
        return new Response("ok", { status: 200 });
      },
    },
  },
});
