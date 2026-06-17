import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Sweeps up the latest completed call logs missing summaries, handles LLM translation 
 * instructions, and saves clinical metrics directly back into the 'agent_summary' column.
 */
export async function runFeedbackAnalysis(supabase: SupabaseClient): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("[Feedback Task] Skipped: GEMINI_API_KEY environment configuration is missing.");
    return;
  }

  // Pick calls completed in the last 24 hours that haven't been summarized yet
  const yesterdayIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  
  const { data: calls, error } = await supabase
    .from("calls")
    .select("id, transcript, direction")
    .eq("status", "completed")
    .is("agent_summary", null)
    .gt("started_at", yesterdayIso)
    .limit(5); // Process in highly controlled micro-batches

  if (error) {
    console.error(`[Feedback Task] Database query error: ${error.message}`);
    return;
  }

  if (!calls || calls.length === 0) {
    return;
  }

  console.log(`[Feedback Task] Found ${calls.length} un-summarized calls. Beginning asynchronous extractions...`);

  for (const call of calls) {
    const transcriptArray = call.transcript as Array<{ role: string; text: string }> | null;
    if (!transcriptArray || transcriptArray.length === 0) {
      // Clean up empty/stale interactions
      await supabase
        .from("calls")
        .update({ agent_summary: "Call terminated prematurely before dialogue exchange occurred." })
        .eq("id", call.id);
      continue;
    }

    // Standardize dialogue formatting schemas
    const formattedTranscript = transcriptArray
      .map((t) => `${t.role === "agent" ? "Agent" : "Patient"}: ${t.text}`)
      .join("\n");

    const analysisPrompt = `You are a Senior Medical Scribe analyzing an interaction recording transcript between an AI Clinic Voice Bot and a patient.
Your objective is to output a dense, high-utility clinical summary of exactly 1 to 2 sentences summarizing the interaction outcome.

CRITICAL INSTRUCTIONS:
- Track expressed symptoms, medical concerns, or scheduling constraints.
- Note situational barriers (e.g., patient traveling, busy, requested a call back later).
- State explicitly if they confirmed an appointment booking or declined.
- Write exclusively in clean English prose. Do not prefix with labels like "Summary:" or use markdown formatting blocks.

Conversation Log Transcript:
${formattedTranscript}`;

    try {
      const model = "gemini-2.5-flash-lite";
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: analysisPrompt }] }],
          generationConfig: {
            temperature: 0.1,
          },
        }),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => "Unable to read error text");
        console.error(`[Feedback Task] Gemini API returned non-200 for call ${call.id}: ${res.status}`);
        console.error(`[Feedback Task] Google API Error Details: ${errorText}`);

        // If we hit a 429 Rate Limit, aggressively back off and break the loop 
        // to let the token bucket refill before the next worker tick.
        if (res.status === 429) {
          console.warn(`[Feedback Task] Rate limit hit (429). Backing off until next tick...`);
          break; 
        }
        continue;
      }

      const jsonOutput = await res.json() as any;
      const rawSummary = jsonOutput.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

      if (rawSummary) {
        const sanitizedSummary = rawSummary.replace(/^["'\s]+|["'\s]+$/g, ""); // Strip trailing quote leaks
        
        const { error: writeErr } = await supabase
          .from("calls")
          .update({ agent_summary: sanitizedSummary })
          .eq("id", call.id);

        if (writeErr) {
          console.error(`[Feedback Task] Failed writing analysis outcome back to call row ${call.id}: ${writeErr.message}`);
        } else {
          console.log(`[Feedback Task] Successfully logged memory analysis summary for call ${call.id}`);
        }
      }

      // Artificial delay to prevent hitting Google's free-tier 15 RPM limit
      // Waits 4 seconds between each successful call (max 15 calls per minute)
      await new Promise((resolve) => setTimeout(resolve, 4000));

    } catch (err) {
      console.error(`[Feedback Task Exception] Error parsing call summary transaction ${call.id}:`, err);
    }
  }
}