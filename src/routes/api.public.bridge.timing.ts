// Bridge -> Lovable: batch ingest for per-call latency events.
// Auth: shared `x-bridge-secret` header (same as /api/public/bridge/end).
//
// Bridges buffer timing events in-memory keyed by callId and POST a single
// batch when the call closes (and optionally mid-call if the buffer grows
// large). The endpoint is best-effort — it always returns 200 unless the
// request itself is malformed, so a failed insert never blocks the bridge's
// teardown path.

import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { recordCallTimings, type CallTimingPhase } from "@/lib/call-timings.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const PHASES: CallTimingPhase[] = [
  "ws_open",
  "stream_start",
  "inbound_ring_start",
  "inbound_ring_stop",
  "greeting_fetch_start",
  "greeting_fetch_done",
  "greeting_fetch_server",
  "greeting_tts_first_byte",
  "greeting_tts_done",
  "stt_partial_first",
  "stt_committed",
  "agent_turn_request",
  "agent_turn_response",
  "reply_tts_first_byte",
  "reply_tts_done",
  "speculative_started",
  "speculative_resolved",
  "speculative_aborted",
  "bridge_end_request",
  "call_terminal",
];

const EventSchema = z.object({
  phase: z.enum(PHASES as [CallTimingPhase, ...CallTimingPhase[]]),
  t_offset_ms: z.number().int().nonnegative().max(7_200_000),
  duration_ms: z.number().int().nonnegative().max(7_200_000).nullable().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
  occurred_at: z.string().datetime().optional(),
});

const InputSchema = z.object({
  callId: z.string().uuid(),
  provider: z.enum(["twilio", "plivo"]),
  // direction is optional — server resolves from the calls row when missing.
  direction: z.enum(["inbound", "outbound"]).optional(),
  events: z.array(EventSchema).min(1).max(500),
});

export const Route = createFileRoute("/api/public/bridge/timing")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.BRIDGE_SHARED_SECRET;
        if (!expected) {
          return Response.json(
            { error: "BRIDGE_SHARED_SECRET not configured" },
            { status: 500 },
          );
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
        const parsed = InputSchema.safeParse(body);
        if (!parsed.success) {
          return Response.json(
            { error: "invalid input", issues: parsed.error.flatten() },
            { status: 400 },
          );
        }

        const { callId, provider, direction: dirHint, events } = parsed.data;

        // Resolve clinic_id + direction from the call row (single lookup).
        const { data: call, error: lookupErr } = await supabaseAdmin
          .from("calls")
          .select("clinic_id,direction")
          .eq("id", callId)
          .maybeSingle();
        if (lookupErr || !call) {
          console.warn(
            `[bridge/timing] call lookup failed callId=${callId}: ${lookupErr?.message ?? "not found"}`,
          );
          return Response.json({ ok: false, reason: "call not found" }, { status: 404 });
        }

        const direction =
          dirHint ?? (call.direction === "inbound" ? "inbound" : "outbound");

        try {
          await recordCallTimings(
            events.map((ev) => ({
              call_id: callId,
              clinic_id: call.clinic_id,
              direction,
              provider,
              phase: ev.phase,
              t_offset_ms: ev.t_offset_ms,
              duration_ms: ev.duration_ms ?? null,
              detail: ev.detail ?? {},
              occurred_at: ev.occurred_at,
            })),
          );
        } catch (e) {
          console.error(
            `[bridge/timing] insert failed: ${e instanceof Error ? e.message : e}`,
          );
        }
        return Response.json({ ok: true, inserted: events.length });
      },
    },
  },
});
