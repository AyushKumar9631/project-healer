import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

interface FetchHistoryArgs {
  patientId: string;
  supabase: SupabaseClient<Database>;
}

/**
 * Queries the calls table for a specific patient, targets records where 
 * agent_summary is populated, orders them from newest to oldest, and restricts
 * the result to a strict limit of 3 to optimize the LLM context window.
 */
export async function fetchPatientCallHistoryContext({
  patientId,
  supabase,
}: FetchHistoryArgs): Promise<string | null> {
  if (!patientId) return null;

  // Crucial: The query filter perfectly mirrors the conditional partial index clause
  // to ensure the planner picks up the idx_calls_patient_has_summary index.
  const { data: historyRows, error } = await supabase
    .from("calls")
    .select("direction, started_at, agent_summary")
    .eq("patient_id", patientId)
    .not("agent_summary", "is", null)
    .order("started_at", { ascending: false })
    .limit(3);

  if (error) {
    console.error(`[call-memory.server] Error fetching patient history context: ${error.message}`);
    return null;
  }

  if (!historyRows || historyRows.length === 0) {
    return null;
  }

  // Compile individual call records into a clean timeline block
  const formattedTimeline = historyRows
    .map((row, index) => {
      const dateStr = row.started_at ? new Date(row.started_at).toLocaleDateString("en-US") : "Unknown Date";
      const dirStr = (row.direction ?? "outbound").toUpperCase();
      return `[Call #${index + 1} - ${dateStr} (${dirStr})]: ${row.agent_summary}`;
    })
    .join("\n");

  return formattedTimeline;
}

/**
 * Safely appends the compiled summary text block into a clearly defined prompt wrapper.
 */
export function injectMemoryToSystemPrompt(baseSystemPrompt: string, memoryTimeline: string | null): string {
  if (!memoryTimeline) return baseSystemPrompt;

  return `${baseSystemPrompt}\n\n=== PATIENT HISTORICAL CONTEXT ===\nFollowing is the absolute ground-truth conversational profile and previous context summary for this patient from prior calls. Use this timeline context to inform your responses, understand situational blockers, or seamlessly continue past clinical scheduling contexts:\n${memoryTimeline}\n==================================\n`;
}