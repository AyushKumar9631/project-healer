// Plivo Hangup URL. Plivo posts call lifecycle info here (form-encoded) when
// the call ends. Mirrors Twilio's status route — maps Plivo
// `CallStatus` + `HangupCause` + `HangupSource` + `Duration` to our internal
// status set, never downgrades terminal, and writes a descriptive `notes`.
//
// Scenario table (kept in sync with .lovable/plan.md):
//
//   Scenario                                  CallStatus   HangupCause                                   HangupSource    Dur   -> internal     notes
//   Rang full timeout, no pickup              no-answer    Ring Timeout Reached / NORMAL_CLEARING        Plivo           0     no_answer      "ring timeout — no answer"
//   Patient rejected during ring              no-answer    Rejected / Call Rejected / CALL_REJECTED      Callee          0     no_answer      "patient rejected during ring"
//   Line busy                                 busy         Busy Line / User Busy                         Carrier         0     busy           "line busy"
//   Invalid / unallocated number              failed       Invalid Number / Unallocated Number / NoRoute Carrier         0     failed         "invalid number"
//   Carrier / network congestion              failed       Switch Congestion / Network Out Of Order      Carrier         0     failed         "carrier congestion"
//   Cancelled before answer (our cleanup)     cancel       Cancelled                                     API / Caller    0     no_answer      "cancelled before answer"
//   Picked up, hung up <6s, never past ring   completed    Normal Hangup                                 Callee          1-5   declined       "patient hung up before greeting"
//   Picked up, full conversation              completed    Normal Hangup                                 any             >=6   completed
//   Voicemail (AMD path)                      handled in /api/public/plivo/amd
//   Voicemail caught via cause (rare)         completed    Machine Detected                              Plivo           any   voicemail      "voicemail detected via HangupCause"
//   Watchdog 3-min cap                        completed    Normal Hangup                                 Caller          ~180  completed      bridge already adds note
import { createFileRoute } from "@tanstack/react-router";
import { mirrorOutcomeFromCall } from "@/lib/playbooks/_mirror";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { fetchAndStorePlivoRecording } from "@/lib/plivo-recording.server";
import type { TablesUpdate } from "@/integrations/supabase/types";

const TERMINAL_STATES = new Set([
  "completed", "busy", "no_answer", "failed", "voicemail", "declined",
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

function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s_\-./]+/g, "");
}

type Mapped = { mapped: string; notes?: string };

function mapPlivoFinalStatus(args: {
  callStatus: string;
  hangupCause: string;
  hangupSource: string;
  duration: number;
  existingStatus: string;
}): Mapped {
  const cs = args.callStatus;
  const cause = normalize(args.hangupCause);
  const src = normalize(args.hangupSource);
  const dur = args.duration;

  // Voicemail caught via cause string (AMD callback usually handles this earlier)
  if (cause.includes("machinedetected") || cause.includes("voicemail")) {
    return { mapped: "voicemail", notes: "voicemail detected via HangupCause" };
  }

  // Busy
  if (cs === "busy" || cause.includes("busy")) {
    return { mapped: "busy", notes: "line busy" };
  }

  // Invalid / unroutable number
  if (
    cause.includes("invalidnumber") ||
    cause.includes("unallocatednumber") ||
    cause.includes("noroutetodestination") ||
    cause.includes("unassignednumber") ||
    cause.includes("numberchanged")
  ) {
    return { mapped: "failed", notes: "invalid number" };
  }

  // Carrier / network congestion
  if (
    cause.includes("congestion") ||
    cause.includes("networkoutoforder") ||
    cause.includes("temporaryfailure") ||
    cause.includes("normaltemporaryfailure") ||
    cause.includes("serviceunavailable")
  ) {
    return { mapped: "failed", notes: "carrier congestion" };
  }

  // Patient explicitly rejected during ring
  if (
    cs === "no-answer" &&
    (cause.includes("rejected") || cause.includes("callrejected")) &&
    src === "callee"
  ) {
    return { mapped: "no_answer", notes: "patient rejected during ring" };
  }

  // Ring timed out
  if (cs === "no-answer" || cs === "timeout" || cause.includes("ringtimeoutreached")) {
    return { mapped: "no_answer", notes: "ring timeout — no answer" };
  }

  // We cancelled before answer (e.g. cleanup job)
  if (cs === "cancel" || cause === "cancelled" || cause === "canceled") {
    return { mapped: "no_answer", notes: "cancelled before answer" };
  }

  // Generic failure with no cause we recognise
  if (cs === "failed") {
    return {
      mapped: "failed",
      notes: args.hangupCause ? `failed: ${args.hangupCause}` : "call failed",
    };
  }

  // Completed — disambiguate "patient hung up before greeting"
  if (cs === "completed") {
    const earlyHangup =
      dur > 0 &&
      dur < 6 &&
      (src === "callee" || src === "" /* unknown source, still very short */) &&
      ["ringing", "dialing", "starting"].includes(args.existingStatus);
    if (earlyHangup) {
      return { mapped: "declined", notes: "patient hung up before greeting" };
    }
    return { mapped: "completed" };
  }

  // Fallback: trust raw CallStatus
  return { mapped: cs || "completed" };
}

export const Route = createFileRoute("/api/public/plivo/status")({
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

        const callStatus = String(form.get("CallStatus") ?? "").toLowerCase();
        const hangupCause = String(form.get("HangupCause") ?? "");
        const hangupSource = String(form.get("HangupSource") ?? "");
        const callUuid = String(form.get("CallUUID") ?? "");
        const duration = Number(form.get("Duration") ?? form.get("BillDuration") ?? 0);

        console.log("[plivo/status] hit", {
          callId, callStatus, hangupCause, hangupSource, callUuid, duration,
        });
        if (!callId) return new Response("ok", { status: 200 });

        try {
          const { data: existing } = await supabaseAdmin
            .from("calls")
            .select("id,clinic_id,status,started_at,duration_seconds,notes")
            .eq("id", callId)
            .maybeSingle();
          if (!existing) {
            console.warn(`[plivo/status] call ${callId} not found`);
            return new Response("ok", { status: 200 });
          }

          const { mapped, notes } = mapPlivoFinalStatus({
            callStatus,
            hangupCause,
            hangupSource,
            duration,
            existingStatus: existing.status,
          });

          await supabaseAdmin.from("call_events").insert({
            call_id: callId,
            clinic_id: existing.clinic_id,
            event_type: `plivo_status_${callStatus || "unknown"}`,
            payload: {
              CallStatus: callStatus,
              HangupCause: hangupCause,
              HangupSource: hangupSource,
              CallUUID: callUuid,
              Duration: duration,
              MappedStatus: mapped,
              Notes: notes ?? null,
            },
          });

          // Already terminal — only backfill duration, never change status.
          // We still re-run the outcome mirror because bridge.end and this
          // webhook race; whichever commits the terminal status first, the
          // other one must still ensure call_outcomes has a row. The mirror
          // upserts on call_id, so this is idempotent.
          if (TERMINAL_STATES.has(existing.status)) {
            if (duration > 0 && existing.duration_seconds == null) {
              await supabaseAdmin.from("calls")
                .update({ duration_seconds: duration })
                .eq("id", callId);
            }
            await mirrorOutcomeFromCall(supabaseAdmin, callId);
            if (callUuid) {
              try {
                await fetchAndStorePlivoRecording({ callId, callUuid });
              } catch (e) {
                console.error("[plivo/status] recording fetch failed:", e instanceof Error ? e.message : e);
              }
            }
            return new Response("ok", { status: 200 });
          }

          // Don't downgrade rank-wise unless we're moving to a terminal state.
          const currentRank = STATUS_RANK[existing.status] ?? 0;
          const newRank = STATUS_RANK[mapped] ?? 0;
          if (newRank < currentRank && !TERMINAL_STATES.has(mapped)) {
            console.log(
              `[plivo/status] ignoring lower-rank ${mapped} (current=${existing.status})`,
            );
            return new Response("ok", { status: 200 });
          }

          const update: TablesUpdate<"calls"> = {
            status: mapped,
            ended_at: new Date().toISOString(),
          };
          if (callUuid) update.plivo_call_uuid = callUuid;
          if (duration > 0) update.duration_seconds = duration;
          if (notes) {
            // Preserve any prior bridge note (e.g. "watchdog: 3-min limit") by appending.
            update.notes = existing.notes ? `${existing.notes} | ${notes}` : notes;
          }

          await supabaseAdmin.from("calls").update(update).eq("id", callId);
          console.log(
            `[plivo/status] update ok callId=${callId} ${existing.status} -> ${mapped}${notes ? ` (${notes})` : ""}`,
          );
          if (TERMINAL_STATES.has(mapped)) {
            await mirrorOutcomeFromCall(supabaseAdmin, callId);
            if (callUuid) {
              try {
                await fetchAndStorePlivoRecording({ callId, callUuid });
              } catch (e) {
                console.error("[plivo/status] recording fetch failed:", e instanceof Error ? e.message : e);
              }
            }
          }
        } catch (e) {
          console.error("[plivo/status] handler failed:", e instanceof Error ? e.message : e);
        }
        return new Response("ok", { status: 200 });
      },
    },
  },
});
