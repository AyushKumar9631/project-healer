/**
 * Plivo + ElevenLabs handler co-hosted on the Railway bridge.
 *
 * Exposes attachPlivo(httpServer, wss?) which:
 *   - mounts (or attaches to) a WebSocketServer at path /plivo
 *   - bridges Plivo AudioStream <-> ElevenLabs Scribe v2 Realtime STT
 *     (server-side VAD, streaming) <-> Lovable agent endpoints
 *     <-> ElevenLabs streaming TTS (mu-law 8kHz) <-> Plivo
 *   - supports barge-in: when the patient speaks during agent TTS, we
 *     send Plivo `clearAudio` and abort the TTS stream immediately.
 *   - plays a short Hindi filler ("जी...") if the LLM/TTS first byte
 *     hasn't landed within ~700ms, masking perceived latency.
 *
 * Required env (validated lazily on first connection):
 *   LOVABLE_BASE_URL
 *   BRIDGE_SHARED_SECRET
 *   ELEVENLABS_API_KEY
 * Optional:
 *   ELEVENLABS_VOICE_ID  (default Ms9OTvWb99V6DwRHZn6q)
 *   ELEVENLABS_TTS_MODEL (default eleven_flash_v2_5)
 *   ELEVENLABS_STT_MODEL (default scribe_v1)
 *   ELEVENLABS_STT_LANGUAGE (ISO 639-3, default "hin")
 *
 * Plivo AudioStream JSON protocol (incoming):
 *   {event:"start",  start:{streamId, callId, ...}, extra_headers:"k=v;..."}
 *   {event:"media",  media:{payload: <base64 PCM Lin16 8kHz>, ...}}
 *   {event:"stop"}
 * Outgoing:
 *   {event:"playAudio", media:{contentType:"audio/x-mulaw",
 *                              payload:<base64 mu-law 8kHz>, sampleRate:8000}}
 */

import type { Server as HttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { normalizeForTts } from "./ttsNormalize";
import { TimingBuffer } from "./timing";
import {
  speculativeEnabled,
  startSpeculativeTurn,
  resolveSpeculative,
  type SpeculativeFrame,
  type SpeculativeTurn,
} from "./speculative.js";

const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? "Ms9OTvWb99V6DwRHZn6q";
// Match Twilio bridge exactly: turbo_v2_5 has the lowest TTFB and is what
// production has been validated against. flash_v2_5 (previous default) added
// 200–400ms TTFB. Env override retained as ops escape hatch.
const ELEVENLABS_TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL ?? "eleven_turbo_v2_5";
// Phase-1 TTS tuning: drop stability slightly (more natural conversational
// prosody and faster generation) and bump optimize_streaming_latency to 4
// (lowest TTFB ElevenLabs offers — fine for 8kHz μ-law telephony).
const PLIVO_VOICE_SETTINGS = {
  stability: 0.45,
  similarity_boost: 0.8,
  style: 0.3,
  use_speaker_boost: true,
} as const;
const ELEVENLABS_OPTIMIZE_LATENCY = process.env.ELEVENLABS_OPTIMIZE_LATENCY ?? "4";
const ELEVENLABS_STT_MODEL = process.env.ELEVENLABS_STT_MODEL ?? "scribe_v1";
const ELEVENLABS_STT_LANGUAGE = process.env.ELEVENLABS_STT_LANGUAGE ?? "hin";
// Scribe end-of-utterance silence threshold (seconds). Lowered default to
// 0.3s (was 0.4s) to shrink the worst-case ~2.5s tail observed in
// production. Env-tunable; clamped to [0.2, 3]. Note: values <0.25 noticeably
// increase mid-sentence cuts.
const SCRIBE_VAD_SILENCE_SECS = (() => {
  const raw = process.env.STT_SILENCE_SECS;
  if (!raw) return 0.4;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0.2 || n > 3) return 0.4;
  return n;
})();

// Partial-stability commit fallback. When ON and the same partial text
// persists for STT_PARTIAL_STABLE_MS with length >= STT_STABILITY_MIN_LEN
// without a commit, synthesize a commit locally. Off by default.
const STT_STABILITY_COMMIT_ENABLED = process.env.STT_STABILITY_COMMIT_ENABLED === "1";
const STT_PARTIAL_STABLE_MS = (() => {
  const n = Number(process.env.STT_PARTIAL_STABLE_MS);
  return Number.isFinite(n) ? n : 500;
})();
const STT_STABILITY_MIN_LEN = 12;

// Speculative trigger gates.
const SPEC_MIN_PARTIAL_LEN = (() => {
  const n = Number(process.env.SPEC_MIN_PARTIAL_LEN);
  return Number.isFinite(n) && n >= 4 && n <= 64 ? n : 6;
})();
const SPEC_STABLE_MS = (() => {
  const n = Number(process.env.SPEC_STABLE_MS);
  return Number.isFinite(n) && n >= 0 && n <= 2000 ? n : 150;
})();
// Minimum partial-transcript confidence required before we burn an LLM call
// on speculation. Scribe v2 realtime exposes per-word confidence; we average
// across words. Without this gate, every fast-but-uncertain partial fires a
// spec turn that almost always gets aborted (see incident: 3 starts / 2
// aborts in <2s for one utterance). Default 0.75 mirrors typical Scribe
// "stable token" threshold; tune via env without redeploy.
const SPEC_MIN_CONFIDENCE = (() => {
  const n = Number(process.env.SPEC_MIN_CONFIDENCE);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.75;
})();
const AGENT_FAST_FIRST_SENTENCE = process.env.AGENT_FAST_FIRST_SENTENCE !== "0";

// Pre-warm TLS/DNS for every external host the turn-loop hits (ElevenLabs,
// Lovable Worker, Lovable AI Gateway). Saves ~150–400ms total per call by
// keeping the TLS sessions hot before the first real request.
// Fire-and-forget; never throws.
async function warmExternalConnections(): Promise<void> {
  const elKey = process.env.ELEVENLABS_API_KEY ?? "";
  const lovableBase = process.env.LOVABLE_BASE_URL ?? "";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    await Promise.allSettled([
      fetch("https://api.elevenlabs.io/v1/voices", {
        method: "GET",
        headers: { "xi-api-key": elKey },
        signal: ctrl.signal,
      })
        .then((r) => r.body?.cancel())
        .catch(() => {}),
      fetch("https://ai.gateway.lovable.dev/", {
        method: "GET",
        signal: ctrl.signal,
      })
        .then((r) => r.body?.cancel())
        .catch(() => {}),
      lovableBase
        ? fetch(`${lovableBase}/api/public/agent/turn`, {
            method: "OPTIONS",
            signal: ctrl.signal,
          })
            .then((r) => r.body?.cancel())
            .catch(() => {})
        : Promise.resolve(),
      // Warm /agent/greeting: hits the GET warm-up branch which JIT-compiles
      // the handler and opens the TLS session before the first real POST.
      // Was missing previously — every cold start paid ~1s extra TTFB on
      // greeting fetch (see waterfall: bridge=4187ms vs server=2674ms).
      lovableBase
        ? fetch(`${lovableBase}/api/public/agent/greeting?warm=1`, {
            method: "GET",
            signal: ctrl.signal,
          })
            .then((r) => r.body?.cancel())
            .catch(() => {})
        : Promise.resolve(),
    ]);
  } catch {
    // best effort; never blocks
  } finally {
    clearTimeout(timer);
  }
}

function envOrEmpty(name: string): string {
  return (process.env[name] ?? "").trim();
}

export function plivoConfigStatus() {
  return {
    LOVABLE_BASE_URL: !!envOrEmpty("LOVABLE_BASE_URL"),
    BRIDGE_SHARED_SECRET: !!envOrEmpty("BRIDGE_SHARED_SECRET"),
    ELEVENLABS_API_KEY: !!envOrEmpty("ELEVENLABS_API_KEY"),
  };
}

// Canonical text for the cached BP/Glucose follow-up. MUST match
// src/lib/agent-canonical.ts FOLLOWUP_BP_GLUCOSE byte-for-byte for the fast
// match; we ALSO normalise both sides so trailing punctuation drift doesn't
// silently miss the cache.
const FOLLOWUP_BP_GLUCOSE_TEXT = "क्या उसके बाद आपने BP और Glucose की जाँच दोबारा करवाई है? अब आप कैसे हैं?";
const CALLBACK_ASK_TIME_TEXT = "कोई बात नहीं। क्या मैं आपको बाद में कॉल कर सकती हूँ — कब का समय आपके लिए ठीक रहेगा?";

// Silence-handling thresholds (ms). Each is measured from the moment the
// agent stopped speaking (or the previous nudge finished). Override via
// env vars on Railway without code changes:
//   SILENCE_NUDGE_1_MS, SILENCE_NUDGE_2_MS, SILENCE_HANGUP_MS
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const SILENCE_NUDGE_1_MS = envMs("SILENCE_NUDGE_1_MS", 5000);
const SILENCE_NUDGE_2_MS = envMs("SILENCE_NUDGE_2_MS", 5000);
const SILENCE_HANGUP_MS = envMs("SILENCE_HANGUP_MS", 5000);
// Grace window: if real patient audio or a Scribe partial was seen within
// this many ms, suppress the nudge — the patient is talking, just hasn't
// committed yet.
const SILENCE_RECENT_ACTIVITY_GRACE_MS = envMs("SILENCE_RECENT_ACTIVITY_GRACE_MS", 1500);

// Scripted nudge / goodbye lines.
const SILENCE_NUDGE_1_TEXT = "क्या आप मुझे सुन पा रहे हैं?";
const SILENCE_NUDGE_2_PRE_GREETING_TEXT = "अगर आप व्यस्त हैं तो कोई बात नहीं, मैं आपको बाद में कॉल कर सकती हूँ।";
const SILENCE_NUDGE_2_MID_CONVERSATION_TEXT = "क्या आप कुछ कहना चाहती हैं?";
const SILENCE_GOODBYE_TEXT = "लगता है आवाज़ नहीं आ रही। मैं बाद में दोबारा कॉल कर लूँगी। धन्यवाद।";

function normalizeReply(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[\s\u00A0]+/g, " ")
    .replace(/[?।.!,।]+$/g, "")
    .trim();
}

export function attachPlivo(
  httpServer: HttpServer,
  wss?: WebSocketServer,
  getPrelude?: () => Buffer | null,
  getFollowupPrelude?: () => Buffer | null,
  getCallbackAskPrelude?: () => Buffer | null,
  getRing?: () => Buffer | null,
) {
  const plivoWss = wss ?? new WebSocketServer({ server: httpServer, path: "/plivo" });
  plivoWss.on("headers", (_h, req) => {
    console.log(`[plivo/upgrade] ${req.url} host=${req.headers.host}`);
  });

  plivoWss.on("connection", (plivoWs, req) => {
    const tWsOpen = Date.now();
    let urlCallId: string | null = null;
    try {
      const u = new URL(req.url ?? "/", "http://localhost");
      urlCallId = u.searchParams.get("callId");
    } catch {}
    const headerCallId = (req.headers["x-call-id"] as string | undefined) ?? null;
    console.log(
      `[plivo] connected ${headerCallId ?? urlCallId ?? "(no callId yet)"} ` +
        `silenceCfg nudge1=${SILENCE_NUDGE_1_MS} nudge2=${SILENCE_NUDGE_2_MS} hangup=${SILENCE_HANGUP_MS} grace=${SILENCE_RECENT_ACTIVITY_GRACE_MS}`,
    );

    const cfg = plivoConfigStatus();
    if (!cfg.LOVABLE_BASE_URL || !cfg.BRIDGE_SHARED_SECRET || !cfg.ELEVENLABS_API_KEY) {
      console.error("[plivo] missing required env:", cfg);
      try {
        plivoWs.close();
      } catch {}
      return;
    }

    let streamId: string | null = null;
    let callId: string | null = headerCallId ?? urlCallId ?? null;
    let closed = false;
    let agentBusy = false;
    let answered = false;
    let hadPatientTurn = false;
    let endReason: "stream_closed" | "agent_end_call" | "watchdog" | "silence_timeout" = "stream_closed";
    let tStreamStart = 0;
    let firstMediaLogged = false;
    let scribeWs: WebSocket | null = null;
    // Per-call latency buffer for the Plivo path. tCallStart updates on `start`.
    const timing = new TimingBuffer({
      callId,
      provider: "plivo",
      tCallStart: tWsOpen,
      lovableBaseUrl: process.env.LOVABLE_BASE_URL ?? "",
      bridgeSecret: process.env.BRIDGE_SHARED_SECRET ?? "",
    });
    timing.record("ws_open");
    // Barge-in state: set true while the agent's TTS is being streamed to
    // Plivo. The TTS streamer checks this on every frame; flipping it false
    // (via bargeInController) stops the stream and we send Plivo
    // `clearAudio` to flush whatever it's already buffered.
    let agentSpeaking = false;
    let bargeInController: { abort: () => void } | null = null;
    // Greeting protection: until segment 1 of the dynamic greeting fully
    // drains, ignore every Scribe partial/commit. After s1, the floor is
    // open — patient can interrupt s2.
    let greetingDone = false;
    // Anti-self-echo: while agentSpeaking OR within ECHO_TAIL_MS of last
    // TTS frame, we substitute μ-law silence (0xFF) for inbound audio
    // before forwarding to Scribe. This prevents self-transcription AND
    // keeps the Scribe socket alive (it closes on ~10s of no audio).
    let lastTtsEndedAt = 0;
    // Plivo's playAudio is appended to a server-side queue. The drain
    // function returns when the LAST frame is sent over the WS — but Plivo
    // is still PLAYING the tail (~200–500ms). Anything we send during that
    // window will overlap. ECHO_TAIL_MS keeps Scribe muted (silence frames)
    // for that long after each TTS drain ends, AND POST_PLAYOUT_GUARD_MS
    // (used in handleUtterance) keeps the turn lock held so no second
    // reply starts.
    const ECHO_TAIL_MS = 150;
    const POST_PLAYOUT_GUARD_MS = 400;
    const SILENCE_FRAME = Buffer.alloc(160, 0xff).toString("base64");
    // Single in-flight turn lock: drops duplicate Scribe commits and prevents
    // two parallel LLM/TTS streams (which were the source of mid-conversation
    // voice overlap).
    let turnInFlight: Promise<void> | null = null;
    // Legacy var kept only for the greeting pipeline's segment3 guard.
    let bargeInPartialCount = 0;
    // Silence-watchdog state. lastPatientActivityAt is the "agent stopped /
    // nudge ended" baseline. lastPatientAudioAt and lastScribePartialAt
    // track *real* patient activity so a nudge never fires while the patient
    // is mid-sentence (Scribe may take 0.4–0.8s to commit).
    // silenceNudgeCount: 0 = no nudge yet, 1 = played nudge #1, 2 = played
    // nudge #2, 3 = goodbye in flight.
    let lastPatientActivityAt = 0;
    let lastPatientAudioAt = 0;
    let lastScribePartialAt = 0;
    let silenceNudgeCount = 0;
    let lastAgentText = "";
    let silenceTimer: NodeJS.Timeout | null = null;
    let silenceActionInFlight = false;
    let sawPartialThisTurn = false;
    // Utterances dropped while a turn was in-flight that should be replayed
    // once the current turn finishes (currently unused by any push site —
    // reserved for future "queue instead of drop" handling). Declaring this
    // fixes a ReferenceError that fired on every single turn completion
    // (turnInFlight's .finally() referenced this without it ever being
    // declared), which crashed the bridge process via an unhandled
    // rejection right after every agent reply — dropping the live call.
    const pendingUtterances: string[] = [];
    // Speculative LLM (gated AGENT_SPECULATIVE_ENABLED). Started on first
    // long-enough STABLE partial; consumed/aborted at commit time or
    // aborted early on divergence.
    let speculative: SpeculativeTurn | null = null;
    let speculativeStartedAt = 0;
    // Stability debounce timer: arms on every partial-text change; fires
    // SPEC_STABLE_MS after the last change and (re-checks gates) starts the
    // speculative turn. Without this we can never observe a "stable" partial
    // because Scribe partials extend monotonically and then jump straight to
    // a commit — there is rarely an identical-partial repeat to compare against.
    let specStabilityTimer: ReturnType<typeof setTimeout> | null = null;
    // Tracks the timestamp of the previous partial event (any text), used by
    // the early-kickoff fast path for long stable prefixes.
    let prevPartialAt = 0;
    // Use-case (campaigns.use_case) for this call — captured from the
    // greeting response. Gates `/agent/turn-stream` + speculative LLM,
    // which today only support `screening_to_opd`. Non-screening
    // playbooks MUST run via `/agent/turn` to hit the playbook prompt.
    let callUseCase: string | null = null;
    // Phase 2: /agent/turn-stream is now playbook-aware (parameterised
    // prompt + Zod schema per use_case). All playbooks may stream.
    // `null` here means "no gating".
    const STREAMING_OK_USE_CASES: Set<string> | null = null;
    // Partial-stability tracking (shared by speculative trigger + STT
    // stability-fallback commit).
    let lastPartialText = "";
    let lastPartialChangedAt = 0;
    // Latest partial-transcript confidence reported by Scribe (0..1, or null
    // if Scribe didn't emit one for this partial). Used to gate spec turns.
    let lastPartialConfidence: number | null = null;
    // Single-shot speculative per turn: once we've fired a spec for the
    // current utterance, do not fire again until the next stt_committed
    // (which calls handleUtterance and resets this in resetTurnState).
    // Removes the start→abort→start flap visible in the waterfall.
    let specAttemptsThisTurn = 0;
    let stabilityCommitTimer: NodeJS.Timeout | null = null;
    // Diagnostics.
    let scribeFramesReal = 0;
    let scribeFramesSilence = 0;
    let scribeFramesDropped = 0;
    let commitsDroppedTurnInFlight = 0;
    let commitsDroppedPostPlayout = 0;
    let queuedUtterances = 0;
    let processedQueuedUtterances = 0;
    const diagInterval = setInterval(() => {
      if (closed) return;
      console.log(
        `[plivo/scribe] frames real=${scribeFramesReal} silence=${scribeFramesSilence} dropped=${scribeFramesDropped} state=${scribeWs?.readyState ?? "null"}`,
      );
    }, 5000);
    let firstInboundMediaResolve: (() => void) | null = null;
    const firstInboundMedia = new Promise<void>((resolve) => {
      firstInboundMediaResolve = resolve;
    });

    function clearSpecStabilityTimer() {
      if (specStabilityTimer) {
        clearTimeout(specStabilityTimer);
        specStabilityTimer = null;
      }
    }

    function maybeStartSpeculative(reason: "debounce" | "early_long_prefix") {
      specStabilityTimer = null;
      const trimmed = lastPartialText;
      const conf = lastPartialConfidence;
      const useCaseOk = !STREAMING_OK_USE_CASES || !callUseCase || STREAMING_OK_USE_CASES.has(callUseCase);
      // Hard gates: env, state, length.
      if (
        !speculativeEnabled() ||
        !useCaseOk ||
        speculative ||
        specAttemptsThisTurn >= 2 ||
        turnInFlight ||
        agentSpeaking ||
        !greetingDone ||
        !callId ||
        trimmed.length < SPEC_MIN_PARTIAL_LEN
      ) {
        return;
      }
      // Confidence gate: if Scribe gave us a number, require it to clear the
      // threshold. If Scribe didn't emit confidence (null) we accept — the
      // length+stability window is already a strong signal and we don't want
      // to disable speculation entirely on STT versions that lack the field.
      if (conf !== null && conf < SPEC_MIN_CONFIDENCE) {
        // Don't burn a turn slot, but log so we can graph rejections.
        timing.record("speculative_aborted", {
          reason: "low_confidence",
          confidence: conf,
          partial_len: trimmed.length,
        });
        return;
      }
      const cid = callId;
      speculativeStartedAt = Date.now();
      // Multi-shot per turn — set BEFORE await/start so concurrent partials
      // can't race a second start.
      specAttemptsThisTurn++;
      timing.record("speculative_started", {
        partial_len: trimmed.length,
        stable_ms: SPEC_STABLE_MS,
        confidence: conf,
        reason,
      });
      speculative = startSpeculativeTurn({
        callId: cid,
        partialUtterance: trimmed,
        fetchStream: async function* (id, utt) {
          for await (const f of fetchAgentReplyStreaming(id, utt, false)) {
            yield f as SpeculativeFrame;
          }
        },
      });
    }

    function triggerBargeIn(reason: string) {
      if (!agentSpeaking) return;
      // Never barge-in during the greeting — it must always finish.
      if (!greetingDone) return;
      console.log(`[plivo/barge-in] triggered (${reason})`);
      try {
        plivoWs.send(JSON.stringify({ event: "clearAudio" }));
      } catch {}
      bargeInController?.abort();
      // Cancel any in-flight speculation — it's wasted tokens once the
      // patient barged in.
      clearSpecStabilityTimer();
      if (speculative) {
        speculative.abort();
        timing.record("speculative_aborted", { reason: "barge_in" });
        speculative = null;
      }
    }

    async function handleUtterance(text: string, opts?: { bypassGuard?: boolean }) {
      if (closed || !callId) return;
      // Drop everything until the greeting has fully finished playing.
      if (!greetingDone) {
        console.log(`[plivo/scribe] dropping commit before greetingDone: "${text.slice(0, 60)}"`);
        return;
      }
      // Drop empty/very-short noise commits.
      const cleaned = text.trim();
      if (!cleaned || cleaned.length < 1) return;
      // Entry-gated lock: if a turn is already running (LLM call + TTS stream
      // + post-playout guard), drop this commit. Two parallel turns is the
      // primary cause of two-voice overlap.
      if (turnInFlight) {
        commitsDroppedTurnInFlight++;
        console.log(`[plivo/turn] drop, turn in-flight: "${cleaned.slice(0, 60)}"`);
        appendDroppedPatientLine(callId!, cleaned, "turn_in_flight").catch(() => {});
        return;
      }
      // If we're still inside the post-playout guard from the previous turn,
      // drop this commit — it's almost certainly self-echo of the tail.
      if (!opts?.bypassGuard && (agentSpeaking || Date.now() - lastTtsEndedAt < POST_PLAYOUT_GUARD_MS)) {
        commitsDroppedPostPlayout++;
        console.log(`[plivo/turn] drop, within post-playout guard: "${cleaned.slice(0, 60)}"`);

        const normalize = (s: string) =>
          s
            .toLowerCase()
            .replace(/[^\w\s\u0900-\u097F]/g, "")
            .replace(/\s+/g, "");
        const isEcho = lastAgentText && normalize(lastAgentText).includes(normalize(cleaned));

        if (!isEcho) {
          appendDroppedPatientLine(callId!, cleaned, "patient_interruption").catch(() => {});
        } else {
          console.log(`[plivo/turn] Ignored AI echo in transcript: "${cleaned.slice(0, 60)}"`);
        }
        return;
      }
      hadPatientTurn = true;
      // Real patient activity → reset silence watchdog.
      lastPatientActivityAt = Date.now();
      // Cancel any pending stability-fallback commit; we have a real one.
      if (stabilityCommitTimer) {
        clearTimeout(stabilityCommitTimer);
        stabilityCommitTimer = null;
      }
      // Cancel any pending speculative-debounce timer; commit will resolve
      // (or skip) the active speculation right after this.
      clearSpecStabilityTimer();
      silenceNudgeCount = 0;
      console.log(`[stt] -> "${cleaned}"`);
      timing.record("stt_committed", { utterance_len: cleaned.length });
      sawPartialThisTurn = false;
      // Reset multi-shot spec gate so the NEXT turn can speculate again.
      specAttemptsThisTurn = 0;
      lastPartialConfidence = null;
      // Resolve speculation BEFORE the turn lock takes over.
      const spec = speculative;
      speculative = null;
      let specReuse: { reuse: boolean; reason: string } = { reuse: false, reason: "no_spec" };
      if (spec) {
        specReuse = resolveSpeculative(spec.partialUtterance, cleaned);
        const savedMs = speculativeStartedAt ? Date.now() - speculativeStartedAt : 0;
        timing.record("speculative_resolved", {
          reuse: specReuse.reuse,
          reason: specReuse.reason,
          saved_ms: savedMs,
        });
        console.log(`[plivo/spec] reuse=${specReuse.reuse} reason=${specReuse.reason} saved_ms=${savedMs}`);
        if (!specReuse.reuse) spec.abort();
        speculativeStartedAt = 0;
      }
      turnInFlight = (async () => {
        let firstFrameAt = 0;
        let framesSent = 0;
        try {
          const tTurnStart = Date.now();
          timing.record("agent_turn_request", {
            utterance_len: cleaned.length,
            speculative_reused: specReuse.reuse,
          });

          // AGENT_STREAM_ENABLED — sentence-streaming path. The agent
          // turn is streamed sentence-by-sentence; we TTS each chunk
          // using ElevenLabs request stitching so prosody is preserved
          // across chunks. Falls back to legacy non-streaming path on
          // any error. Cached-TTS fast-path is skipped under streaming
          // (streaming saves ~more ms than the cache would).
          // Gate streaming + speculative reuse on use_case. /agent/turn-stream
          // currently runs the screening_to_opd LLM regardless of campaign,
          // so non-screening playbooks would hear screening audio while their
          // transcript shows the correct playbook reply. Force fallback to
          // /agent/turn (which dispatches playbooks correctly).
          const useCaseSupportsStream =
            !STREAMING_OK_USE_CASES || !callUseCase || STREAMING_OK_USE_CASES.has(callUseCase);
          const useStream =
            useCaseSupportsStream && (process.env.AGENT_STREAM_ENABLED !== "0" || (spec && specReuse.reuse));
          if (!useCaseSupportsStream && process.env.AGENT_STREAM_ENABLED !== "0") {
            console.log(`[plivo/agent.stream] disabled for use_case=${callUseCase} → using /agent/turn`);
          }
          let endCallFlag = false;
          let streamedOk = false;
          if (useStream) {
            try {
              const previousChunks: string[] = [];
              let firstByteRecorded = false;
              let finalResult: AgentTurnResult | null = null;
              agentSpeaking = true;
              lastAgentText = "";
              const frameIter: AsyncIterable<{
                type: string;
                text?: string;
                result?: AgentTurnResult;
                message?: string;
              }> =
                spec && specReuse.reuse
                  ? (spec.frames() as AsyncIterable<{
                      type: string;
                      text?: string;
                      result?: AgentTurnResult;
                      message?: string;
                    }>)
                  : (fetchAgentReplyStreaming(callId!, cleaned, false) as unknown as AsyncIterable<{
                      type: string;
                      text?: string;
                      result?: AgentTurnResult;
                      message?: string;
                    }>);
              let ttsQueue = Promise.resolve();
              for await (const frame of frameIter) {
                if (frame.type === "chunk" && typeof frame.text === "string") {
                  if (!firstByteRecorded) {
                    timing.record(
                      "agent_turn_response",
                      {
                        first_chunk_len: frame.text.length,
                        streamed: true,
                        speculative_reused: !!(spec && specReuse.reuse),
                      },
                      Date.now() - tTurnStart,
                    );
                    firstByteRecorded = true;
                  }
                  const prevText = previousChunks.slice(-2).join(" ");
                  const textToSpeak = frame.text;
                  ttsQueue = ttsQueue.then(() => streamElevenLabsTtsToPlivo(plivoWs, streamId, textToSpeak, {
                    previousText: prevText || undefined,
                    onStart: () => {
                      if (!firstFrameAt) firstFrameAt = Date.now();
                    },
                    onFrame: () => {
                      framesSent++;
                    },
                    onFirstByte: (ms) => {
                      if (previousChunks.length === 0) {
                        timing.record("reply_tts_first_byte", { fetch_ms: ms, streamed: true });
                      }
                    },
                    register: (ctl) => {
                      bargeInController = ctl;
                    },
                  }));
                  previousChunks.push(frame.text);
                  lastAgentText = previousChunks.join(" ");
                } else if (frame.type === "final" && frame.result) {
                  finalResult = frame.result;
                  endCallFlag = !!frame.result.end_call;
                } else if (frame.type === "error") {
                  throw new Error(`stream error: ${frame.message}`);
                }
              }
              await ttsQueue;
              if (finalResult) {
                void persistInjectedReply(callId!, cleaned, false, finalResult);
                timing.record(
                  "reply_tts_done",
                  { reply_len: finalResult.agent_reply.length, frames: framesSent, streamed: true },
                  Date.now() - tTurnStart,
                );
                console.log(`[plivo/agent.stream] reply="${finalResult.agent_reply.slice(0, 100)}" end=${endCallFlag}`);
                streamedOk = true;
              } else {
                throw new Error("stream completed without final frame");
              }
            } catch (streamErr) {
              console.error(
                "[plivo/agent.stream] failed, falling back to non-streaming:",
                streamErr instanceof Error ? streamErr.message : streamErr,
              );
            }
          }

          if (!streamedOk) {
            const reply = await fetchAgentReply(callId!, cleaned, false);
            timing.record(
              "agent_turn_response",
              { reply_len: reply.agent_reply.length, end_call: reply.end_call, fallback: useStream },
              Date.now() - tTurnStart,
            );
            console.log(`[agent] reply="${reply.agent_reply.slice(0, 100)}" end=${reply.end_call}`);
            agentSpeaking = true;

            // Cached-TTS fast path (legacy non-streaming only).
            const replyNorm = normalizeReply(reply.agent_reply);
            let cachedBuf: Buffer | null = null;
            let cachedLabel = "";
            if (replyNorm === normalizeReply(FOLLOWUP_BP_GLUCOSE_TEXT)) {
              cachedBuf = getFollowupPrelude?.() ?? null;
              cachedLabel = "followup";
            } else if (replyNorm === normalizeReply(CALLBACK_ASK_TIME_TEXT)) {
              cachedBuf = getCallbackAskPrelude?.() ?? null;
              cachedLabel = "callback-ask";
            }
            const tReplyTtsStart = Date.now();
            if (cachedBuf) {
              console.log(`[plivo/turn] cached ${cachedLabel} hit (${cachedBuf.length}b) — skipping live TTS`);
              firstFrameAt = Date.now();
              timing.record("reply_tts_first_byte", { cached: cachedLabel });
              await streamPreludeToPlivo(plivoWs, streamId, cachedBuf);
              framesSent = Math.floor(cachedBuf.length / 160);
            } else {
              await streamElevenLabsTtsToPlivo(plivoWs, streamId, reply.agent_reply, {
                onStart: () => {
                  firstFrameAt = Date.now();
                },
                onFrame: () => {
                  framesSent++;
                },
                onFirstByte: (ms) => timing.record("reply_tts_first_byte", { fetch_ms: ms }),
                register: (ctl) => {
                  bargeInController = ctl;
                },
              });
            }
            timing.record(
              "reply_tts_done",
              { reply_len: reply.agent_reply.length, frames: framesSent, cached: cachedLabel || null },
              Date.now() - tReplyTtsStart,
            );
            endCallFlag = reply.end_call;
          }

          // Real-time playout guard: wait until Plivo has actually finished
          // playing the audio out of its server-side queue, then add a small
          // safety margin. Without this, the next reply (or any STT commit
          // we'd otherwise act on) overlaps the tail.
          if (framesSent > 0 && firstFrameAt > 0) {
            const expectedPlayoutEndAt = firstFrameAt + framesSent * 20;
            const remaining = expectedPlayoutEndAt - Date.now();
            const wait = Math.max(0, remaining) + POST_PLAYOUT_GUARD_MS;
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          } else {
            // Defensive: still hold a small guard so the lock release isn't instant.
            await new Promise((r) => setTimeout(r, POST_PLAYOUT_GUARD_MS));
          }
          if (endCallFlag) {
            endReason = "agent_end_call";
            setTimeout(() => {
              try {
                plivoWs.close();
              } catch {}
            }, 1500);
          }
        } catch (e) {
          console.error("[plivo/turn] error:", e instanceof Error ? e.message : e);
        } finally {
          agentSpeaking = false;
          lastTtsEndedAt = Date.now();
          // Restart silence clock from the moment the agent's TTS finished.
          // The patient cannot reasonably be "silent" until after we stop talking.
          lastPatientActivityAt = Date.now();
          bargeInController = null;
        }
      })().finally(() => {
        turnInFlight = null;
        if (pendingUtterances.length > 0) {
          const combined = pendingUtterances.join(" ");
          pendingUtterances.length = 0;
          console.log(`[plivo/queue] processing pending utterances: "${combined}"`);
          setTimeout(() => {
            handleUtterance(combined, { bypassGuard: true }).catch(() => {});
          }, 50);
        }
      });
    }

    // Open Scribe v2 Realtime WS in parallel with greeting so STT is hot
    // by the time the patient replies. Auto-reconnects on close so the
    // socket stays alive for the entire call.
    const onCommitted = (utterance: string) => {
      void handleUtterance(utterance);
    };
    // Partial transcripts now do TWO things:
    //  1. Update lastScribePartialAt so the silence watchdog knows the
    //     patient is talking (Scribe commits can lag by 0.4–0.8s).
    //  2. If a silence nudge is currently playing, abort it — the patient
    //     just answered, don't talk over them.
    const onPartial = (partialText: string, confidence: number | null) => {
      if (!partialText || partialText.trim().length < 1) return;
      lastScribePartialAt = Date.now();
      const trimmed = partialText.trim();
      const now = Date.now();
      // Track stability: changed text resets the timer.
      const textChanged = trimmed !== lastPartialText;
      const sinceLastEvent = prevPartialAt ? now - prevPartialAt : 0;
      if (textChanged) {
        lastPartialText = trimmed;
        lastPartialChangedAt = now;
      }
      // Always record the latest confidence (caller-supplied; may be null).
      lastPartialConfidence = confidence;
      prevPartialAt = now;
      if (!sawPartialThisTurn) {
        sawPartialThisTurn = true;
        timing.record("stt_partial_first", { len: partialText.length });
      }
      if (silenceActionInFlight && agentSpeaking && greetingDone) {
        triggerBargeIn("scribe_partial_during_nudge");
      }

      // NOTE: We deliberately do NOT abort a running speculation when the
      // partial no longer extends it. Single-shot policy: we made one bet
      // per turn (gated by confidence + length + stability); resolve it at
      // commit time. If the commit diverges, resolveSpeculative returns
      // reuse:false and we run the canonical turn — same total cost as the
      // old start→abort→start loop, but with ONE LLM call instead of three.

      // Speculative LLM kickoff (debounced).
      if (textChanged) {
        clearSpecStabilityTimer();
        specStabilityTimer = setTimeout(() => maybeStartSpeculative("debounce"), SPEC_STABLE_MS);
      }

      // Early-kickoff fast path: if Scribe re-fired the SAME partial within
      // a short window (rare but possible — see anomalous call 787fafc9 where
      // this happened twice) AND the prefix is already long enough to be
      // useful, kick off immediately and skip the debounce.
      if (!textChanged && !speculative && sinceLastEvent >= 150 && trimmed.length >= 24) {
        clearSpecStabilityTimer();
        maybeStartSpeculative("early_long_prefix");
      }

      // Stability-fallback commit: if Scribe hasn't committed and the
      // partial has been stable for STT_PARTIAL_STABLE_MS, synthesize a
      // local commit. Single-shot per turn (sawPartialThisTurn is reset
      // in handleUtterance).
      if (
        STT_STABILITY_COMMIT_ENABLED &&
        !turnInFlight &&
        !agentSpeaking &&
        greetingDone &&
        trimmed.length >= STT_STABILITY_MIN_LEN
      ) {
        if (stabilityCommitTimer) clearTimeout(stabilityCommitTimer);
        const snapshot = trimmed;
        stabilityCommitTimer = setTimeout(() => {
          stabilityCommitTimer = null;
          if (turnInFlight || agentSpeaking || closed) return;
          if (lastPartialText !== snapshot) return; // changed since
          console.log(`[plivo/stt] stability_fallback commit: "${snapshot.slice(0, 60)}"`);
          // handleUtterance records stt_committed itself; tag detail via
          // a marker on the call so the analyser can attribute it.
          void handleUtterance(snapshot);
        }, STT_PARTIAL_STABLE_MS);
      }
    };

    let scribeReconnectAttempts = 0;
    const connectScribe = () => {
      openScribe(onCommitted, onPartial)
        .then((ws) => {
          scribeWs = ws;
          scribeReconnectAttempts = 0;
          console.log("[plivo/scribe] handle attached state=OPEN");
          ws.on("close", () => {
            console.warn("[plivo/scribe] state=CLOSED");
            scribeWs = null;
            if (closed) return;
            if (scribeReconnectAttempts >= 5) {
              console.error("[plivo/scribe] reconnect giving up after 5 attempts");
              return;
            }
            scribeReconnectAttempts++;
            const delay = scribeReconnectAttempts === 1 ? 0 : 500 * scribeReconnectAttempts;
            console.log(`[plivo/scribe] reconnect attempt ${scribeReconnectAttempts} in ${delay}ms`);
            setTimeout(connectScribe, delay);
          });
        })
        .catch((e) => {
          console.error("[plivo/scribe] failed to open:", e instanceof Error ? e.message : e);
          if (closed) return;
          if (scribeReconnectAttempts >= 5) return;
          scribeReconnectAttempts++;
          setTimeout(connectScribe, 500 * scribeReconnectAttempts);
        });
    };
    connectScribe();

    // ---------- Silence watchdog helpers ----------
    async function playSilenceNudge(text: string, label: string) {
      if (closed) return;
      console.log(`[plivo/silence] playing ${label}: "${text}"`);
      agentSpeaking = true;
      let firstFrameAt = 0;
      let framesSent = 0;
      try {
        await streamElevenLabsTtsToPlivo(plivoWs, streamId, text, {
          onStart: () => {
            firstFrameAt = Date.now();
          },
          onFrame: () => {
            framesSent++;
          },
          register: (ctl) => {
            bargeInController = ctl;
          },
        });
        if (framesSent > 0 && firstFrameAt > 0) {
          const expectedPlayoutEndAt = firstFrameAt + framesSent * 20;
          const remaining = expectedPlayoutEndAt - Date.now();
          const wait = Math.max(0, remaining) + POST_PLAYOUT_GUARD_MS;
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        }
      } catch (e) {
        console.error(`[plivo/silence] ${label} TTS failed:`, e instanceof Error ? e.message : e);
      } finally {
        agentSpeaking = false;
        lastTtsEndedAt = Date.now();
        bargeInController = null;
      }
    }

    async function gracefulSilenceHangup() {
      if (closed) return;
      console.log("[plivo/silence] graceful hangup after 3 silence nudges");
      await playSilenceNudge(SILENCE_GOODBYE_TEXT, "goodbye");
      endReason = "silence_timeout";
      try {
        plivoWs.close();
      } catch {}
    }

    async function checkSilence() {
      if (closed) return;
      if (silenceActionInFlight) return;
      if (agentSpeaking || turnInFlight) return;
      if (!greetingDone) return;
      const now = Date.now();
      // Defensive post-TTS grace: even if some future code path forgets to
      // bump lastPatientActivityAt, never fire a nudge until at least the
      // nudge#1 threshold has elapsed since the agent's last audio frame.
      const sinceTtsEnd = lastTtsEndedAt > 0 ? now - lastTtsEndedAt : Number.POSITIVE_INFINITY;
      if (sinceTtsEnd < SILENCE_NUDGE_1_MS) {
        return;
      }
      // Suppress if real patient audio or a Scribe partial happened recently
      // — patient is talking but Scribe hasn't committed yet.
      const sinceAudio = now - lastPatientAudioAt;
      const sincePartial = now - lastScribePartialAt;
      if (lastPatientAudioAt > 0 && sinceAudio < SILENCE_RECENT_ACTIVITY_GRACE_MS) {
        console.log(`[plivo/silence] suppressed: recent audio ${sinceAudio}ms ago`);
        return;
      }
      if (lastScribePartialAt > 0 && sincePartial < SILENCE_RECENT_ACTIVITY_GRACE_MS) {
        console.log(`[plivo/silence] suppressed: recent partial ${sincePartial}ms ago`);
        return;
      }
      const idleMs = now - lastPatientActivityAt;
      const threshold =
        silenceNudgeCount === 0 ? SILENCE_NUDGE_1_MS : silenceNudgeCount === 1 ? SILENCE_NUDGE_2_MS : SILENCE_HANGUP_MS;
      if (idleMs < threshold) return;
      console.log(
        `[plivo/silence] idle=${idleMs}ms sinceTtsEnd=${sinceTtsEnd}ms threshold=${threshold}ms count=${silenceNudgeCount} → firing`,
      );

      silenceActionInFlight = true;
      try {
        if (silenceNudgeCount === 0) {
          await playSilenceNudge(SILENCE_NUDGE_1_TEXT, "nudge#1");
          silenceNudgeCount = 1;
          lastPatientActivityAt = Date.now();
        } else if (silenceNudgeCount === 1) {
          const text = hadPatientTurn ? SILENCE_NUDGE_2_MID_CONVERSATION_TEXT : SILENCE_NUDGE_2_PRE_GREETING_TEXT;
          await playSilenceNudge(text, "nudge#2");
          silenceNudgeCount = 2;
          lastPatientActivityAt = Date.now();
        } else {
          silenceNudgeCount = 3;
          await gracefulSilenceHangup();
        }
      } finally {
        silenceActionInFlight = false;
      }
    }

    plivoWs.on("message", async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.event === "start") {
        tStreamStart = Date.now();
        streamId = msg.start?.streamId ?? msg.streamId ?? null;
        const fromExtra =
          parseExtraHeader(msg.extra_headers, "x-call-id") ?? parseExtraHeader(msg.start?.extra_headers, "x-call-id");
        const fromCustom =
          (msg.start?.customParameters &&
            (msg.start.customParameters["x-call-id"] ?? msg.start.customParameters.callId)) ||
          null;
        callId = callId ?? fromExtra ?? fromCustom ?? null;
        // Direction: prefer URL query (?direction=inbound), then extraHeaders
        // (x-direction=inbound). This is set by the Plivo voice route only
        // for inbound calls — outbound never carries it.
        const directionFromUrl = (() => {
          try {
            const u = new URL(req.url ?? "/", "http://localhost");
            return (u.searchParams.get("direction") ?? "").toLowerCase();
          } catch {
            return "";
          }
        })();
        const directionFromExtra = (
          parseExtraHeader(msg.extra_headers, "x-direction") ??
          parseExtraHeader(msg.start?.extra_headers, "x-direction") ??
          ""
        ).toLowerCase();
        const isInbound = directionFromUrl === "inbound" || directionFromExtra === "inbound";
        if (callId) timing.setCallId(callId);
        timing.setDirection(isInbound ? "inbound" : "outbound");
        timing.setCallStart(tStreamStart);
        timing.record("stream_start", {
          streamId,
          msSinceWsOpen: tStreamStart - tWsOpen,
          plivoCallUuid: msg.start?.callId ?? null,
        });
        console.log("[plivo] start", {
          streamId,
          callId,
          isInbound,
          plivoCallUuid: msg.start?.callId ?? null,
          msSinceWsOpen: tStreamStart - tWsOpen,
        });

        if (!callId) {
          console.error(
            "[plivo] no callId resolvable.",
            JSON.stringify({
              urlCallId,
              headerCallId,
              fromExtra,
              fromCustom,
              extra_headers: msg.extra_headers ?? msg.start?.extra_headers ?? null,
            }).slice(0, 800),
          );
          try {
            plivoWs.close();
          } catch {}
          return;
        }

        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(callId)) {
          console.warn(`[plivo] callId "${callId}" does not look like a UUID`);
        }

        // Pipeline:
        //   t=0      "namaste" prelude streams to Plivo (pre-cached)
        //   t=0      greeting fetch fires in parallel; resolves to 3 segments
        //   t=~300ms s1 TTS POST fires, bytes buffer
        //   t=~800ms prelude finishes → drain s1 → 250ms listening pause
        //            → s2 (interruptible) → s3 (mandatory question)
        const tCallStart = Date.now();
        agentBusy = true;
        agentSpeaking = true;
        try {
          let playRing = false;
          const tGreetingFetchStart = Date.now();
          timing.record("greeting_fetch_start");
          const segmentsPromise: Promise<{ s1: string; s2: string; s3: string }> = (async () => {
            try {
              const greeting = await fetchAgentGreeting(callId);
              playRing = !!greeting.play_ring;
              callUseCase = greeting.use_case ?? null;
              const segs = greeting.greeting_segments;
              if (Array.isArray(segs) && segs.length === 3) {
                console.log(
                  `[plivo/agent] greeting (+${Date.now() - tCallStart}ms) use_case=${callUseCase ?? "?"} play_ring=${playRing} s1="${segs[0].slice(0, 60)}" s2="${segs[1].slice(0, 60)}" s3="${segs[2].slice(0, 60)}"`,
                );
                timing.record(
                  "greeting_fetch_done",
                  { play_ring: playRing, segments: 3, use_case: callUseCase },
                  Date.now() - tGreetingFetchStart,
                );
                return { s1: segs[0], s2: segs[1], s3: segs[2] };
              }
              // Back-compat: old endpoint returned only agent_reply.
              timing.record(
                "greeting_fetch_done",
                { play_ring: playRing, segments: 1 },
                Date.now() - tGreetingFetchStart,
              );
              return {
                s1: greeting.agent_reply,
                s2: "",
                s3: "",
              };
            } catch (e) {
              timing.record(
                "greeting_fetch_done",
                { error: e instanceof Error ? e.message : String(e), fallback: true },
                Date.now() - tGreetingFetchStart,
              );
              console.error(
                "[plivo/greeting] primary failed, using local fallback:",
                e instanceof Error ? e.message : e,
              );
              return {
                s1: "मैं क्लिनिक से बोल रही हूँ।",
                s2: "",
                s3: "क्या आप अभी बात कर सकते हैं?",
              };
            }
          })();

          // Prefetch s1 (introduction) — the only segment we need before the
          // prelude finishes. s2/s3 can be fetched while s1 plays.
          const s1HandlePromise = segmentsPromise.then((segs) =>
            prefetchPlivoTtsStream(segs.s1, tCallStart, {
              onFirstByte: (ms) => timing.record("greeting_tts_first_byte", { fetch_ms: ms }),
            }),
          );

          void warmExternalConnections();

          // Inbound ringback: gated synchronously on the WS start direction
          // param — NEVER on the greeting fetch (that was the silence bug).
          // Runs in parallel with greeting/s1-TTS prefetch and stops as soon
          // as s1 TTS handle is ready, OR after the ring duration elapses.
          const ring = getRing?.() ?? null;
          console.log(`[plivo/ring] decision inbound=${isInbound} hasRing=${!!ring} playRingFlag=${playRing}`);
          if (isInbound && ring) {
            // Wait briefly for first inbound media so Plivo's playout queue
            // is open before we push frames (otherwise frames can be dropped).
            await Promise.race([firstInboundMedia, new Promise<void>((r) => setTimeout(r, 150))]);
            const tRingStart = Date.now();
            timing.record("inbound_ring_start", { hasRing: true });
            const ringStopSignal = s1HandlePromise.then(() => undefined).catch(() => undefined);
            await streamRingUntilPlivo(plivoWs, streamId, ring, ringStopSignal, tCallStart);
            timing.record("inbound_ring_stop", {}, Date.now() - tRingStart);
          }

          const prelude = getPrelude?.() ?? null;
          if (prelude) {
            const tWaitStart = Date.now();
            await Promise.race([firstInboundMedia, new Promise<void>((r) => setTimeout(r, 150))]);
            console.log(
              `[plivo/timing] firstInboundMedia=+${Date.now() - tCallStart}ms ` +
                `(waited ${Date.now() - tWaitStart}ms, cap=150ms)`,
            );
            console.log(`[plivo/timing] prelude=start +${Date.now() - tCallStart}ms`);
            await streamPreludeToPlivo(plivoWs, streamId, prelude);
            console.log(`[plivo/timing] prelude=done  +${Date.now() - tCallStart}ms`);
          } else {
            console.warn("[plivo] prelude=SKIPPED (no prelude available)");
          }

          // Segment 1 — protected (no barge-in). After this, open the floor.
          const s1Handle = await s1HandlePromise;
          console.log(`[plivo/timing] s1=drain +${Date.now() - tCallStart}ms (buffered=${s1Handle.bufferedBytes}b)`);
          const tGreetingTtsDrainStart = Date.now();
          await s1Handle.drain(plivoWs, streamId);
          timing.record(
            "greeting_tts_done",
            { buffered_bytes: s1Handle.bufferedBytes },
            Date.now() - tGreetingTtsDrainStart,
          );
          console.log(`[plivo/timing] s1=done   +${Date.now() - tCallStart}ms`);
          answered = true;
          // Mark s1 done; allow patient utterances to be processed for s2/s3.
          agentSpeaking = false;
          lastTtsEndedAt = Date.now();
          greetingDone = true;
          bargeInPartialCount = 0;
          console.log(`[plivo/greeting] greetingDone=true at +${Date.now() - tCallStart}ms (after s1)`);

          const segs = await segmentsPromise;

          // 250ms listening window. If patient already spoke during s1
          // tail or during this pause, agentBusy will be cleared by
          // handleUtterance's flow — skip s2 and let the turn loop reply.
          await new Promise((r) => setTimeout(r, 250));

          // Segment 2 — interruptible context. Skip if no text or if patient
          // started a turn already.
          if (segs.s2 && segs.s2.trim() && !hadPatientTurn) {
            agentSpeaking = true;
            try {
              const abortCtl = new AbortController();
              bargeInController = { abort: () => abortCtl.abort() };
              await streamElevenLabsTtsToPlivo(plivoWs, streamId, segs.s2, {
                onStart: () => {
                  agentSpeaking = true;
                },
                register: (ctl) => {
                  bargeInController = ctl;
                },
              });
            } finally {
              agentSpeaking = false;
              lastTtsEndedAt = Date.now();
              lastPatientActivityAt = Date.now();
              bargeInController = null;
            }
            console.log(`[plivo/timing] s2=done +${Date.now() - tCallStart}ms hadPatientTurn=${hadPatientTurn}`);
          }

          // Small breath between s2 and s3 so they don't run as one chunk.
          await new Promise((r) => setTimeout(r, 150));

          // Segment 3 — mandatory question. Always plays unless the patient
          // already started talking. Previously also gated on !agentBusy
          // which is *always* true during the greeting pipeline, causing s3
          // to be silently skipped on every call.
          if (segs.s3 && segs.s3.trim() && !hadPatientTurn) {
            agentSpeaking = true;
            try {
              await streamElevenLabsTtsToPlivo(plivoWs, streamId, segs.s3, {
                onStart: () => {
                  agentSpeaking = true;
                },
                register: () => {}, // s3 is short; don't register barge-in
              });
            } finally {
              agentSpeaking = false;
              lastTtsEndedAt = Date.now();
              lastPatientActivityAt = Date.now();
            }
            console.log(`[plivo/timing] s3=done +${Date.now() - tCallStart}ms`);
          } else {
            console.log(`[plivo/timing] s3=SKIPPED hadPatientTurn=${hadPatientTurn} hasText=${!!segs.s3?.trim()}`);
          }
        } catch (e) {
          console.error("[plivo/greeting] pipeline failed:", e instanceof Error ? e.message : e);
        } finally {
          agentSpeaking = false;
          lastTtsEndedAt = Date.now();
          greetingDone = true;
          bargeInPartialCount = 0;
          agentBusy = false;
          // Start the silence watchdog clock from the moment the greeting
          // pipeline (s1+s2+s3) finished. Real patient commits will reset
          // this; nudges will advance silenceNudgeCount.
          lastPatientActivityAt = Date.now();
        }

        // Silence watchdog: every 1s, check whether the patient has been
        // idle. Plays up to 2 nudges then a graceful goodbye + hangup.
        silenceTimer = setInterval(() => {
          void checkSilence();
        }, 1000);

        setTimeout(() => {
          if (!closed) {
            endReason = "watchdog";
            try {
              plivoWs.close();
            } catch {}
          }
        }, 180_000);
      } else if (msg.event === "media") {
        const payload: string = msg.media?.payload ?? "";
        if (!payload) return;
        // Signal the greeting pipeline that Plivo's media path is open.
        if (firstInboundMediaResolve) {
          firstInboundMediaResolve();
          firstInboundMediaResolve = null;
        }
        if (!firstMediaLogged) {
          firstMediaLogged = true;
          const buf = Buffer.from(payload, "base64");
          console.log(
            `[plivo/audio] first inbound frame bytes=${buf.length} ` +
              `(forwarding μ-law 8kHz directly to Scribe v2 Realtime)`,
          );
          if (buf.length !== 160) {
            console.warn(`[plivo/audio] unexpected frame size ${buf.length} — μ-law 20ms should be 160 bytes`);
          }
        }
        // Forward μ-law audio to Scribe Realtime. While agent is speaking
        // (or within the echo tail), substitute μ-law silence so:
        //   - Scribe never transcribes the agent's own voice (anti-echo)
        //   - The Scribe socket stays alive (otherwise it closes after
        //     ~10s of no inbound audio with insufficient_audio_activity)
        const inEchoWindow = Date.now() - lastTtsEndedAt < ECHO_TAIL_MS;
        // Track real inbound audio (outside the echo window) so the silence
        // watchdog can suppress nudges when the patient is actively speaking.
        // Use a simple non-silence detector: a frame is "real" if it isn't
        // all-0xFF μ-law silence. Cheap base64 length + first/last byte check.
        if (!inEchoWindow) {
          const b = Buffer.from(payload, "base64");
          // μ-law silence is 0xFF. Sample a few bytes; if any differ, count
          // it as real audio activity.
          if (b.length > 0 && (b[0] !== 0xff || b[b.length - 1] !== 0xff || b[Math.floor(b.length / 2)] !== 0xff)) {
            lastPatientAudioAt = Date.now();
          }
        }
        if (scribeWs && scribeWs.readyState === WebSocket.OPEN) {
          if (inEchoWindow) {
            scribeWs.send(
              JSON.stringify({
                message_type: "input_audio_chunk",
                audio_base_64: SILENCE_FRAME,
              }),
            );
            scribeFramesSilence++;
          } else {
            scribeWs.send(
              JSON.stringify({
                message_type: "input_audio_chunk",
                audio_base_64: payload,
              }),
            );
            scribeFramesReal++;
          }
        } else {
          scribeFramesDropped++;
        }
      } else if (msg.event === "stop") {
        console.log("[plivo] stop");
        await cleanup();
      }
    });

    plivoWs.on("close", () => {
      console.log(`[plivo] closed answered=${answered} hadPatientTurn=${hadPatientTurn}`);
      void cleanup();
    });
    plivoWs.on("error", (e) => console.error("[plivo] error", e));

    async function cleanup() {
      if (closed) return;
      closed = true;
      clearSpecStabilityTimer();
      if (speculative) {
        try {
          speculative.abort();
        } catch {}
        speculative = null;
      }
      try {
        clearInterval(diagInterval);
      } catch {}
      if (silenceTimer) {
        try {
          clearInterval(silenceTimer);
        } catch {}
        silenceTimer = null;
      }
      if (stabilityCommitTimer) {
        try {
          clearTimeout(stabilityCommitTimer);
        } catch {}
        stabilityCommitTimer = null;
      }
      if (scribeWs && scribeWs.readyState === WebSocket.OPEN) {
        try {
          scribeWs.close();
        } catch {}
      }
      if (!callId) return;
      const dur = tStreamStart ? Math.max(0, Math.round((Date.now() - tStreamStart) / 1000)) : 0;
      timing.record("bridge_end_request", {
        end_reason: endReason,
        answered,
        had_patient_turn: hadPatientTurn,
        duration_seconds: dur,
      });
      timing.record("call_terminal", { end_reason: endReason });
      // CRITICAL: await both POSTs. The Worker may otherwise idle out before
      // TLS finishes — that's how the entire timing buffer was being lost.
      await Promise.allSettled([
        timing.flush().catch((e) => console.error("[timing/flush] cleanup error:", e instanceof Error ? e.message : e)),
        notifyBridgeEnd(callId, endReason, answered, hadPatientTurn, dur).catch((e) =>
          console.error("[plivo/bridge-end] notify failed:", e instanceof Error ? e.message : e),
        ),
      ]);
    }
  });

  console.log("[plivo] WebSocketServer mounted at /plivo");
}

function parseExtraHeader(raw: unknown, key: string): string | null {
  if (!raw) return null;
  const wantedKey = key.toLowerCase();
  const altKey = `x-ph-${wantedKey}`;
  if (typeof raw === "object" && raw !== null) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const lk = k.toLowerCase();
      if ((lk === wantedKey || lk === altKey) && typeof v === "string") return v;
    }
    return null;
  }
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/^[{["']+|[}\]"']+$/g, "");
  for (const pair of cleaned.split(/[;,&]/)) {
    const eqIdx = pair.indexOf("=");
    const colonIdx = pair.indexOf(":");
    let sepIdx = -1;
    if (eqIdx !== -1 && colonIdx !== -1) sepIdx = Math.min(eqIdx, colonIdx);
    else sepIdx = eqIdx !== -1 ? eqIdx : colonIdx;
    if (sepIdx === -1) continue;
    const k = pair.slice(0, sepIdx).trim().toLowerCase();
    const v = pair
      .slice(sepIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (k === wantedKey || k === altKey) return v;
  }
  return null;
}

// (Removed legacy energy-VAD + Scribe v1 batch STT — Phase 2 moved to
// Scribe v2 Realtime streaming STT with server-side VAD. See openScribe
// at the bottom of this file.)

// =============================================================
// ElevenLabs streaming TTS -> Plivo (mu-law 8kHz) — barge-in aware
// =============================================================
type TtsBargeOpts = {
  onStart?: () => void;
  onFrame?: () => void;
  onFirstByte?: (ms: number) => void;
  register?: (ctl: { abort: () => void }) => void;
  // Request stitching for natural prosody across sentence chunks.
  previousText?: string;
  nextText?: string;
};

async function streamElevenLabsTtsToPlivo(
  plivoWs: WebSocket,
  streamId: string | null,
  text: string,
  opts: TtsBargeOpts = {},
) {
  if (!text?.trim()) return;
  const t0 = Date.now();
  void streamId;

  let aborted = false;
  const abortCtl = new AbortController();
  const ctl = {
    abort: () => {
      aborted = true;
      try {
        abortCtl.abort();
      } catch {}
    },
  };
  opts.register?.(ctl);

  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream` +
    `?output_format=ulaw_8000&optimize_streaming_latency=${ELEVENLABS_OPTIMIZE_LATENCY}`;
  let ttsRes: Response;
  try {
    ttsRes = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY ?? "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: normalizeForTts(text),
        model_id: ELEVENLABS_TTS_MODEL,
        voice_settings: PLIVO_VOICE_SETTINGS,
        ...(opts.previousText ? { previous_text: opts.previousText } : {}),
        ...(opts.nextText ? { next_text: opts.nextText } : {}),
      }),
      signal: abortCtl.signal,
    });
  } catch (e) {
    if (aborted) {
      console.log(`[el.tts] aborted before first byte (barge-in) +${Date.now() - t0}ms`);
      return;
    }
    throw e;
  }
  if (!ttsRes.ok || !ttsRes.body) {
    const t = await ttsRes.text().catch(() => "");
    console.error(`[el.tts] ${ttsRes.status}: ${t.slice(0, 200)}`);
    throw new Error(`ElevenLabs TTS ${ttsRes.status}`);
  }

  const reader = ttsRes.body.getReader();
  const FRAME_BYTES = 160;
  let leftover: Uint8Array = new Uint8Array(0);
  let firstByteAt = 0;
  let nextSendAt = Date.now();
  let totalFramesSent = 0;
  let firstFrameLogged = false;

  function appendU8(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  async function sendFrame(frame: Uint8Array) {
    if (aborted || plivoWs.readyState !== WebSocket.OPEN) return;
    const wait = nextSendAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (aborted) return;
    nextSendAt = Math.max(nextSendAt + 20, Date.now());
    if (!firstFrameLogged) {
      console.log(`[el.tts] first frame contentType=audio/x-mulaw bytesPerFrame=${frame.length}`);
      firstFrameLogged = true;
      opts.onStart?.();
    }
    plivoWs.send(
      JSON.stringify({
        event: "playAudio",
        media: {
          contentType: "audio/x-mulaw",
          sampleRate: 8000,
          payload: Buffer.from(frame).toString("base64"),
        },
      }),
    );
    totalFramesSent++;
    opts.onFrame?.();
  }

  try {
    while (!aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      if (!firstByteAt) {
        firstByteAt = Date.now();
        console.log(`[el.tts] first byte ${firstByteAt - t0}ms`);
        opts.onFirstByte?.(firstByteAt - t0);
      }
      leftover = appendU8(leftover, value);
      let off = 0;
      while (!aborted && leftover.length - off >= FRAME_BYTES) {
        await sendFrame(leftover.subarray(off, off + FRAME_BYTES));
        off += FRAME_BYTES;
      }
      leftover = leftover.subarray(off).slice();
    }

    if (!aborted && leftover.length > 0) {
      const padded = new Uint8Array(FRAME_BYTES);
      padded.fill(0xff);
      padded.set(leftover, 0);
      await sendFrame(padded);
    }
  } catch (e) {
    if (!aborted) throw e;
  } finally {
    try {
      reader.cancel();
    } catch {}
  }

  console.log(
    `[el.tts] streamed ${totalFramesSent} frames (${totalFramesSent * 20}ms) in ${Date.now() - t0}ms wall aborted=${aborted}`,
  );
}

// =============================================================
// Lovable agent endpoints
// =============================================================
async function fetchAgentReply(callId: string, utterance: string, isFirstTurn: boolean) {
  const res = await fetch(`${process.env.LOVABLE_BASE_URL}/api/public/agent/turn`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bridge-secret": process.env.BRIDGE_SHARED_SECRET ?? "",
    },
    body: JSON.stringify({ callId, utterance, isFirstTurn }),
  });
  if (!res.ok) {
    throw new Error(`agent/turn ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as { agent_reply: string; end_call: boolean };
}

// Streaming variant — POSTs to /agent/turn-stream and yields NDJSON frames as
// {type:"chunk",text} or {type:"final",result}. The bridge consumes these to
// fire ElevenLabs TTS per sentence with request stitching, and to know when
// the LLM is done so persistence can happen via the legacy /agent/turn route
// with `injectedReply` set.
type AgentTurnResult = {
  intent: "interested" | "not_interested" | "busy" | "symptom" | "unclear";
  condition: string | null;
  suggested_doctor_id: string | null;
  appointment_iso: string | null;
  callback_requested: boolean;
  callback_time: string | null;
  agent_reply: string;
  end_call: boolean;
};
type StreamFrame =
  | { type: "chunk"; text: string }
  | { type: "final"; result: AgentTurnResult }
  | { type: "error"; message: string };

async function* fetchAgentReplyStreaming(
  callId: string,
  utterance: string,
  isFirstTurn: boolean,
): AsyncGenerator<StreamFrame, void, void> {
  const url = `${process.env.LOVABLE_BASE_URL}/api/public/agent/turn-stream`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-bridge-secret": process.env.BRIDGE_SHARED_SECRET ?? "",
  };
  if (AGENT_FAST_FIRST_SENTENCE) headers["x-agent-fast-first"] = "1";
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ callId, utterance, isFirstTurn }),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    console.error(`[plivo/agent.stream] ${url} → ${res.status}: ${body.slice(0, 200)}`);
    throw new Error(`agent/turn-stream ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line) as StreamFrame;
      } catch {
        console.error("[plivo/agent.stream] bad ndjson line:", line.slice(0, 120));
      }
    }
  }
  if (buf.trim()) {
    try {
      yield JSON.parse(buf) as StreamFrame;
    } catch {}
  }
}

// Persist the streamed reply by calling the legacy turn endpoint with
// `injectedReply`. This runs all fast-paths + transcript writes + mirroring
// without re-invoking the LLM. Best-effort; never throws into the call path.
async function persistInjectedReply(
  callId: string,
  utterance: string,
  isFirstTurn: boolean,
  result: AgentTurnResult,
): Promise<void> {
  try {
    const url = `${process.env.LOVABLE_BASE_URL}/api/public/agent/turn`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-secret": process.env.BRIDGE_SHARED_SECRET ?? "",
      },
      body: JSON.stringify({ callId, utterance, isFirstTurn, injectedReply: result }),
    });
    if (!res.ok) {
      console.error(`[plivo/agent.persist] ${url} → ${res.status}`);
    }
  } catch (e) {
    console.error(`[plivo/agent.persist] failed: ${e instanceof Error ? e.message : e}`);
  }
}

// Fire-and-forget recording of patient utterances that the bridge dropped
// from the LLM loop (turn-in-flight or post-playout guard). Keeps
// calls.transcript complete for human review without affecting turn-taking.
async function appendDroppedPatientLine(
  callId: string,
  text: string,
  droppedReason: "turn_in_flight" | "post_playout_guard",
) {
  try {
    const res = await fetch(`${process.env.LOVABLE_BASE_URL}/api/public/agent/transcript-append`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-secret": process.env.BRIDGE_SHARED_SECRET ?? "",
      },
      body: JSON.stringify({ callId, role: "patient", text, dropped_reason: droppedReason }),
    });
    if (!res.ok) {
      console.warn(`[plivo/transcript-append] ${res.status}: ${await res.text().catch(() => "")}`);
    }
  } catch (e) {
    console.warn(`[plivo/transcript-append] failed: ${e instanceof Error ? e.message : e}`);
  }
}

async function fetchAgentGreeting(callId: string) {
  const res = await fetch(`${process.env.LOVABLE_BASE_URL}/api/public/agent/greeting`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bridge-secret": process.env.BRIDGE_SHARED_SECRET ?? "",
    },
    body: JSON.stringify({ callId }),
  });
  if (!res.ok) {
    throw new Error(`agent/greeting ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as {
    agent_reply: string;
    greeting_segments?: string[];
    end_call: boolean;
    play_ring?: boolean;
    use_case?: string;
  };
}

async function notifyBridgeEnd(
  callId: string,
  reason: "stream_closed" | "agent_end_call" | "watchdog" | "silence_timeout",
  answered: boolean,
  hadPatientTurn: boolean,
  durationSeconds: number,
) {
  const res = await fetch(`${process.env.LOVABLE_BASE_URL}/api/public/bridge/end`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bridge-secret": process.env.BRIDGE_SHARED_SECRET ?? "",
    },
    body: JSON.stringify({
      callId,
      reason,
      answered,
      had_patient_turn: hadPatientTurn,
      duration_seconds: durationSeconds,
    }),
  });
  console.log(`[plivo/bridge-end] -> ${res.status}`);
}

// =============================================================
// Instant prelude streamer (mu-law 8kHz, paced at 20ms / 160 bytes)
// Reuses the same pre-rendered "namaste" buffer that the Twilio path uses.
// =============================================================
async function streamPreludeToPlivo(plivoWs: WebSocket, streamId: string | null, preludeUlaw: Buffer) {
  void streamId;
  const FRAME = 160;
  let nextSendAt = Date.now();
  let off = 0;
  let sent = 0;
  const t0 = Date.now();
  while (off + FRAME <= preludeUlaw.length) {
    if (plivoWs.readyState !== WebSocket.OPEN) return;
    const frame = preludeUlaw.subarray(off, off + FRAME);
    off += FRAME;
    const wait = nextSendAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    nextSendAt = Math.max(nextSendAt + 20, Date.now());
    plivoWs.send(
      JSON.stringify({
        event: "playAudio",
        media: {
          contentType: "audio/x-mulaw",
          sampleRate: 8000,
          payload: frame.toString("base64"),
        },
      }),
    );
    sent++;
  }
  console.log(`[plivo/prelude] sent ${sent} frames (~${sent * 20}ms) in ${Date.now() - t0}ms`);
}

// =============================================================
// Prefetched ElevenLabs TTS for Plivo (overlap with prelude playback)
// Fires the request immediately and buffers bytes in the background while the
// caller plays the prelude. Returns a `drain` that flushes bytes paced at
// real time (20ms/frame) into Plivo as `playAudio` events.
// =============================================================
type PlivoTtsHandle = {
  bufferedBytes: number;
  firstByteMs: number | null;
  drain: (plivoWs: WebSocket, streamId: string | null) => Promise<void>;
};

function prefetchPlivoTtsStream(
  text: string,
  tCallStart: number,
  opts: { onFirstByte?: (ms: number) => void } = {},
): Promise<PlivoTtsHandle> {
  const noop: PlivoTtsHandle = { bufferedBytes: 0, firstByteMs: null, drain: async () => {} };
  if (!text || !text.trim()) return Promise.resolve(noop);

  const tFetchStart = Date.now();
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream` +
    `?output_format=ulaw_8000&optimize_streaming_latency=${ELEVENLABS_OPTIMIZE_LATENCY}`;

  return fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": process.env.ELEVENLABS_API_KEY ?? "",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: normalizeForTts(text),
      model_id: ELEVENLABS_TTS_MODEL,
      voice_settings: PLIVO_VOICE_SETTINGS,
    }),
  }).then(async (ttsRes) => {
    if (!ttsRes.ok || !ttsRes.body) {
      const errBody = await ttsRes.text().catch(() => "");
      console.error(`[plivo/tts.prefetch] ${ttsRes.status}: ${errBody.slice(0, 200)}`);
      throw new Error(`TTS ${ttsRes.status}`);
    }

    const reader = ttsRes.body.getReader();
    const buffered: Buffer[] = [];
    let bufferedBytes = 0;
    let firstByteAt = 0;
    let streamDone = false;

    const pump = (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!firstByteAt) {
            firstByteAt = Date.now();
            console.log(
              `[plivo/tts.prefetch] first byte +${firstByteAt - tCallStart}ms (fetch ${firstByteAt - tFetchStart}ms)`,
            );
            opts.onFirstByte?.(firstByteAt - tFetchStart);
          }
          const buf = Buffer.from(value);
          buffered.push(buf);
          bufferedBytes += buf.length;
        }
      } finally {
        streamDone = true;
      }
    })();

    const handle: PlivoTtsHandle = {
      get bufferedBytes() {
        return bufferedBytes;
      },
      get firstByteMs() {
        return firstByteAt ? firstByteAt - tFetchStart : null;
      },
      drain: async (plivoWs: WebSocket, streamId: string | null) => {
        void streamId;
        const FRAME = 160;
        let leftover = Buffer.alloc(0);
        let totalSent = 0;
        let nextSendAt = Date.now();

        const consumeBuffered = () => {
          if (buffered.length === 0) return;
          const chunks = buffered.splice(0, buffered.length);
          leftover = leftover.length ? Buffer.concat([leftover, ...chunks]) : Buffer.concat(chunks);
        };

        const flushFrames = async (final: boolean) => {
          while (leftover.length >= FRAME) {
            if (plivoWs.readyState !== WebSocket.OPEN) return;
            const chunk = leftover.subarray(0, FRAME);
            leftover = leftover.subarray(FRAME);
            const wait = nextSendAt - Date.now();
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
            nextSendAt = Math.max(nextSendAt + 20, Date.now());
            plivoWs.send(
              JSON.stringify({
                event: "playAudio",
                media: {
                  contentType: "audio/x-mulaw",
                  sampleRate: 8000,
                  payload: chunk.toString("base64"),
                },
              }),
            );
            totalSent += FRAME;
          }
          if (final && leftover.length > 0 && plivoWs.readyState === WebSocket.OPEN) {
            const padded = Buffer.concat([leftover, Buffer.alloc(FRAME - leftover.length, 0xff)]);
            const wait = nextSendAt - Date.now();
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
            plivoWs.send(
              JSON.stringify({
                event: "playAudio",
                media: {
                  contentType: "audio/x-mulaw",
                  sampleRate: 8000,
                  payload: padded.toString("base64"),
                },
              }),
            );
            totalSent += FRAME;
            leftover = Buffer.alloc(0);
          }
        };

        // Drain everything already buffered, then keep flushing as new bytes arrive.
        while (!streamDone) {
          consumeBuffered();
          await flushFrames(false);
          if (leftover.length < FRAME && !streamDone) {
            await new Promise((r) => setTimeout(r, 10));
          }
        }
        consumeBuffered();
        await flushFrames(true);
        await pump;
        console.log(`[plivo/tts.prefetch] drained ${totalSent}b (~${(totalSent / 8000).toFixed(2)}s)`);
      },
    };

    return handle;
  });
}

// =============================================================
// Scribe v2 Realtime (ElevenLabs streaming STT) for Plivo
// Mirrors the Twilio bridge's openScribe(): one WS per call, server-side
// VAD, ulaw_8000 input. Returns the WS so the caller can forward audio.
//   onCommitted: called with finalized utterance (drives the agent turn)
//   onPartial:   called whenever Scribe emits a partial — used for barge-in
// =============================================================
async function openScribe(
  onCommitted: (text: string) => void,
  onPartial?: (text: string, confidence: number | null) => void,
): Promise<WebSocket> {
  const url =
    `wss://api.elevenlabs.io/v1/speech-to-text/realtime?` +
    `model_id=scribe_v2_realtime&` +
    `audio_format=ulaw_8000&` +
    `commit_strategy=vad&` +
    `vad_silence_threshold_secs=${SCRIBE_VAD_SILENCE_SECS}&` +
    `language_code=${ELEVENLABS_STT_LANGUAGE}`;

  const ws = new WebSocket(url, {
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY ?? "" },
  });

  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      ws.off("error", onErr);
      resolve();
    };
    const onErr = (e: Error) => {
      ws.off("open", onOpen);
      reject(e);
    };
    ws.once("open", onOpen);
    ws.once("error", onErr);
  });
  console.log("[plivo/scribe] ws connected");

  let lastPartialLogAt = 0;

  // Extract a partial confidence in [0,1] from a Scribe partial_transcript
  // message. Scribe v2 realtime exposes per-word confidence under
  // alternatives[0].words[].confidence and (sometimes) a top-level
  // confidence. We average per-word when present, otherwise fall back to
  // the top-level number, otherwise null (caller treats as "unknown").
  function extractConfidence(msg: any): number | null {
    const top =
      typeof msg?.confidence === "number"
        ? msg.confidence
        : typeof msg?.partial_transcript?.confidence === "number"
          ? msg.partial_transcript.confidence
          : null;
    const alts = msg?.alternatives ?? msg?.partial_transcript?.alternatives;
    const words = Array.isArray(alts) && alts[0]?.words ? alts[0].words : null;
    if (Array.isArray(words) && words.length) {
      const nums = words
        .map((w: any) => (typeof w?.confidence === "number" ? w.confidence : null))
        .filter((n: number | null): n is number => n !== null);
      if (nums.length) return nums.reduce((a, b) => a + b, 0) / nums.length;
    }
    return top;
  }

  ws.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const kind: string | undefined = msg?.message_type ?? msg?.type;

    if (kind === "session_started") {
      console.log("[plivo/scribe] session_started");
      return;
    }
    if (kind === "partial_transcript") {
      const text = msg?.text ?? msg?.partial_transcript?.text;
      if (text) {
        const conf = extractConfidence(msg);
        if (Date.now() - lastPartialLogAt > 1500) {
          lastPartialLogAt = Date.now();
          console.log(
            `[plivo/scribe] partial: "${String(text).slice(0, 80)}" conf=${conf == null ? "?" : conf.toFixed(2)}`,
          );
        }
        onPartial?.(String(text), conf);
      }
      return;
    }
    if (kind === "committed_transcript" || kind === "committed_transcript_with_timestamps") {
      const text = msg?.text ?? msg?.committed_transcript?.text ?? msg?.committed_transcript_with_timestamps?.text;
      if (text && typeof text === "string" && text.trim()) {
        console.log(`[plivo/scribe] committed: "${text.slice(0, 100)}"`);
        onCommitted(text.trim());
      }
      return;
    }
    if (kind === "error" || (typeof kind === "string" && kind.includes("error"))) {
      console.error("[plivo/scribe] error event:", JSON.stringify(msg).slice(0, 400));
      return;
    }
  });

  ws.on("close", () => console.log("[plivo/scribe] closed"));
  ws.on("error", (e) => console.error("[plivo/scribe] error", e));

  return ws;
}

// (Filler word helpers removed: standalone "जी..." between user utterance
// and the real reply felt like an interruption — two agent voices back to
// back. With Phase 1+2 latency work, the natural ~700–900ms silence reads
// as "thinking" instead. If a verbal acknowledgment is desired, the LLM
// prompt should weave it into the reply itself so it streams as one voice.)

// streamRingUntilPlivo: paced 20ms μ-law ringback frames, exits early when
// `stopSignal` resolves. Inbound-only ringback that masks greeting-fetch
// latency without ever delaying the actual greeting.
async function streamRingUntilPlivo(
  plivoWs: WebSocket,
  streamId: string | null,
  buf: Buffer,
  stopSignal: Promise<void>,
  tCallStart: number,
) {
  void streamId;
  console.log(`[plivo/ring] start +${Date.now() - tCallStart}ms maxMs=${((buf.length / 8000) * 1000) | 0}`);
  const FRAME = 160;
  let nextSendAt = Date.now();
  let sent = 0;
  let stopped = false;
  let stopReason: "greeting_resolved" | "max_ms" | "ws_closed" = "max_ms";
  void stopSignal.then(() => {
    stopped = true;
    stopReason = "greeting_resolved";
  });
  for (let off = 0; off + FRAME <= buf.length; off += FRAME) {
    if (plivoWs.readyState !== WebSocket.OPEN) {
      stopReason = "ws_closed";
      break;
    }
    if (stopped) break;
    const wait = nextSendAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    nextSendAt = Math.max(nextSendAt + 20, Date.now());
    plivoWs.send(
      JSON.stringify({
        event: "playAudio",
        media: {
          contentType: "audio/x-mulaw",
          sampleRate: 8000,
          payload: buf.subarray(off, off + FRAME).toString("base64"),
        },
      }),
    );
    sent++;
  }
  console.log(`[plivo/ring] stop  +${Date.now() - tCallStart}ms reason=${stopReason} frames=${sent} (${sent * 20}ms)`);
}
