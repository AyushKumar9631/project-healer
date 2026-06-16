import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { TablesUpdate } from "@/integrations/supabase/types";
import { evictCallContext } from "./api.public.agent.turn";
import { extractFromTranscript, type TranscriptTurn } from "@/lib/extractSymptoms";
import { mirrorOutcomeFromCall } from "@/lib/playbooks/_mirror";

// Bridge -> Lovable: signals that the Twilio media stream closed.
// Auth: shared secret in `x-bridge-secret`.
//
// Decision tree (only when current status is still live):
//   - !answered                 → declined (patient hung up before greeting)
//   - answered && !had_patient_turn      → completed, note "hung up after greeting"
//   - answered && had_patient_turn       → completed (mid-call hangup or normal end)
//   - reason=agent_end_call              → completed (agent ended on its own)
// Never overwrites an already-terminal state.

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

        // ---- Reconciliation pass ----
        // Rebuild the canonical transcript from `call_events` (the authoritative
        // log) and prefer the most recent agent_turn's intent. This makes the
        // call detail self-healing: a single dropped mid-call write to the
        // `calls` row is recovered here, not lost forever.
        const reconcile: TablesUpdate<"calls"> = {};
        const fixedFields: string[] = [];
        try {
          const [{ data: rowData }, { data: events }] = await Promise.all([
            supabaseAdmin
              .from("calls")
              .select("transcript,intent,condition_mentioned")
              .eq("id", callId)
              .maybeSingle(),
            supabaseAdmin
              .from("call_events")
              .select("event_type,payload,created_at")
              .eq("call_id", callId)
              .in("event_type", ["agent_turn", "calls_update_failed"])
              .order("created_at", { ascending: true }),
          ]);

          const rowTranscript = Array.isArray(rowData?.transcript)
            ? (rowData!.transcript as unknown as TranscriptTurn[])
            : [];

          // Build the transcript implied by the events.
          const turnEvents = (events ?? []).filter((e) => e.event_type === "agent_turn");
          const eventTranscript: TranscriptTurn[] = [];
          for (const ev of turnEvents) {
            const p = (ev.payload ?? {}) as {
              utterance?: string;
              agent_reply?: string;
              isFirstTurn?: boolean;
            };
            if (!p.isFirstTurn && typeof p.utterance === "string" && p.utterance.trim()) {
              eventTranscript.push({ role: "patient", text: p.utterance });
            }
            if (typeof p.agent_reply === "string" && p.agent_reply.trim()) {
              eventTranscript.push({ role: "agent", text: p.agent_reply });
            }
          }

          // Always prefer the event-reconstructed transcript as it is the 
          // authoritative log from call_events.
          if (eventTranscript.length > 0) {
            reconcile.transcript = eventTranscript;
            fixedFields.push(`transcript_rebuilt[len=${eventTranscript.length}]`);
          }

          // Prefer latest event intent if it differs from the row.
          const latestTurn = turnEvents[turnEvents.length - 1];
          const latestIntent =
            latestTurn && (latestTurn.payload as { intent?: string } | null)?.intent;
          if (latestIntent && latestIntent !== rowData?.intent) {
            reconcile.intent = latestIntent;
            fixedFields.push(`intent ${rowData?.intent ?? "—"}→${latestIntent}`);
          }

          // Re-extract symptoms from the (possibly rebuilt) transcript and
          // backfill condition_mentioned only when blank.
          if (!rowData?.condition_mentioned) {
            const t = (reconcile.transcript as TranscriptTurn[] | undefined) ?? rowTranscript;
            const { symptoms } = extractFromTranscript(t);
            if (symptoms.length > 0) {
              reconcile.condition_mentioned = symptoms.join(", ");
              fixedFields.push(`condition_mentioned=${reconcile.condition_mentioned}`);
            }
          }
        } catch (e) {
          console.error("[bridge/end] reconcile failed:", e instanceof Error ? e.message : e);
        }

        const nowIso = new Date().toISOString();
        const update: TablesUpdate<"calls"> = {
          ...reconcile,
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
        console.log(
          `[bridge/end] marked ${finalStatus} callId=${callId} reconciled=[${fixedFields.join("; ")}]`,
        );
        if (fixedFields.length > 0) {
          try {
            await supabaseAdmin.from("call_events").insert({
              call_id: callId,
              clinic_id: call.clinic_id,
              event_type: "bridge_end_reconciled",
              payload: { fixed: fixedFields } as never,
            });
          } catch (e) {
            console.error(
              "[bridge/end] reconciled event log failed:",
              e instanceof Error ? e.message : e,
            );
          }
        }

        // Mirror final state into call_outcomes for the Outcomes dashboard.
        await mirrorOutcomeFromCall(supabaseAdmin, callId);

        // Extract and enforce the Array type to satisfy TypeScript
        const rawTranscript = update.transcript ?? reconcile.transcript;
        const definitiveTranscript = Array.isArray(rawTranscript) ? (rawTranscript as any[]) : [];

        // ---- TRIGGER PER-CALL SUMMARIZER ----
        await generatePerCallSummary(supabaseAdmin, callId, definitiveTranscript);

        return Response.json({ ok: true, updated: true, status: finalStatus });
      },
    },
  },
});

// Add this helper function at the bottom of api.public.bridge.end.ts

async function generatePerCallSummary(
  supabaseClient: any,
  callId: string | null | undefined,
  transcriptArray: any[] | null | undefined,
) {
  console.log(`[Memory] 🟢 Triggered per-call summary engine for callId: ${callId}`);

  try {
    if (!callId) {
      console.log(`[Memory] 🟡 Skipping: No valid callId provided.`);
      return;
    }

    if (!transcriptArray || transcriptArray.length === 0) {
      console.log(`[Memory] 🟡 Skipping: Dialogue transcript array is completely empty.`);
      return;
    }

    // 1. Format the Transcript
    const transcriptText = transcriptArray
      .map((t: any) => `${t.role === "agent" ? "Agent" : "Patient"}: ${t.text}`)
      .join("\n");

    // 2. New System Prompt (No old memory fetched, focusing only on THIS call)
    const systemPrompt = `You are an expert clinical summarizer. 
Your job is to write a concise summary of this specific phone call between an AI reception agent and a patient.

CALL TRANSCRIPT:
${transcriptText}

INSTRUCTIONS:
1. Summarize the patient's main issue, the AI's response, and the final outcome (e.g., appointment booked, transferred, declined).
2. STRICT LENGTH LIMIT: You must output exactly 2 or 3 short sentences. Maximum 40 words.
3. Focus ONLY on actionable clinical or administrative context. Write in English.

Output your response in valid JSON format:
{
  "call_summary": "string"
}`;

    // 3. Call the LLM
    console.log(`[Memory] Requesting call summary from direct Gemini API...`);
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error(`[Memory] ❌ GEMINI_API_KEY is missing from environment variables!`);
      return;
    }

    const model = "gemini-2.5-flash-lite";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `Transcript:\n${transcriptText}` }] }],
        system_instruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0,
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Memory] ❌ Gemini API Error ${res.status}:`, errText);
      return;
    }

    const json = await res.json() as any;
    const jsonStr = json.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = JSON.parse(jsonStr);

    if (parsed.call_summary) {
      console.log(`[Memory] Committing per-call summary to storage: "${parsed.call_summary}"`);

      // 4. Save directly to the CALLS table using the callId
      const { error: updateError } = await supabaseClient
        .from("calls")
        .update({
          agent_summary: parsed.call_summary,
        })
        .eq("id", callId);

      if (updateError) {
        console.error(
          `[Memory] ❌ Failed to commit summary updates to calls table:`,
          updateError.message,
        );
      } else {
        console.log(`[Memory] ✅ Successfully saved summary for call ${callId}`);
      }
    } else {
      console.error(`[Memory] ❌ LLM failed to structure a valid call_summary attribute`);
    }
  } catch (error) {
    console.error(`[Memory] ❌ Fatal crash inside execution thread:`, error);
  }
}
