// Per-call latency event buffer for the Twilio + Plivo bridges.
//
// Buffered in-memory keyed by callId so timing inserts never touch the
// audio path. Flushed once at end-of-call via POST /api/public/bridge/timing
// (with x-bridge-secret), and on demand if the buffer grows large.

export type Phase =
  | "ws_open"
  | "stream_start"
  | "inbound_ring_start"
  | "inbound_ring_stop"
  | "greeting_fetch_start"
  | "greeting_fetch_done"
  | "greeting_fetch_server"
  | "greeting_tts_first_byte"
  | "greeting_tts_done"
  | "stt_partial_first"
  | "stt_committed"
  | "agent_turn_request"
  | "agent_turn_response"
  | "reply_tts_first_byte"
  | "reply_tts_done"
  | "speculative_started"
  | "speculative_resolved"
  | "speculative_aborted"
  | "bridge_end_request"
  | "call_terminal";

export type TimingEvent = {
  phase: Phase;
  t_offset_ms: number;
  duration_ms?: number | null;
  detail?: Record<string, unknown>;
  occurred_at?: string;
};

export class TimingBuffer {
  private events: TimingEvent[] = [];
  private flushing = false;

  constructor(
    private readonly opts: {
      callId: string | null;
      provider: "twilio" | "plivo";
      direction?: "inbound" | "outbound";
      tCallStart: number;
      lovableBaseUrl: string;
      bridgeSecret: string;
      maxBufferBeforeFlush?: number;
    },
  ) {}

  setCallId(callId: string) {
    this.opts.callId = callId;
  }
  setDirection(d: "inbound" | "outbound") {
    this.opts.direction = d;
  }
  setCallStart(t: number) {
    this.opts.tCallStart = t;
  }

  record(phase: Phase, detail?: Record<string, unknown>, durationMs?: number) {
    const t_offset_ms = Math.max(0, Date.now() - this.opts.tCallStart);
    this.events.push({
      phase,
      t_offset_ms,
      duration_ms: typeof durationMs === "number" ? Math.max(0, durationMs) : null,
      detail: detail ?? {},
      occurred_at: new Date().toISOString(),
    });
    const max = this.opts.maxBufferBeforeFlush ?? 200;
    if (this.events.length >= max) {
      // Fire-and-forget mid-call flush; never block.
      this.flush().catch(() => {});
    }
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    if (!this.opts.callId) return;
    if (!this.events.length) return;
    // Snapshot WITHOUT removing — only splice on confirmed success so a
    // failed POST (network reset / 4xx / abort during shutdown) doesn't
    // silently drop the entire call's timeline.
    const snapshot = this.events.slice();
    this.flushing = true;
    try {
      const url = `${this.opts.lovableBaseUrl.replace(/\/+$/, "")}/api/public/bridge/timing`;
      const body = JSON.stringify({
        callId: this.opts.callId,
        provider: this.opts.provider,
        direction: this.opts.direction,
        events: snapshot,
      });
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-bridge-secret": this.opts.bridgeSecret,
            },
            body,
          });
          if (res.ok) {
            // Remove only the events we just persisted (any new events
            // recorded mid-flight stay in the buffer for the next flush).
            this.events.splice(0, snapshot.length);
            console.log(
              `[timing/flush] ok provider=${this.opts.provider} callId=${this.opts.callId} events=${snapshot.length}`,
            );
            return;
          }
          const text = await res.text().catch(() => "");
          console.error(
            `[timing/flush] HTTP ${res.status} attempt=${attempt} provider=${this.opts.provider} body=${text.slice(0, 200)}`,
          );
        } catch (e) {
          console.error(
            `[timing/flush] fetch failed attempt=${attempt}: ${e instanceof Error ? e.message : e}`,
          );
        }
        if (attempt < 2) await new Promise((r) => setTimeout(r, 250));
      }
      // Both attempts failed — keep events in buffer for any later flush.
    } finally {
      this.flushing = false;
    }
  }
}
