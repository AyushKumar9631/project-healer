// Server-only helper to insert rows into `call_timings`.
// Used by:
//   - bridge ingest endpoint (/api/public/bridge/timing) for batched bridge events
//   - server routes (/api/public/agent/greeting, /api/public/agent/turn) for
//     in-process latency measurements that don't need to round-trip the bridge.
//
// All inserts are best-effort: failures are logged but never thrown to the
// caller. Latency observability must never break the call path.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type CallTimingPhase =
  // Connection
  | "ws_open"
  | "stream_start"
  | "inbound_ring_start"
  | "inbound_ring_stop"
  // Greeting
  | "greeting_fetch_start"
  | "greeting_fetch_done"
  | "greeting_fetch_server"
  | "greeting_tts_first_byte"
  | "greeting_tts_done"
  // Turn loop (per patient turn)
  | "stt_partial_first"
  | "stt_committed"
  | "agent_turn_request"
  | "agent_turn_response"
  | "reply_tts_first_byte"
  | "reply_tts_done"
  | "speculative_started"
  | "speculative_resolved"
  | "speculative_aborted"
  // Closure
  | "bridge_end_request"
  | "call_terminal";

export type CallTimingInput = {
  call_id: string;
  clinic_id: string;
  direction: "inbound" | "outbound";
  provider: "twilio" | "plivo";
  phase: CallTimingPhase;
  t_offset_ms: number;
  duration_ms?: number | null;
  detail?: Record<string, unknown>;
  occurred_at?: string;
};

export async function recordCallTimings(rows: CallTimingInput[]): Promise<void> {
  if (!rows.length) return;
  const payload = rows.map((r) => ({
    call_id: r.call_id,
    clinic_id: r.clinic_id,
    direction: r.direction,
    provider: r.provider,
    phase: r.phase,
    t_offset_ms: Math.max(0, Math.round(r.t_offset_ms)),
    duration_ms:
      typeof r.duration_ms === "number" ? Math.max(0, Math.round(r.duration_ms)) : null,
    detail: (r.detail ?? {}) as never,
    occurred_at: r.occurred_at ?? new Date().toISOString(),
  }));
  const { error } = await supabaseAdmin.from("call_timings").insert(payload);
  if (error) {
    console.error(
      `[call_timings] insert failed (${payload.length} rows): ${error.message}`,
    );
  }
}

export async function recordCallTiming(row: CallTimingInput): Promise<void> {
  return recordCallTimings([row]);
}
