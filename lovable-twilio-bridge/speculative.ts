/**
 * Speculative LLM execution (Phase 3).
 *
 * GATED OFF by default. Enable per-call by setting env var:
 *   AGENT_SPECULATIVE_ENABLED=1
 *
 * Idea: when ElevenLabs Scribe emits a stable partial transcript ~300–500ms
 * before the VAD commits, kick off a speculative streaming agent turn using
 * that partial as the utterance. When the real commit arrives:
 *   - If commit text starts-with the partial we used → REUSE the speculative
 *     turn (saves the time we would have spent waiting for the LLM).
 *   - Otherwise → ABORT the speculative turn and run the normal turn.
 *
 * Risks (why it's gated):
 *   1. Persistence still happens on the actual commit text via injectedReply,
 *      so a "kept" speculative run will inject a reply generated for slightly
 *      different input. We mitigate by requiring strict prefix match.
 *   2. Tokens/cost: every dropped speculation costs an LLM call.
 *   3. End-of-call detection: a speculative turn may set end_call=true on
 *      partial input. We disable end_call decisions on speculative results
 *      and instead defer to a confirming non-speculative call.
 *
 * This module is intentionally pure (no WebSocket coupling). The bridge
 * sentence loop calls `start()` on first stable partial and `resolve()` at
 * commit time.
 */

export type SpeculativeFrame =
  | { type: "chunk"; text: string }
  | { type: "final"; result: unknown }
  | { type: "error"; message: string };

export interface SpeculativeTurn {
  partialUtterance: string;
  abort: () => void;
  // Async iterable of frames already buffered + future frames. Safe to
  // consume only after `resolve()` returns { reuse: true }.
  frames: () => AsyncGenerator<SpeculativeFrame, void, void>;
}

export function speculativeEnabled(): boolean {
  return false;
}

/**
 * Start a speculative streaming agent turn for `partialUtterance`. Buffers
 * all frames internally so they can be replayed once the bridge decides to
 * keep the speculation.
 *
 * NOTE: callers MUST honour `resolve()` before consuming frames, otherwise
 * an aborted speculation will leak frames into the call.
 */
export function startSpeculativeTurn(args: {
  callId: string;
  partialUtterance: string;
  fetchStream: (callId: string, utterance: string) => AsyncGenerator<SpeculativeFrame, void, void>;
}): SpeculativeTurn {
  const { callId, partialUtterance, fetchStream } = args;
  const buffered: SpeculativeFrame[] = [];
  let aborted = false;
  let done = false;
  let waiter: ((f: SpeculativeFrame | null) => void) | null = null;

  (async () => {
    try {
      for await (const frame of fetchStream(callId, partialUtterance)) {
        if (aborted) return;
        buffered.push(frame);
        if (waiter) {
          const w = waiter;
          waiter = null;
          w(frame);
        }
      }
    } catch (e) {
      const err: SpeculativeFrame = {
        type: "error",
        message: e instanceof Error ? e.message : String(e),
      };
      buffered.push(err);
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(err);
      }
    } finally {
      done = true;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(null);
      }
    }
  })();

  async function* drain(): AsyncGenerator<SpeculativeFrame, void, void> {
    let idx = 0;
    while (true) {
      if (aborted) return;
      if (idx < buffered.length) {
        yield buffered[idx++];
        continue;
      }
      if (done) return;
      const next = await new Promise<SpeculativeFrame | null>((resolve) => {
        waiter = resolve;
      });
      if (next === null) return;
      // Already pushed by producer; advance idx.
      idx = buffered.length;
      yield next;
    }
  }

  return {
    partialUtterance,
    abort: () => {
      aborted = true;
    },
    frames: drain,
  };
}

/**
 * Decide whether a speculative turn started for `partialUtterance` is still
 * valid given the actual `commitUtterance`. Returns `reuse: true` only when
 * the commit is a strict expansion of the partial (case-insensitive prefix
 * match after whitespace normalisation).
 */
export function resolveSpeculative(
  partialUtterance: string,
  commitUtterance: string,
): { reuse: boolean; reason: string } {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[\s\u00A0]+/g, " ").trim();
  const p = norm(partialUtterance);
  const c = norm(commitUtterance);
  if (!p || !c) return { reuse: false, reason: "empty" };
  if (c === p) return { reuse: true, reason: "exact_match" };
  if (c.startsWith(p)) return { reuse: true, reason: "commit_extends_partial" };
  return { reuse: false, reason: "divergent" };
}

/**
 * Returns true if `currentPartial` still extends (or equals) the
 * `speculativePartial` — used to detect early divergence so we can abort
 * a speculation before commit time.
 */
export function partialStillExtends(
  speculativePartial: string,
  currentPartial: string,
): boolean {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[\s\u00A0]+/g, " ").trim();
  const p = norm(speculativePartial);
  const c = norm(currentPartial);
  if (!p || !c) return true;
  return c === p || c.startsWith(p);
}
