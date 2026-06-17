import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { TablesUpdate } from "@/integrations/supabase/types";
import { evictCallContext, runInboundPostCallExtraction } from "./api.public.agent.turn";
import { mirrorOutcomeFromCall } from "@/lib/playbooks/_mirror";
import { runCallPostprocess } from "@/lib/call-postprocess.server";
import type { TranscriptTurn } from "@/lib/extractSymptoms";

// Bridge -> Lovable: signals that the Twilio media stream closed.
// Auth: shared secret in `x-bridge-secret`.
//
// Decision tree (only when current status is still live):
//   - !answered                 → declined (patient hung up before greeting)
//   - answered && !had_patient_turn      → completed, note "hung up after greeting"
//   - answered && had_patient_turn       → completed (mid-call hangup or normal end)
//   - reason=agent_end_call              → completed (agent ended on its own)
// Never overwrites an already-terminal state.
//
// ROOT CAUSE OF "condition_mentioned not populated on caller hangup":
// runInboundPostCallExtraction (in api.public.agent.turn.ts) — which writes
// condition_mentioned, topic, suggested_doctor_id, appointment_time, and
// fires the WhatsApp notifications — is ONLY invoked from inside agent/turn
// when the AGENT sets end_call=true. When the CALLER hangs up instead, the
// agent never gets a final turn with end_call=true, so that function never
// runs, no matter what bridge/end or plivo/status do to the `calls.status`
// column. Fix: explicitly invoke it here for inbound calls whose outcome
// doesn't yet have post_call_extracted=true, using whatever transcript/intent
// is already on the row. Guarded so it never double-runs against the
// agent-driven path.
//
// Separately, lib/call-postprocess.server.ts (transcript/intent reconciliation
// + AI call summary) is also triggered here AND from api.public.plivo.status.ts,
// since that route can terminalize the call before this one fires.

const Input = z.object({
  callId: z.string().uuid(),
  reason: z
    .enum(["stream_closed", "agent_end_call", "watchdog", "silence_timeout"])
    .optional()
    .default("stream_closed"),
  answered: z.boolean().optional().default(false),
  had_patient_turn: z.boolean().optional().default(false),
  // Bridge-tracked stream duration in seconds (from `start` event to socket
  // close). Reliable even when Twilio's `started_at` webhook arrived late
  // or out of order.
  duration_seconds: z.number().int().nonnegative().max(7200).optional(),
});

const LIVE_STATES = ["starting", "dialing", "ringing", "in_progress"];

// Runs the SAME extraction the agent-driven end_call=true path runs
// (condition_mentioned, topic, suggested_doctor_id, appointment_time,
// WhatsApp notifications), for inbound calls that ended WITHOUT the agent
// ever setting end_call=true — i.e. the caller hung up. No-ops for
// outbound calls and no-ops if extraction already ran (idempotency via
// outcome.post_call_extracted, the same flag the agent-driven path sets).
async function runCallerHangupExtractionIfNeeded(callId: string): Promise<void> {
  try {
    const { data: call, error } = await supabaseAdmin
      .from("calls")
      .select("clinic_id,patient_id,direction,transcript,intent,outcome")
      .eq("id", callId)
      .maybeSingle();
    if (error || !call) return;
    if (call.direction !== "inbound") return;

    const outcome =
      typeof call.outcome === "object" && call.outcome !== null && !Array.isArray(call.outcome)
        ? (call.outcome as Record<string, unknown>)
        : {};
    if (outcome.post_call_extracted === true) {
      console.log(`[bridge/end] extraction already ran (agent-driven) callId=${callId}, skipping`);
      return;
    }

    const transcript = Array.isArray(call.transcript)
      ? (call.transcript as unknown as TranscriptTurn[])
      : [];
    if (transcript.length === 0) {
      console.log(`[bridge/end] no transcript to extract from callId=${callId}, skipping`);
      return;
    }

    console.log(`[bridge/end] caller-hangup detected, running post-call extraction callId=${callId}`);
    await runInboundPostCallExtraction({
      supabase: supabaseAdmin,
      callId,
      clinicId: call.clinic_id,
      patientId: call.patient_id,
      transcript: transcript.map((t) => ({
        role: t.role === "patient" ? ("caller" as const) : ("agent" as const),
        text: t.text,
      })),
      callerIntent: call.intent ?? null,
      clinicKB: null,
    });
  } catch (e) {
    console.error(
      `[bridge/end] caller-hangup extraction failed (non-fatal) callId=${callId}: ${e instanceof Error ? e.message : e}`,
    );
  }
}

export const Route = createFileRoute("/api/public/bridge/end")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.BRIDGE_SHARED_SECRET;
        if (!expected) {
          return Response.json({ error: "BRIDGE_SHARED_SECRET not configured" }, { status: 500 });
        }
        const provided = request.headers.get("x-bridge-secret");
        if (!provided || provided !== expected) {
          return new Response("unauthorized", { status: 401 });
        }

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "bad json" }, { status: 400 });
        }
        const parsed = Input.safeParse(body);
        if (!parsed.success) {
          return Response.json(
            { error: "invalid input", issues: parsed.error.flatten() },
            { status: 400 },
          );
        }

        const {
          callId,
          reason,
          answered,
          had_patient_turn,
          duration_seconds: bridgeDuration,
        } = parsed.data;
        console.log(
          `[bridge/end] hit callId=${callId} reason=${reason} answered=${answered} hadPatientTurn=${had_patient_turn} bridgeDuration=${bridgeDuration ?? "n/a"}`,
        );

        // Free per-call agent KB cache (idempotent if not present).
        evictCallContext(callId);

        const { data: call, error: lookupErr } = await supabaseAdmin
          .from("calls")
          .select("id,clinic_id,status,started_at")
          .eq("id", callId)
          .maybeSingle();
        if (lookupErr || !call) {
          console.error(`[bridge/end] lookup failed: ${lookupErr?.message ?? "not found"}`);
          return Response.json({ ok: false, reason: "call not found" }, { status: 404 });
        }

        try {
          await supabaseAdmin.from("call_events").insert({
            call_id: callId,
            clinic_id: call.clinic_id,
            event_type: "bridge_stream_closed",
            payload: { reason, answered, had_patient_turn, prior_status: call.status },
          });
        } catch (e) {
          console.error(
            "[bridge/end] call_events insert failed:",
            e instanceof Error ? e.message : e,
          );
        }

        if (!LIVE_STATES.includes(call.status)) {
          console.log(`[bridge/end] call already terminal status=${call.status}, no overwrite`);
          await runCallPostprocess(supabaseAdmin, callId, call.clinic_id);
          await runCallerHangupExtractionIfNeeded(callId);
          return Response.json({ ok: true, updated: false, status: call.status });
        }

        // Decide final status.
        let finalStatus = "completed";
        let note = "";
        if (reason === "agent_end_call") {
          finalStatus = "completed";
          note = "agent ended call";
        } else if (!answered) {
          finalStatus = "declined";
          note = "patient hung up before greeting finished";
        } else if (!had_patient_turn) {
          finalStatus = "completed";
          note = "patient hung up after greeting, no reply";
        } else {
          finalStatus = "completed";
          if (reason === "watchdog") note = "watchdog: 3-min limit";
          else if (reason === "silence_timeout") note = "hung up after 3 silence nudges";
          else note = "patient hung up mid-call";
        }

        const nowIso = new Date().toISOString();
        const update: TablesUpdate<"calls"> = {
          status: finalStatus,
          ended_at: nowIso,
          notes: `bridge: ${note}`,
        };

        // Duration: prefer the bridge-tracked value (always available, accurate
        // to the media stream), fall back to (now - started_at). If we have a
        // duration but no started_at, backfill started_at retroactively.
        let dur = 0;
        if (typeof bridgeDuration === "number" && bridgeDuration > 0) {
          dur = bridgeDuration;
        } else if (call.started_at) {
          dur = Math.max(0, Math.round((Date.now() - new Date(call.started_at).getTime()) / 1000));
        }
        if (dur > 0) {
          update.duration_seconds = dur;
          if (!call.started_at) {
            update.started_at = new Date(Date.now() - dur * 1000).toISOString();
          }
        }

        const { error: updErr } = await supabaseAdmin.from("calls").update(update).eq("id", callId);
        if (updErr) {
          console.error("[bridge/end] update failed:", updErr.message);
          return Response.json({ ok: false, error: updErr.message }, { status: 500 });
        }
        console.log(`[bridge/end] marked ${finalStatus} callId=${callId}`);

        // Mirror final state into call_outcomes for the Outcomes dashboard.
        await mirrorOutcomeFromCall(supabaseAdmin, callId);

        // ---- TRIGGER SHARED POST-PROCESSING ----
        // (transcript/intent/condition_mentioned reconciliation + AI call summary)
        await runCallPostprocess(supabaseAdmin, callId, call.clinic_id);

        // ---- THE ACTUAL FIX: run inbound post-call extraction for caller hangup ----
        // reason !== "agent_end_call" means the agent never set end_call=true,
        // so the extraction call sites inside api.public.agent.turn.ts never fired.
        if (reason !== "agent_end_call") {
          await runCallerHangupExtractionIfNeeded(callId);
        }

        return Response.json({ ok: true, updated: true, status: finalStatus });
      },
    },
  },
});
