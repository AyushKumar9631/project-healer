/**
 * Lovable Twilio Bridge
 * --------------------------------------------------------------
 * Bridges three connections per call:
 *   1. Twilio Media Stream WebSocket (μ-law 8kHz, 20ms frames)
 *   2. ElevenLabs Scribe v2 Realtime WebSocket (STT)
 *   3. Lovable agent HTTPS endpoint (per finalized utterance)
 *      → returns text → ElevenLabs TTS HTTP (μ-law 8kHz) → Twilio
 *
 * Env vars required:
 *   LOVABLE_BASE_URL          e.g. https://hospitalker-ai.lovable.app
 *   BRIDGE_SHARED_SECRET      shared with Lovable
 *   ELEVENLABS_API_KEY        for Scribe + TTS
 *   PORT                      defaults to 8080
 */

import { createServer } from "http";
import { readFileSync } from "fs";
import { resolve as pathResolve, dirname } from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import { attachPlivo, plivoConfigStatus } from "./plivo.js";
import { normalizeForTts } from "./ttsNormalize.js";
import { buildRingBuffers } from "./ringback.js";
import { TimingBuffer } from "./timing.js";
import {
  speculativeEnabled,
  startSpeculativeTurn,
  resolveSpeculative,
  type SpeculativeFrame,
} from "./speculative.js";

// SAFETY NET: without these, any unhandled promise rejection or uncaught
// synchronous throw anywhere in the process (e.g. a bug in one call's turn
// handling) terminates the entire Node process by default — instantly
// dropping every other live call's WebSocket too. This is what caused the
// "call cuts right after the agent replies, every time" bug: a
// ReferenceError on an undeclared variable inside handleUtterance's
// turnInFlight.finally() crashed the whole process on every turn. Logging
// instead of crashing keeps a single bad turn from taking down all calls.
process.on("unhandledRejection", (reason) => {
  console.error("[process] unhandledRejection:", reason instanceof Error ? reason.stack ?? reason.message : reason);
});
process.on("uncaughtException", (err) => {
  console.error("[process] uncaughtException:", err instanceof Error ? err.stack ?? err.message : err);
});

// Ringback (μ-law 8kHz). Inbound calls only — gated synchronously on the
// `direction=inbound` WebSocket start parameter. We prefer a real
// pre-recorded asset hosted in Supabase Storage (set via RING_PRELUDE_URL_ULAW)
// and fall back to the in-memory synthesised ring if the asset can't be
// fetched. The ring runs in PARALLEL with the greeting fetch so it never
// adds latency to the actual greeting.
const RING_SYNTH = buildRingBuffers();
let RING_ULAW: Buffer = RING_SYNTH.ulaw;
let RING_SOURCE: "storage" | "synth" = "synth";
console.log(
  `[ring] synthesised fallback ${RING_ULAW.length}b μ-law (~${(RING_ULAW.length / 8000).toFixed(2)}s, style=${RING_SYNTH.style})`,
);
const RING_PRELUDE_URL_ULAW = process.env.RING_PRELUDE_URL_ULAW?.trim() || "";

async function loadRingFromUrl(): Promise<void> {
  if (!RING_PRELUDE_URL_ULAW) {
    console.log("[ring] RING_PRELUDE_URL_ULAW not set — using synth ringback");
    return;
  }
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(RING_PRELUDE_URL_ULAW);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1600) throw new Error(`ring too small: ${buf.length} bytes`);
      if (buf.length % 160 !== 0) throw new Error(`ring not 160-byte-frame-aligned: ${buf.length}`);
      RING_ULAW = buf;
      RING_SOURCE = "storage";
      console.log(
        `[ring] fetched ${buf.length}b (~${(buf.length / 8000).toFixed(2)}s) from storage (attempt ${attempt})`,
      );
      return;
    } catch (e) {
      console.error(`[ring] url attempt ${attempt} failed:`, e instanceof Error ? e.message : e);
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  console.warn("[ring] storage fetch failed — keeping synth fallback");
}

const PORT = Number(process.env.PORT ?? 8080);
const __dirname = dirname(fileURLToPath(import.meta.url));
const LOVABLE_BASE_URL = required("LOVABLE_BASE_URL");
const BRIDGE_SHARED_SECRET = required("BRIDGE_SHARED_SECRET");
const ELEVENLABS_API_KEY = required("ELEVENLABS_API_KEY");
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? "Ms9OTvWb99V6DwRHZn6q";
const ELEVENLABS_STT_LANGUAGE = process.env.ELEVENLABS_STT_LANGUAGE ?? "hin";
// Scribe end-of-utterance silence threshold (seconds). Default preserves
// existing production value (0.8s). Lower values (e.g. 0.5–0.7) cut the
// VAD tail and shave 200–500ms off every patient turn but risk false
// commits. Tune via env on canary numbers first; never hard-code below 0.4.
const SCRIBE_VAD_SILENCE_SECS = (() => {
  const raw = process.env.STT_SILENCE_SECS;
  if (!raw) return 0.3;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0.2 || n > 3) return 0.4;
  return n;
})();

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

// Pre-rendered "namaste" prelude (μ-law 8kHz, raw bytes).
// Loaded SYNCHRONOUSLY from disk at boot — zero network on the hot path,
// and the HTTP server is gated on this so calls never land prelude-less.
// Falls back to HELLO_PRELUDE_URL only if the embedded asset is missing.
const HELLO_PRELUDE_URL = process.env.HELLO_PRELUDE_URL?.trim() || "";
const FOLLOWUP_PRELUDE_URL = process.env.FOLLOWUP_PRELUDE_URL?.trim() || "";
const CALLBACK_ASK_PRELUDE_URL = process.env.CALLBACK_ASK_PRELUDE_URL?.trim() || "";
const LOCAL_PRELUDE_PATH = pathResolve(__dirname, "assets", "namaste.ulaw");
let PRELUDE_ULAW: Buffer | null = null;
let FOLLOWUP_ULAW: Buffer | null = null;
let CALLBACK_ASK_ULAW: Buffer | null = null;

function loadPreludeFromDisk(): Buffer | null {
  try {
    const buf = readFileSync(LOCAL_PRELUDE_PATH);
    if (buf.length < 800) {
      console.error(`[prelude] disk file too small: ${buf.length} bytes`);
      return null;
    }
    console.log(
      `[prelude] loaded ${buf.length} bytes (~${(buf.length / 8000).toFixed(2)}s) from disk: ${LOCAL_PRELUDE_PATH}`,
    );
    return buf;
  } catch (e) {
    console.error(
      `[prelude] disk load failed (${LOCAL_PRELUDE_PATH}):`,
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

async function loadPreludeFromUrl(): Promise<Buffer | null> {
  if (!HELLO_PRELUDE_URL) return null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(HELLO_PRELUDE_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 800) throw new Error(`prelude too small: ${buf.length} bytes`);
      console.log(
        `[prelude] fetched ${buf.length} bytes from ${HELLO_PRELUDE_URL} (attempt ${attempt})`,
      );
      return buf;
    } catch (e) {
      console.error(
        `[prelude] url attempt ${attempt} failed:`,
        e instanceof Error ? e.message : e,
      );
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  return null;
}

async function initPrelude(): Promise<void> {
  PRELUDE_ULAW = loadPreludeFromDisk();
  if (!PRELUDE_ULAW) {
    console.warn("[prelude] disk asset missing, falling back to HELLO_PRELUDE_URL");
    PRELUDE_ULAW = await loadPreludeFromUrl();
  }
  if (!PRELUDE_ULAW) {
    console.error("[prelude] NO PRELUDE AVAILABLE — calls will skip the instant hello");
  }

  // Cached BP/Glucose follow-up. Optional; if missing the bridge falls back
  // to live ElevenLabs TTS (slower but still correct). Same retry policy
  // as the hello prelude.
  if (FOLLOWUP_PRELUDE_URL) {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const res = await fetch(FOLLOWUP_PRELUDE_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 800) throw new Error(`followup too small: ${buf.length} bytes`);
        FOLLOWUP_ULAW = buf;
        console.log(
          `[followup] fetched ${buf.length} bytes (~${(buf.length / 8000).toFixed(2)}s) from ${FOLLOWUP_PRELUDE_URL} (attempt ${attempt})`,
        );
        break;
      } catch (e) {
        console.error(
          `[followup] url attempt ${attempt} failed:`,
          e instanceof Error ? e.message : e,
        );
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
    if (!FOLLOWUP_ULAW) {
      console.warn("[followup] NO CACHED FOLLOWUP — bridge will use live TTS for it");
    }
  } else {
    console.warn(
      "[followup] FOLLOWUP_PRELUDE_URL not set — using live TTS (slower). Generate via /api/public/admin/generate-followup and set the env var.",
    );
  }

  // Pre-recorded ringback. Non-fatal if missing; synth fallback is in place.
  await loadRingFromUrl();

  // Cached negative-consent callback-time ask. Same retry/sanity policy.
  if (CALLBACK_ASK_PRELUDE_URL) {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const res = await fetch(CALLBACK_ASK_PRELUDE_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 800) throw new Error(`callback-ask too small: ${buf.length} bytes`);
        CALLBACK_ASK_ULAW = buf;
        console.log(
          `[callback-ask] fetched ${buf.length} bytes (~${(buf.length / 8000).toFixed(2)}s) from ${CALLBACK_ASK_PRELUDE_URL} (attempt ${attempt})`,
        );
        break;
      } catch (e) {
        console.error(
          `[callback-ask] url attempt ${attempt} failed:`,
          e instanceof Error ? e.message : e,
        );
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
    if (!CALLBACK_ASK_ULAW) {
      console.warn("[callback-ask] NO CACHED CLIP — bridge will use live TTS for it");
    }
  } else {
    console.warn(
      "[callback-ask] CALLBACK_ASK_PRELUDE_URL not set — using live TTS. Generate via /api/public/admin/generate-callback-ask and set the env var.",
    );
  }
}

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    // Healthcheck only returns 200 once prelude is loaded so Railway holds
    // traffic until the bridge is truly ready. Plivo path doesn't need the
    // prelude — Sarvam TTS streams the greeting directly — but the shared
    // service is gated on Twilio prelude readiness intentionally so a single
    // /health reflects "everything is ready".
    if (PRELUDE_ULAW) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(
        `ok prelude=${PRELUDE_ULAW.length}b paths=/twilio,/plivo`,
      );
    } else {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("prelude not loaded");
    }
    return;
  }
  if (req.url === "/health/plivo") {
    const cfg = plivoConfigStatus();
    const ready =
      cfg.LOVABLE_BASE_URL &&
      cfg.BRIDGE_SHARED_SECRET &&
      cfg.ELEVENLABS_API_KEY;
    res.writeHead(ready ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: ready, env: cfg, path: "/plivo" }));
    return;
  }
  res.writeHead(404);
  res.end();
});

// Twilio Media Streams WebSocket — noServer mode so we can route /twilio and
// /plivo from a single upgrade handler. Two `WebSocketServer({server, path})`
// instances on the same HTTP server race on the upgrade event and one of them
// destroys the socket (observed as HTTP 400 on /plivo).
const wss = new WebSocketServer({ noServer: true });
const plivoWss = new WebSocketServer({ noServer: true });

// Mount Plivo + ElevenLabs handler onto the externally-managed WSS.
// Pass a prelude getter so the Plivo path can play the same instant
// "namaste" hello as Twilio (parallel with the dynamic greeting fetch).
attachPlivo(
  httpServer,
  plivoWss,
  () => PRELUDE_ULAW,
  () => FOLLOWUP_ULAW,
  () => CALLBACK_ASK_ULAW,
  () => RING_ULAW,
);

httpServer.on("upgrade", (req, socket, head) => {
  const path = (req.url ?? "/").split("?")[0];
  console.log(
    `[upgrade] url=${req.url} host=${req.headers.host} ua=${(req.headers["user-agent"] ?? "").toString().slice(0, 60)}`,
  );
  if (path === "/twilio") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else if (path === "/plivo") {
    plivoWss.handleUpgrade(req, socket, head, (ws) => plivoWss.emit("connection", ws, req));
  } else {
    console.log(`[upgrade] reject unknown path=${path}`);
    socket.destroy();
  }
});

wss.on("connection", (twilioWs) => {
  const tWsOpen = Date.now();
  console.log("[twilio] connected");
  let streamSid: string | null = null;
  let callId: string | null = null;
  let scribeWs: WebSocket | null = null;
  let closed = false;
  let agentBusy = false;
  let answered = false; // becomes true after greeting playback completes
  let hadPatientTurn = false; // true once Scribe commits at least one utterance
  let endReason: "stream_closed" | "agent_end_call" | "watchdog" = "stream_closed";
  let mediaCount = 0;
  let scribeForwardedCount = 0;
  let lastCommittedAt = 0;
  let tStreamStart = 0; // set on first `start` event from Twilio
  let sawPartialThisTurn = false;
  // Speculative LLM (gated by AGENT_SPECULATIVE_ENABLED). When the patient
  // is mid-utterance and Scribe emits a partial of stable length, we kick
  // off a streaming agent turn early. On commit, if the commit text starts
  // with the partial we used, we drain the buffered frames; otherwise we
  // abort and run the normal turn.
  let speculative: import("./speculative.js").SpeculativeTurn | null = null;
  // Per-call latency buffer. tCallStart is set on `start` event.
  const timing = new TimingBuffer({
    callId: null,
    provider: "twilio",
    tCallStart: tWsOpen,
    lovableBaseUrl: LOVABLE_BASE_URL,
    bridgeSecret: BRIDGE_SHARED_SECRET,
  });
  timing.record("ws_open", { msSinceProcessUp: 0 });

  twilioWs.on("message", async (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.event === "start") {
      tStreamStart = Date.now();
      streamSid = msg.start.streamSid;
      const params = msg.start.customParameters ?? {};
      callId = params.callId ?? null;
      const isInbound =
        String(params.direction ?? "").toLowerCase() === "inbound";
      console.log("[twilio] start", {
        streamSid,
        callId,
        isInbound,
        msSinceWsOpen: tStreamStart - tWsOpen,
      });

      if (!callId) {
        console.error("[bridge] missing callId param");
        twilioWs.close();
        return;
      }
      timing.setCallId(callId);
      timing.setDirection(isInbound ? "inbound" : "outbound");
      timing.record("stream_start", {
        streamSid,
        msSinceWsOpen: tStreamStart - tWsOpen,
      });

      // 1) Open Scribe in parallel with greeting so STT is hot when patient replies.
      openScribe(
        async (utterance) => {
          if (closed || !callId) return;
          if (agentBusy) {
            console.log("[scribe] dropping utterance, agent busy:", utterance);
            return;
          }
          lastCommittedAt = Date.now();
          hadPatientTurn = true;
          console.log("[scribe] -> agent utterance:", utterance);
          timing.record("stt_committed", { utterance_len: utterance.length });
          sawPartialThisTurn = false;
          agentBusy = true;
          // Resolve speculation BEFORE doing anything: either reuse its
          // already-streaming frames, or abort + clear so the normal path
          // runs cleanly. Take the ref, then null out so partial-handler
          // doesn't see it as still active mid-turn.
          const spec = speculative;
          speculative = null;
          let specReuse: { reuse: boolean; reason: string } = { reuse: false, reason: "no_spec" };
          if (spec) {
            specReuse = resolveSpeculative(spec.partialUtterance, utterance);
            timing.record("speculative_resolved", {
              reuse: specReuse.reuse,
              reason: specReuse.reason,
            });
            if (!specReuse.reuse) {
              spec.abort();
            }
          }
          try {
            const tTurnStart = Date.now();
            timing.record("agent_turn_request", {
              utterance_len: utterance.length,
              speculative_reused: specReuse.reuse,
            });

            // AGENT_STREAM_ENABLED — sentence-streaming path. The agent
            // turn is streamed sentence-by-sentence; we TTS each chunk
            // using ElevenLabs request stitching so prosody is preserved
            // across chunks. Falls back to legacy non-streaming path on
            // any error.
            const useStream = process.env.AGENT_STREAM_ENABLED !== "0" || (spec && specReuse.reuse);
            let endCallFlag = false;
            let firstSentenceReplyLen = 0;
            if (useStream) {
              try {
                const previousChunks: string[] = [];
                let firstByteRecorded = false;
                let finalResult: AgentTurnResult | null = null;
                // Pick frame source: speculative buffered frames (already
                // in flight from the partial), or a fresh streaming call.
                const frameIter: AsyncIterable<{ type: string; text?: string; result?: AgentTurnResult; message?: string }> =
                  spec && specReuse.reuse
                    ? (spec.frames() as AsyncIterable<{ type: string; text?: string; result?: AgentTurnResult; message?: string }>)
                    : (fetchAgentReplyStreaming(callId, utterance, false) as unknown as AsyncIterable<{ type: string; text?: string; result?: AgentTurnResult; message?: string }>);
                for await (const frame of frameIter) {
                  if (frame.type === "chunk" && typeof frame.text === "string") {
                    if (!firstByteRecorded) {
                      timing.record(
                        "agent_turn_response",
                        {
                          first_chunk_len: frame.text.length,
                          speculative_reused: !!(spec && specReuse.reuse),
                        },
                        Date.now() - tTurnStart,
                      );
                      firstByteRecorded = true;
                      firstSentenceReplyLen = frame.text.length;
                    }
                    const prevText = previousChunks.slice(-2).join(" ");
                    await streamTtsToTwilio(twilioWs, streamSid!, frame.text, {
                      previousText: prevText || undefined,
                      onFirstByte: (ms) => {
                        if (previousChunks.length === 0) {
                          timing.record("reply_tts_first_byte", { fetch_ms: ms });
                        }
                      },
                    });
                    previousChunks.push(frame.text);
                  } else if (frame.type === "final" && frame.result) {
                    finalResult = frame.result;
                    endCallFlag = !!frame.result.end_call;
                  } else if (frame.type === "error") {
                    throw new Error(`stream error: ${frame.message}`);
                  }
                }
                if (finalResult) {
                  // Persist via legacy /agent/turn with injectedReply so
                  // all fast-paths/transcript writes/mirroring still run.
                  void persistInjectedReply(callId, utterance, false, finalResult);
                  timing.record(
                    "reply_tts_done",
                    { reply_len: finalResult.agent_reply.length, streamed: true },
                    Date.now() - tTurnStart,
                  );
                  console.log(
                    `[agent.stream] reply="${finalResult.agent_reply.slice(0, 100)}" end_call=${endCallFlag}`,
                  );
                } else {
                  console.warn("[agent.stream] no final frame received — falling back");
                  throw new Error("stream completed without final frame");
                }
              } catch (streamErr) {
                console.error(
                  "[agent.stream] failed, falling back to non-streaming:",
                  streamErr instanceof Error ? streamErr.message : streamErr,
                );
                const reply = await fetchAgentReply(callId, utterance, false);
                timing.record(
                  "agent_turn_response",
                  { reply_len: reply.agent_reply.length, end_call: reply.end_call, fallback: true },
                  Date.now() - tTurnStart,
                );
                const tReplyTtsStart = Date.now();
                await streamTtsToTwilio(twilioWs, streamSid!, reply.agent_reply, {
                  onFirstByte: (ms) => timing.record("reply_tts_first_byte", { fetch_ms: ms }),
                });
                timing.record(
                  "reply_tts_done",
                  { reply_len: reply.agent_reply.length },
                  Date.now() - tReplyTtsStart,
                );
                endCallFlag = reply.end_call;
              }
            } else {
              const reply = await fetchAgentReply(callId, utterance, false);
              timing.record(
                "agent_turn_response",
                { reply_len: reply.agent_reply.length, end_call: reply.end_call },
                Date.now() - tTurnStart,
              );
              console.log(`[agent] reply="${reply.agent_reply.slice(0, 100)}" end_call=${reply.end_call}`);
              const tReplyTtsStart = Date.now();
              await streamTtsToTwilio(twilioWs, streamSid!, reply.agent_reply, {
                onFirstByte: (ms) => timing.record("reply_tts_first_byte", { fetch_ms: ms }),
              });
              timing.record(
                "reply_tts_done",
                { reply_len: reply.agent_reply.length },
                Date.now() - tReplyTtsStart,
              );
              endCallFlag = reply.end_call;
            }
            void firstSentenceReplyLen;
            if (endCallFlag) {
              endReason = "agent_end_call";
              setTimeout(() => {
                try { twilioWs.close(); } catch {}
              }, 1500);
            }
          } catch (e) {
            console.error("[bridge] agent/tts error on patient turn:", e instanceof Error ? e.message : e);
            try {
              await streamTtsToTwilio(
                twilioWs,
                streamSid!,
                "माफ़ कीजिए, आवाज़ साफ़ नहीं आई। क्या आप दोहरा सकते हैं?",
              );
            } catch (e2) {
              console.error("[bridge] reprompt TTS failed:", e2);
            }
          } finally {
            agentBusy = false;
          }
        },
        (partialText) => {
          if (!partialText || !partialText.trim()) return;
          if (!sawPartialThisTurn) {
            sawPartialThisTurn = true;
            timing.record("stt_partial_first", { len: partialText.length });
          }
          // Speculative LLM: kick off the streaming agent turn early on a
          // long-enough partial so first-byte TTS is already in flight by
          // the time Scribe commits. Gated OFF by default. Only one
          // speculation per turn; never starts while agent is busy.
          if (
            speculativeEnabled() &&
            !speculative &&
            !agentBusy &&
            !!callId &&
            partialText.trim().length >= 8
          ) {
            const cid = callId;
            const partial = partialText.trim();
            timing.record("speculative_started", { partial_len: partial.length });
            speculative = startSpeculativeTurn({
              callId: cid,
              partialUtterance: partial,
              fetchStream: async function* (id, utt) {
                for await (const f of fetchAgentReplyStreaming(id, utt, false)) {
                  yield f as SpeculativeFrame;
                }
              },
            });
          }
        },
      )
        .then((ws) => {
          scribeWs = ws;
          console.log("[scribe] handle attached, ready to forward audio");
        })
        .catch((e) => {
          console.error("[bridge] failed to open Scribe:", e instanceof Error ? e.message : e);
        });

      // 2) Instant ringback (inbound only) + parallel greeting/TTS pipeline.
      //
      //    Timeline (target):
      //      t=0       if inbound: ringback streams immediately (zero gating)
      //      t=0       greeting text fetch fires in parallel
      //      t=~300ms  greeting text resolves → ElevenLabs TTS request fires
      //      t=R       ring stops at min(2000ms, when greeting+TTS handle ready)
      //      t=R       prelude plays (real-time paced)
      //      t=R+P     prefetched TTS bytes drain to Twilio
      //
      //    The ring acts as a true latency mask — never delays the greeting,
      //    never silent if the greeting fetch is slow.
      const tCallStart = Date.now();
      timing.setCallStart(tCallStart);
      try {
        agentBusy = true;

        // Phase A: greeting text + play_ring fetch (defensive fallback flag).
        let playRingFromGreeting = false;
        const tGreetingFetchStart = Date.now();
        timing.record("greeting_fetch_start");
        const greetingTextPromise: Promise<string> = (async () => {
          try {
            const greeting = await fetchAgentGreeting(callId);
            playRingFromGreeting = !!greeting.play_ring;
            timing.record(
              "greeting_fetch_done",
              { play_ring: playRingFromGreeting, reply_len: greeting.agent_reply.length },
              Date.now() - tGreetingFetchStart,
            );
            console.log(
              `[agent] first-turn greeting (+${Date.now() - tCallStart}ms) play_ring=${playRingFromGreeting}: "${greeting.agent_reply.slice(0, 100)}"`,
            );
            return greeting.agent_reply;
          } catch (e) {
            timing.record(
              "greeting_fetch_done",
              { error: e instanceof Error ? e.message : String(e), fallback: true },
              Date.now() - tGreetingFetchStart,
            );
            console.error(
              "[bridge] first-turn greeting failed, using local fallback:",
              e instanceof Error ? e.message : e,
            );
            return "मैं क्लिनिक से बोल रही हूँ। क्या आप अभी बात कर सकते हैं?";
          }
        })();

        // Phase B: as soon as greeting text resolves, fire ElevenLabs TTS
        // request and START BUFFERING its bytes — all while the ring is
        // still playing. ttsHandle resolves to a "drain me now" function.
        const ttsHandlePromise = greetingTextPromise.then((text) =>
          prefetchTtsStream(text, tCallStart, {
            onFirstByte: (ms) =>
              timing.record("greeting_tts_first_byte", { fetch_ms: ms }),
          }),
        );

        // Phase B0: inbound ringback runs in PARALLEL with the greeting/TTS
        // fetch. Decision is taken synchronously from the WS start param —
        // not gated on the greeting fetch. This is the silence fix.
        const shouldRing = isInbound; // single source of truth
        console.log(
          `[ring] decision inbound=${isInbound} source=${isInbound ? "ws_param" : "none"} src=${RING_SOURCE}`,
        );
        if (shouldRing) {
          // Stop the ring once both the greeting text AND its prefetched TTS
          // handle are ready, OR after the ring duration — whichever comes
          // first. This way: slow greeting → patient hears full ring (no
          // silence). Fast greeting → ring cuts early, prelude starts
          // immediately (no extra latency).
          const tRingStart = Date.now();
          timing.record("inbound_ring_start", { src: RING_SOURCE });
          const ringStopSignal = ttsHandlePromise.then(() => undefined).catch(() => undefined);
          await streamRingUntil(twilioWs, streamSid!, RING_ULAW, ringStopSignal, tCallStart);
          timing.record(
            "inbound_ring_stop",
            { src: RING_SOURCE },
            Date.now() - tRingStart,
          );
        }

        // Phase C: play the prelude (if available). Real-time paced.
        if (PRELUDE_ULAW) {
          console.log(`[timing] prelude=start +${Date.now() - tCallStart}ms`);
          await streamPreludeToTwilio(twilioWs, streamSid!, PRELUDE_ULAW);
          console.log(`[timing] prelude=done  +${Date.now() - tCallStart}ms`);
        } else {
          console.warn("[bridge] prelude=SKIPPED (PRELUDE_ULAW null)");
        }

        // Phase D: drain the (already-buffered) TTS into Twilio.
        const ttsHandle = await ttsHandlePromise;
        console.log(`[timing] tts=drain  +${Date.now() - tCallStart}ms (buffered=${ttsHandle.bufferedBytes}b)`);
        const tGreetingTtsStart = Date.now();
        await ttsHandle.drain(twilioWs, streamSid!);
        timing.record(
          "greeting_tts_done",
          { buffered_bytes: ttsHandle.bufferedBytes },
          Date.now() - tGreetingTtsStart,
        );
        console.log(`[timing] tts=done   +${Date.now() - tCallStart}ms`);

        // Defensive: if direction param was missing on the WS but the
        // greeting flagged play_ring=true, log it (we'd have skipped the ring
        // — operator should investigate the TwiML route).
        if (!isInbound && playRingFromGreeting) {
          console.warn(
            "[ring] WARN play_ring=true but direction param missing on WS start — TwiML may need redeploy",
          );
        }

        answered = true;
        lastCommittedAt = Date.now();
        console.log("[bridge] greeting playback complete, listening for patient");
      } catch (e) {
        console.error("[bridge] greeting + TTS pipeline failed:", e);
      } finally {
        agentBusy = false;
      }

      // Diagnostics: log forwarding stats every 10s
      const statsInterval = setInterval(() => {
        if (closed) {
          clearInterval(statsInterval);
          return;
        }
        const silenceSec = lastCommittedAt ? Math.round((Date.now() - lastCommittedAt) / 1000) : 0;
        console.log(
          `[bridge] stats mediaIn=${mediaCount} scribeOut=${scribeForwardedCount} scribeOpen=${scribeWs?.readyState === WebSocket.OPEN} silence=${silenceSec}s answered=${answered}`,
        );
      }, 10_000);

      // Watchdog: 3 minutes hard limit.
      setTimeout(() => {
        if (!closed) {
          console.log("[bridge] 180s watchdog firing, closing socket");
          endReason = "watchdog";
          try { twilioWs.close(); } catch {}
        }
      }, 180_000);
    } else if (msg.event === "media") {
      mediaCount++;
      if (scribeWs?.readyState === WebSocket.OPEN) {
        // ElevenLabs Realtime STT v2: send chunks with message_type discriminator.
        scribeWs.send(
          JSON.stringify({
            message_type: "input_audio_chunk",
            audio_base_64: msg.media.payload,
          }),
        );
        scribeForwardedCount++;
      }
    } else if (msg.event === "stop") {
      console.log(`[twilio] stop (mediaIn=${mediaCount} scribeOut=${scribeForwardedCount})`);
      await cleanup();
    }
  });

  twilioWs.on("close", () => {
    console.log(`[twilio] closed (mediaIn=${mediaCount} scribeOut=${scribeForwardedCount} answered=${answered})`);
    void cleanup();
  });

  twilioWs.on("error", (e) => console.error("[twilio] error", e));

  async function cleanup() {
    if (closed) return;
    closed = true;
    if (speculative) {
      try { speculative.abort(); } catch {}
      speculative = null;
    }
    if (scribeWs && scribeWs.readyState === WebSocket.OPEN) {
      try {
        scribeWs.close();
      } catch {}
    }
    // Always notify Lovable so it can pick the right terminal status
    // (declined / completed / etc.) — even when answered=false.
    if (!callId) return;
    const durSec = tStreamStart
      ? Math.max(0, Math.round((Date.now() - tStreamStart) / 1000))
      : 0;
    timing.record("bridge_end_request", {
      end_reason: endReason,
      answered,
      had_patient_turn: hadPatientTurn,
      duration_seconds: durSec,
    });
    timing.record("call_terminal", { end_reason: endReason });
    // CRITICAL: await both POSTs. The Worker may otherwise idle out before
    // TLS finishes, dropping the entire timing buffer.
    await Promise.allSettled([
      timing.flush().catch((e) =>
        console.error("[timing/flush] cleanup error:", e instanceof Error ? e.message : e),
      ),
      notifyBridgeEnd(callId, endReason, answered, hadPatientTurn, durSec).catch((e) =>
        console.error("[bridge/end] notify failed:", e instanceof Error ? e.message : e),
      ),
    ]);
  }
});

// Gate `listen()` on prelude readiness so Twilio calls never land on a
// half-initialised bridge with PRELUDE_ULAW=null. Railway healthcheck (which
// hits `/health`) will additionally hold traffic until 200 is returned.
initPrelude()
  .catch((e) => console.error("[prelude] init error:", e))
  .finally(() => {
    httpServer.listen(PORT, "0.0.0.0", () => {
      const cfg = plivoConfigStatus();
      console.log(
        `Bridge listening on 0.0.0.0:${PORT} paths=/twilio,/plivo prelude=${PRELUDE_ULAW ? `${PRELUDE_ULAW.length}b (used by both)` : "MISSING"}`,
      );
      console.log(
        `[plivo/env] LOVABLE_BASE_URL=${cfg.LOVABLE_BASE_URL ? "set" : "MISSING"} BRIDGE_SHARED_SECRET=${cfg.BRIDGE_SHARED_SECRET ? "set" : "MISSING"} ELEVENLABS_API_KEY=${cfg.ELEVENLABS_API_KEY ? "set" : "MISSING"}`,
      );
    });
  });

// ---------- Scribe v2 Realtime (ElevenLabs STT) ----------
// Docs: https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
//   Query: model_id, audio_format=ulaw_8000, commit_strategy=vad
//   Send : { message_type: "input_audio_chunk", audio_base_64 }
//   Recv : { message_type: "session_started" | "partial_transcript" | "committed_transcript" | "error", ... }
async function openScribe(
  onFinalUtterance: (text: string) => void,
  onPartial?: (text: string) => void,
): Promise<WebSocket> {
  const url =
    `wss://api.elevenlabs.io/v1/speech-to-text/realtime?` +
    `model_id=scribe_v2_realtime&` +
    `audio_format=ulaw_8000&` +
    `commit_strategy=vad&` +
    `vad_silence_threshold_secs=${SCRIBE_VAD_SILENCE_SECS}&` +
    `language_code=${ELEVENLABS_STT_LANGUAGE}`;

  const ws = new WebSocket(url, {
    headers: { "xi-api-key": ELEVENLABS_API_KEY },
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
  console.log("[scribe] ws connected");

  let lastPartialLogAt = 0;

  ws.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.error("[scribe] non-json message:", String(raw).slice(0, 200));
      return;
    }

    // Current API uses message_type as discriminator. Older builds may use type.
    const kind: string | undefined = msg?.message_type ?? msg?.type;

    if (kind === "session_started") {
      console.log("[scribe] session_started", JSON.stringify(msg?.config ?? {}).slice(0, 200));
      return;
    }

    if (kind === "partial_transcript") {
      const text = msg?.text ?? msg?.partial_transcript?.text;
      if (text) {
        if (Date.now() - lastPartialLogAt > 1500) {
          lastPartialLogAt = Date.now();
          console.log(`[scribe] partial: "${String(text).slice(0, 80)}"`);
        }
        onPartial?.(String(text));
      }
      return;
    }

    if (kind === "committed_transcript" || kind === "committed_transcript_with_timestamps") {
      const text =
        msg?.text ??
        msg?.committed_transcript?.text ??
        msg?.committed_transcript_with_timestamps?.text;
      if (text && typeof text === "string" && text.trim()) {
        console.log(`[scribe] committed: "${text.slice(0, 100)}"`);
        onFinalUtterance(text.trim());
      }
      return;
    }

    if (kind === "error" || (typeof kind === "string" && kind.includes("error"))) {
      console.error("[scribe] error event:", JSON.stringify(msg).slice(0, 400));
      return;
    }

    // Unknown shape — log first 200 chars to help diagnose protocol drift.
    console.log("[scribe] unhandled event:", JSON.stringify(msg).slice(0, 200));
  });

  ws.on("error", (e) => console.error("[scribe] ws error", e instanceof Error ? e.message : e));
  ws.on("close", (code, reason) =>
    console.log(`[scribe] closed code=${code} reason=${reason?.toString().slice(0, 200)}`),
  );

  return ws;
}

// ---------- Lovable agent HTTPS call ----------
async function fetchAgentReply(callId: string, utterance: string, isFirstTurn: boolean) {
  const url = `${LOVABLE_BASE_URL}/api/public/agent/turn`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bridge-secret": BRIDGE_SHARED_SECRET,
    },
    body: JSON.stringify({ callId, utterance, isFirstTurn }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[agent] ${url} → ${res.status}: ${body.slice(0, 200)}`);
    throw new Error(`agent/turn ${res.status}`);
  }
  return (await res.json()) as { agent_reply: string; end_call: boolean };
}

// Streaming variant — POSTs to /agent/turn-stream and yields NDJSON frames as
// {type:"chunk",text} or {type:"final",result}. The bridge consumes these to
// fire ElevenLabs TTS per sentence with request stitching, and to know when
// the LLM is done so persistence can happen via the legacy /agent/turn route
// with `injectedReply` set.
type StreamFrame =
  | { type: "chunk"; text: string }
  | { type: "final"; result: AgentTurnResult }
  | { type: "error"; message: string };

type AgentTurnResult = {
  intent: "interested" | "not_interested" | "busy" | "symptom" | "unclear" |
          "general_enquiry" | "appointment_request" | "follow_up_request" |
          "complaint" | "callback_request" | "report_enquiry" | "emergency";
  condition: string | null;
  suggested_doctor_id: string | null;
  appointment_iso: string | null;
  callback_requested: boolean;
  callback_time: string | null;
  agent_reply: string;
  end_call: boolean;
  // Inbound-reception fields — passed through so persistInjectedReply sends
  // them to /agent/turn and upsertAppointment receives the full context.
  caller_intent?: string;
  topic?: string | null;
  symptoms_mentioned?: string[];
  red_flag?: boolean;
  resolved?: boolean;
  // Already-loaded clinic KB (rendered text) from turn-stream's context load.
  // Forwarded as-is to /agent/turn via injectedReply so it can reuse it
  // instead of re-running loadClinicKnowledge for this same turn.
  clinic_kb_rendered?: string | null;
  // Already-loaded patient/clinic rows + identifiers from turn-stream's
  // context load. Forwarded as-is to /agent/turn via injectedReply so
  // getCallContext can seed itself instead of re-querying calls/patients/
  // clinics for this same turn.
  patient_snapshot?: {
    id: string;
    name: string;
    bp: string | null;
    blood_sugar: string | null;
    health_camp: string | null;
    age: number | null;
    gender: string | null;
    risk: string | null;
    phone: string;
  } | null;
  clinic_snapshot?: { id: string; name: string } | null;
  clinic_id?: string | null;
  patient_id?: string | null;
  campaign_id?: string | null;
};

async function* fetchAgentReplyStreaming(
  callId: string,
  utterance: string,
  isFirstTurn: boolean,
): AsyncGenerator<StreamFrame, void, void> {
  const url = `${LOVABLE_BASE_URL}/api/public/agent/turn-stream`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bridge-secret": BRIDGE_SHARED_SECRET,
    },
    body: JSON.stringify({ callId, utterance, isFirstTurn }),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    console.error(`[agent.stream] ${url} → ${res.status}: ${body.slice(0, 200)}`);
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
      } catch (e) {
        console.error("[agent.stream] bad ndjson line:", line.slice(0, 120));
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
    const url = `${LOVABLE_BASE_URL}/api/public/agent/turn`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-secret": BRIDGE_SHARED_SECRET,
      },
      body: JSON.stringify({
        callId,
        utterance,
        isFirstTurn,
        injectedReply: result,
      }),
    });
    if (!res.ok) {
      console.error(`[agent.persist] ${url} → ${res.status}`);
    }
  } catch (e) {
    console.error(`[agent.persist] failed: ${e instanceof Error ? e.message : e}`);
  }
}

// Lightweight first-turn greeting (templated, no LLM).
async function fetchAgentGreeting(callId: string) {
  const url = `${LOVABLE_BASE_URL}/api/public/agent/greeting`;
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bridge-secret": BRIDGE_SHARED_SECRET,
    },
    body: JSON.stringify({ callId }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[agent.greeting] ${url} → ${res.status}: ${body.slice(0, 200)}`);
    throw new Error(`agent/greeting ${res.status}`);
  }
  const json = (await res.json()) as {
    agent_reply: string;
    end_call: boolean;
    play_ring?: boolean;
    use_case?: string;
  };
  console.log(`[agent.greeting] ok in ${Date.now() - t0}ms play_ring=${!!json.play_ring} use_case=${json.use_case ?? "?"}`);
  return json;
}

// ---------- Bridge end-of-call sync ----------
async function notifyBridgeEnd(
  callId: string,
  reason: "stream_closed" | "agent_end_call" | "watchdog",
  answered: boolean,
  hadPatientTurn: boolean,
  durationSeconds: number,
) {
  const url = `${LOVABLE_BASE_URL}/api/public/bridge/end`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bridge-secret": BRIDGE_SHARED_SECRET,
    },
    body: JSON.stringify({
      callId,
      reason,
      answered,
      had_patient_turn: hadPatientTurn,
      duration_seconds: durationSeconds,
    }),
  });
  console.log(
    `[bridge/end] ${url} → ${res.status} reason=${reason} answered=${answered} hadPatientTurn=${hadPatientTurn} dur=${durationSeconds}s`,
  );
}

// ---------- TTS → Twilio (streaming) ----------
// Uses ElevenLabs /stream endpoint with optimize_streaming_latency=3 and
// forwards μ-law frames to Twilio as bytes arrive (instead of waiting for the
// full buffer). This typically cuts time-to-first-audio by 1–2s.
async function streamTtsToTwilio(
  twilioWs: WebSocket,
  streamSid: string,
  text: string,
  opts: {
    onFirstByte?: (ms: number) => void;
    previousText?: string;
    nextText?: string;
  } = {},
) {
  if (!text || !text.trim()) return;
  const t0 = Date.now();
  const ttsBody: Record<string, unknown> = {
    text: normalizeForTts(text),
    model_id: "eleven_turbo_v2_5",
    voice_settings: {
      stability: 0.55,
      similarity_boost: 0.8,
      style: 0.3,
      use_speaker_boost: true,
    },
  };
  // Request stitching for natural prosody across sentence chunks.
  if (opts.previousText) ttsBody.previous_text = opts.previousText;
  if (opts.nextText) ttsBody.next_text = opts.nextText;

  const ttsRes = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream?output_format=ulaw_8000&optimize_streaming_latency=3`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(ttsBody),
    },
  );
  if (!ttsRes.ok || !ttsRes.body) {
    const errBody = await ttsRes.text().catch(() => "");
    console.error(`[tts] ${ttsRes.status}: ${errBody.slice(0, 200)}`);
    throw new Error(`TTS ${ttsRes.status}`);
  }

  const FRAME = 160; // 20ms of μ-law @ 8kHz
  let leftover = Buffer.alloc(0);
  let totalBytes = 0;
  let firstByteAt = 0;

  const reader = ttsRes.body.getReader();
  // Pace frames at ~20ms each so Twilio plays them in real time.
  let nextSendAt = Date.now();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!firstByteAt) {
      firstByteAt = Date.now();
      console.log(`[tts] first byte in ${firstByteAt - t0}ms`);
      opts.onFirstByte?.(firstByteAt - t0);
    }
    if (twilioWs.readyState !== WebSocket.OPEN) return;

    const incoming = Buffer.from(value);
    totalBytes += incoming.length;
    leftover = leftover.length ? Buffer.concat([leftover, incoming]) : incoming;

    while (leftover.length >= FRAME) {
      const chunk = leftover.subarray(0, FRAME);
      leftover = leftover.subarray(FRAME);

      const wait = nextSendAt - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      nextSendAt = Math.max(nextSendAt + 20, Date.now());

      if (twilioWs.readyState !== WebSocket.OPEN) return;
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: chunk.toString("base64") },
        }),
      );
    }
  }

  // Flush any trailing partial frame (pad with μ-law silence 0xFF).
  if (leftover.length > 0 && twilioWs.readyState === WebSocket.OPEN) {
    const padded = Buffer.concat([leftover, Buffer.alloc(FRAME - leftover.length, 0xff)]);
    const wait = nextSendAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    twilioWs.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: padded.toString("base64") },
      }),
    );
  }

  console.log(`[tts] streamed ${totalBytes} bytes in ${Date.now() - t0}ms`);
  if (twilioWs.readyState === WebSocket.OPEN) {
    twilioWs.send(
      JSON.stringify({
        event: "mark",
        streamSid,
        mark: { name: `tts-${Date.now()}` },
      }),
    );
  }
}

// ---------- Prefetched TTS (overlap with prelude playback) ----------
// Fires the ElevenLabs TTS request and immediately starts buffering bytes in
// the background while the caller does something else (e.g. plays the
// prelude). Returns a `drain` function that paces the buffered + remaining
// bytes out to Twilio at real time. This eliminates the ~1.5–3s ElevenLabs
// TTFB gap that would otherwise sit between the prelude and the dynamic
// greeting.
type TtsHandle = {
  bufferedBytes: number;
  firstByteMs: number | null;
  drain: (twilioWs: WebSocket, streamSid: string) => Promise<void>;
};

function prefetchTtsStream(
  text: string,
  tCallStart: number,
  opts: { onFirstByte?: (ms: number) => void } = {},
): Promise<TtsHandle> {
  const noop: TtsHandle = { bufferedBytes: 0, firstByteMs: null, drain: async () => {} };
  if (!text || !text.trim()) return Promise.resolve(noop);

  const tFetchStart = Date.now();
  return fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream?output_format=ulaw_8000&optimize_streaming_latency=3`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: normalizeForTts(text),
        model_id: "eleven_turbo_v2_5",
        voice_settings: {
          stability: 0.55,
          similarity_boost: 0.8,
          style: 0.3,
          use_speaker_boost: true,
        },
      }),
    },
  ).then(async (ttsRes) => {
    if (!ttsRes.ok || !ttsRes.body) {
      const errBody = await ttsRes.text().catch(() => "");
      console.error(`[tts.prefetch] ${ttsRes.status}: ${errBody.slice(0, 200)}`);
      throw new Error(`TTS ${ttsRes.status}`);
    }
    const reader = ttsRes.body.getReader();
    const buffered: Buffer[] = [];
    let bufferedBytes = 0;
    let firstByteAt = 0;
    let streamDone = false;
    let streamErr: unknown = null;

    // Background pump: read as fast as possible into the in-memory buffer.
    const pump = (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!firstByteAt) {
            firstByteAt = Date.now();
            console.log(
              `[tts.prefetch] first byte +${firstByteAt - tCallStart}ms (fetch took ${firstByteAt - tFetchStart}ms)`,
            );
            opts.onFirstByte?.(firstByteAt - tFetchStart);
          }
          const buf = Buffer.from(value);
          buffered.push(buf);
          bufferedBytes += buf.length;
        }
      } catch (e) {
        streamErr = e;
      } finally {
        streamDone = true;
      }
    })();

    const handle: TtsHandle = {
      get bufferedBytes() {
        return bufferedBytes;
      },
      get firstByteMs() {
        return firstByteAt ? firstByteAt - tFetchStart : null;
      },
      drain: async (twilioWs: WebSocket, streamSid: string) => {
        const tDrainStart = Date.now();
        const FRAME = 160;
        let leftover = Buffer.alloc(0);
        let totalSent = 0;
        let nextSendAt = Date.now();

        // Helper: take everything currently buffered and append to leftover.
        const consumeBuffered = () => {
          if (buffered.length === 0) return;
          const chunks = buffered.splice(0, buffered.length);
          leftover = leftover.length
            ? Buffer.concat([leftover, ...chunks])
            : Buffer.concat(chunks);
        };

        const flushFrames = async (final: boolean) => {
          while (leftover.length >= FRAME) {
            if (twilioWs.readyState !== WebSocket.OPEN) return;
            const chunk = leftover.subarray(0, FRAME);
            leftover = leftover.subarray(FRAME);
            const wait = nextSendAt - Date.now();
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
            nextSendAt = Math.max(nextSendAt + 20, Date.now());
            twilioWs.send(
              JSON.stringify({
                event: "media",
                streamSid,
                media: { payload: chunk.toString("base64") },
              }),
            );
            totalSent += FRAME;
          }
          if (final && leftover.length > 0 && twilioWs.readyState === WebSocket.OPEN) {
            const padded = Buffer.concat([
              leftover,
              Buffer.alloc(FRAME - leftover.length, 0xff),
            ]);
            const wait = nextSendAt - Date.now();
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
            twilioWs.send(
              JSON.stringify({
                event: "media",
                streamSid,
                media: { payload: padded.toString("base64") },
              }),
            );
            totalSent += FRAME;
            leftover = Buffer.alloc(0);
          }
        };

        // Loop: drain buffered bytes, then await more from the pump.
        while (true) {
          consumeBuffered();
          await flushFrames(false);
          if (streamDone) break;
          // Wait briefly for more bytes to arrive from ElevenLabs.
          await new Promise((r) => setTimeout(r, 10));
        }
        // Final consume + flush after stream is done.
        consumeBuffered();
        await flushFrames(true);
        await pump.catch(() => {}); // ensure pump settled

        if (streamErr) {
          console.error(
            "[tts.prefetch] stream error:",
            streamErr instanceof Error ? streamErr.message : streamErr,
          );
        }
        console.log(
          `[tts.prefetch] drained ${totalSent} bytes in ${Date.now() - tDrainStart}ms`,
        );
        if (twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(
            JSON.stringify({
              event: "mark",
              streamSid,
              mark: { name: `tts-${Date.now()}` },
            }),
          );
        }
      },
    };
    return handle;
  });
}

// ---------- Prelude streaming (cached μ-law buffer → Twilio) ----------
// Plays a pre-rendered μ-law 8kHz buffer to Twilio in 20ms (160-byte) frames
// at real-time. Zero network on the hot path. Used for the instant "namaste"
// hello so the patient hears audio in <1s.
async function streamPreludeToTwilio(
  twilioWs: WebSocket,
  streamSid: string,
  buf: Buffer,
) {
  const t0 = Date.now();
  const FRAME = 160;
  let nextSendAt = Date.now();
  let sent = 0;

  for (let off = 0; off + FRAME <= buf.length; off += FRAME) {
    if (twilioWs.readyState !== WebSocket.OPEN) return;
    const wait = nextSendAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    nextSendAt = Math.max(nextSendAt + 20, Date.now());
    twilioWs.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: buf.subarray(off, off + FRAME).toString("base64") },
      }),
    );
    sent++;
  }
  console.log(`[prelude] streamed ${sent} frames (${sent * 20}ms) in ${Date.now() - t0}ms wall`);
}

// streamRingUntil: paced 20ms μ-law frames, exits early when `stopSignal`
// resolves. Used to mask greeting-fetch latency on inbound calls without
// adding any latency on the fast path.
async function streamRingUntil(
  twilioWs: WebSocket,
  streamSid: string,
  buf: Buffer,
  stopSignal: Promise<void>,
  tCallStart: number,
) {
  const t0 = Date.now();
  console.log(`[ring] start +${t0 - tCallStart}ms src=${RING_SOURCE} maxMs=${(buf.length / 8000) * 1000 | 0}`);
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
    if (twilioWs.readyState !== WebSocket.OPEN) {
      stopReason = "ws_closed";
      break;
    }
    if (stopped) break;
    const wait = nextSendAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    nextSendAt = Math.max(nextSendAt + 20, Date.now());
    twilioWs.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: buf.subarray(off, off + FRAME).toString("base64") },
      }),
    );
    sent++;
  }
  console.log(
    `[ring] stop  +${Date.now() - tCallStart}ms reason=${stopReason} frames=${sent} (${sent * 20}ms)`,
  );
}
