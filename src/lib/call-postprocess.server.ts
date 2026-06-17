// Shared call-termination post-processing: transcript/intent/condition_mentioned
// reconciliation + per-call AI summary (agent_summary).
//
// MUST run on every call-termination path:
//   - /api/public/bridge/end      (bridge WS closed — agent hangup, watchdog, agent_end_call)
//   - /api/public/plivo/status    (Plivo hangup_url — caller hangup, no-answer, busy, failed...)
//
// Previously this logic lived only inside bridge.end.ts. For inbound calls
// where the caller hangs up, Plivo's hangup_url POST to plivo/status often
// resolves the call to a terminal status BEFORE the bridge's WS "close"
// event reaches bridge/end. bridge/end's LIVE_STATES guard then short-circuits
// (status already terminal) and the whole reconcile + summary block was
// skipped — so condition_mentioned / agent_summary never got populated for
// caller-hangup calls. Centralizing here and calling it from BOTH routes
// fixes that without duplicating the implementation.
//
// runCallPostprocess is idempotent / safe to call twice for the same call
// (reconcile only fills blank fields; summary overwrite is harmless and
// final state converges either way), so no de-dup flag is required.
import type { TablesUpdate } from "@/integrations/supabase/types";
import { extractFromTranscript, type TranscriptTurn } from "@/lib/extractSymptoms";

export async function runCallPostprocess(
  supabaseAdmin: any,
  callId: string,
  clinicId: string | null | undefined,
): Promise<void> {
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
    const turnEvents = (events ?? []).filter((e: any) => e.event_type === "agent_turn");
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
    console.error("[postprocess] reconcile failed:", e instanceof Error ? e.message : e);
  }

  if (Object.keys(reconcile).length > 0) {
    const { error: reconcileErr } = await supabaseAdmin
      .from("calls")
      .update(reconcile)
      .eq("id", callId);
    if (reconcileErr) {
      console.error("[postprocess] reconcile update failed:", reconcileErr.message);
    } else {
      console.log(`[postprocess] reconciled callId=${callId} [${fixedFields.join("; ")}]`);
      try {
        await supabaseAdmin.from("call_events").insert({
          call_id: callId,
          clinic_id: clinicId,
          event_type: "bridge_end_reconciled",
          payload: { fixed: fixedFields } as never,
        });
      } catch (e) {
        console.error(
          "[postprocess] reconciled event log failed:",
          e instanceof Error ? e.message : e,
        );
      }
    }
  }

  // ---- Per-call summary ----
  // Use the freshest transcript: the just-reconciled one if we rebuilt it,
  // otherwise re-read the row (covers the case where reconcile produced no
  // changes but a transcript already existed on the row).
  let transcriptForSummary = reconcile.transcript as TranscriptTurn[] | undefined;
  if (!transcriptForSummary) {
    try {
      const { data } = await supabaseAdmin
        .from("calls")
        .select("transcript")
        .eq("id", callId)
        .maybeSingle();
      transcriptForSummary = Array.isArray(data?.transcript)
        ? (data!.transcript as unknown as TranscriptTurn[])
        : [];
    } catch (e) {
      console.error("[postprocess] transcript re-read failed:", e instanceof Error ? e.message : e);
      transcriptForSummary = [];
    }
  }

  await generatePerCallSummary(supabaseAdmin, callId, transcriptForSummary ?? []);
}

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

    const json = (await res.json()) as any;
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
