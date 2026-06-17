/**
 * Lovable Plivo + Sarvam Bridge
 * --------------------------------------------------------------
 * Per call, bridges:
 *   1. Plivo AudioStream WebSocket (PCM Lin16 8kHz, bidirectional)
 *   2. Sarvam Saaras STT (batch over VAD-segmented inbound audio)
 *   3. Lovable agent HTTPS endpoints (/api/public/agent/{greeting,turn})
 *      → reply text → Sarvam Bulbul v3 streaming TTS (MP3) → decoded
 *      → PCM 8kHz frames → Plivo
 *
 * Plivo AudioStream JSON protocol (incoming):
 *   {event:"start",  start:{streamId, callId, ...}, extra_headers:{...}}
 *   {event:"media",  media:{payload: <base64 PCM Lin16 8kHz>, ...}}
 *   {event:"stop"}
 * Outgoing (to play audio to caller):
 *   {event:"playAudio", media:{contentType:"audio/x-l16;rate=8000",
 *                              payload:<base64 PCM Lin16 8kHz>, sampleRate:8000}}
 */

import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { MPEGDecoder } from "mpg123-decoder";
import { buildRingBuffers } from "./ringback.js";
import { TimingBuffer } from "./timing.js";

// Ringback (PCM Lin16 8kHz). Inbound calls only — gated synchronously on
// the `direction=inbound` URL query param / x-direction extra header.
// Prefers a pre-recorded asset (RING_PRELUDE_URL_PCM16) and falls back
// to the in-memory synth.
const RING_SYNTH = buildRingBuffers();
let RING_PCM16: Buffer = RING_SYNTH.pcm16;
let RING_SOURCE: "storage" | "synth" = "synth";
console.log(
  `[ring] synthesised fallback ${RING_PCM16.length}b PCM16 (~${RING_SYNTH.durationMs}ms, style=${RING_SYNTH.style})`,
);
const RING_PRELUDE_URL_PCM16 = process.env.RING_PRELUDE_URL_PCM16?.trim() || "";

async function loadRingFromUrl(): Promise<void> {
  if (!RING_PRELUDE_URL_PCM16) {
    console.log("[ring] RING_PRELUDE_URL_PCM16 not set — using synth");
    return;
  }
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(RING_PRELUDE_URL_PCM16);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 3200) throw new Error(`ring too small: ${buf.length}`);
      if (buf.length % 320 !== 0) throw new Error(`ring not 320-byte-aligned: ${buf.length}`);
      RING_PCM16 = buf;
      RING_SOURCE = "storage";
      console.log(`[ring] fetched ${buf.length}b PCM16 from storage (attempt ${attempt})`);
      return;
    } catch (e) {
      console.error(`[ring] url attempt ${attempt} failed:`, e instanceof Error ? e.message : e);
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  console.warn("[ring] storage fetch failed — keeping synth fallback");
}
// Fire and forget at boot.
void loadRingFromUrl();

const PORT = Number(process.env.PORT ?? 8080);
const LOVABLE_BASE_URL = required("LOVABLE_BASE_URL");
const BRIDGE_SHARED_SECRET = required("BRIDGE_SHARED_SECRET");
const SARVAM_API_KEY = required("SARVAM_API_KEY");
const SARVAM_TTS_SPEAKER = process.env.SARVAM_TTS_SPEAKER ?? "anushka";
const SARVAM_TTS_MODEL = process.env.SARVAM_TTS_MODEL ?? "bulbul:v3";
const SARVAM_STT_MODEL = process.env.SARVAM_STT_MODEL ?? "saaras:v2.5";
const VAD_BASE_THRESHOLD = Number(process.env.VAD_BASE_THRESHOLD ?? 150);
const VAD_NOISE_MULTIPLIER = Number(process.env.VAD_NOISE_MULTIPLIER ?? 1.8);

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer, path: "/plivo" });

wss.on("connection", (plivoWs, req) => {
  const tWsOpen = Date.now();
  console.log("[plivo] connected", req.headers["x-call-id"] ?? "(no callId yet)");

  let streamId: string | null = null;
  // callId can arrive via the x-call-id extra header (set in voice XML) OR
  // via the WS upgrade URL query string (?callId=...), which is always
  // present even if the caller hangs up before Plivo sends the "start"
  // event — the header/start payload race the caller's early hangup.
  const urlCallId: string | null = (() => {
    try {
      const u = new URL(req.url ?? "/", "http://localhost");
      return u.searchParams.get("callId") || null;
    } catch {
      return null;
    }
  })();
  let callId: string | null = (req.headers["x-call-id"] as string | undefined) ?? urlCallId ?? null;
  // Direction from URL query string set by /api/public/plivo/voice for
  // inbound calls. Final answer also OR'd with start.event extra_headers.
  let isInbound = (() => {
    try {
      const u = new URL(req.url ?? "/", "http://localhost");
      return (u.searchParams.get("direction") ?? "").toLowerCase() === "inbound";
    } catch {
      return false;
    }
  })();
  let closed = false;
  let agentBusy = false;
  let answered = false;
  let hadPatientTurn = false;
  let endReason: "stream_closed" | "agent_end_call" | "watchdog" = "stream_closed";
  let tStreamStart = 0;
  const timing = new TimingBuffer({
    callId,
    provider: "plivo",
    direction: isInbound ? "inbound" : "outbound",
    tCallStart: tWsOpen,
    lovableBaseUrl: process.env.LOVABLE_BASE_URL ?? "",
    bridgeSecret: process.env.BRIDGE_SHARED_SECRET ?? "",
  });
  timing.record("ws_open");
  let sawPartialThisTurn = false;
  // VAD-segmenter: collect inbound PCM frames until we see ~700ms silence
  // after speech, then submit the buffered audio as one Saaras request.
  const vad = createVad({
    onUtterance: async (pcm16: Int16Array) => {
      if (closed || !callId || agentBusy) return;
      agentBusy = true;
      try {
        const text = await sarvamStt(pcm16, (ms) => timing.record("stt_partial_first", { stt_ms: ms }));
        if (!text || !text.trim()) {
          console.log("[stt] empty transcript, skip");
          return;
        }
        console.log(`[stt] -> "${text}"`);
        hadPatientTurn = true;
        timing.record("stt_committed", { utterance_len: text.length });
        sawPartialThisTurn = false;
        const tTurnStart = Date.now();
        timing.record("agent_turn_request", { utterance_len: text.length });
        const reply = await fetchAgentReply(callId, text, false);
        timing.record(
          "agent_turn_response",
          { reply_len: reply.agent_reply.length, end_call: reply.end_call },
          Date.now() - tTurnStart,
        );
        console.log(`[agent] reply="${reply.agent_reply.slice(0, 100)}" end=${reply.end_call}`);
        const tReplyTtsStart = Date.now();
        await streamSarvamTtsToPlivo(plivoWs, streamId, reply.agent_reply, (ms) =>
          timing.record("reply_tts_first_byte", { fetch_ms: ms }),
        );
        timing.record("reply_tts_done", { reply_len: reply.agent_reply.length }, Date.now() - tReplyTtsStart);
        if (reply.end_call) {
          endReason = "agent_end_call";
          setTimeout(() => {
            try {
              plivoWs.close();
            } catch {}
          }, 1500);
        }
      } catch (e) {
        console.error("[bridge] turn error:", e instanceof Error ? e.message : e);
      } finally {
        agentBusy = false;
      }
    },
  });
  void sawPartialThisTurn;

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
      callId = msg.start?.callId ?? msg.extra_headers?.["x-call-id"] ?? callId;
      // Direction can also arrive via extra_headers (string or object form).
      const ehDir = (() => {
        const eh = msg.extra_headers ?? msg.start?.extra_headers;
        if (!eh) return "";
        if (typeof eh === "object") {
          for (const [k, v] of Object.entries(eh as Record<string, unknown>)) {
            if (k.toLowerCase().endsWith("x-direction") && typeof v === "string") return v.toLowerCase();
          }
          return "";
        }
        if (typeof eh === "string") {
          const m = eh.match(/x-direction\s*[:=]\s*([A-Za-z_-]+)/i);
          return m ? m[1].toLowerCase() : "";
        }
        return "";
      })();
      if (ehDir === "inbound") isInbound = true;
      console.log("[plivo] start", { streamId, callId, isInbound, msSinceWsOpen: tStreamStart - tWsOpen });
      if (callId) timing.setCallId(callId);
      timing.setDirection(isInbound ? "inbound" : "outbound");
      timing.setCallStart(tStreamStart);
      timing.record("stream_start", { streamId, msSinceWsOpen: tStreamStart - tWsOpen });

      if (!callId) {
        console.error("[bridge] no callId");
        plivoWs.close();
        return;
      }

      // Greeting pipeline.
      agentBusy = true;
      const tCallStart = Date.now();
      const tGreetingFetchStart = Date.now();
      timing.record("greeting_fetch_start");
      const greetingPromise = fetchAgentGreeting(callId)
        .then((g) => {
          timing.record(
            "greeting_fetch_done",
            { play_ring: !!g.play_ring, reply_len: g.agent_reply.length },
            Date.now() - tGreetingFetchStart,
          );
          return g;
        })
        .catch((e) => {
          timing.record(
            "greeting_fetch_done",
            { error: e instanceof Error ? e.message : String(e), fallback: true },
            Date.now() - tGreetingFetchStart,
          );
          throw e;
        });
      try {
        if (isInbound) {
          console.log(`[ring] decision inbound=true src=${RING_SOURCE}`);
          const tRingStart = Date.now();
          timing.record("inbound_ring_start", { src: RING_SOURCE });
          const ringStop = greetingPromise.then(() => undefined).catch(() => undefined);
          await streamRingToPlivo(plivoWs, streamId, RING_PCM16, ringStop, tCallStart);
          timing.record("inbound_ring_stop", { src: RING_SOURCE }, Date.now() - tRingStart);
        }
        const greeting = await greetingPromise;
        console.log(`[agent] greeting play_ring=${!!greeting.play_ring} "${greeting.agent_reply.slice(0, 100)}"`);
        if (!isInbound && greeting.play_ring) {
          console.warn("[ring] WARN play_ring=true but direction missing on WS — XML may need redeploy");
        }
        const tGreetingTtsStart = Date.now();
        await streamSarvamTtsToPlivo(plivoWs, streamId, greeting.agent_reply, (ms) =>
          timing.record("greeting_tts_first_byte", { fetch_ms: ms }),
        );
        timing.record("greeting_tts_done", { reply_len: greeting.agent_reply.length }, Date.now() - tGreetingTtsStart);
        answered = true;
      } catch (e) {
        console.error("[bridge] greeting failed:", e instanceof Error ? e.message : e);
        try {
          await streamSarvamTtsToPlivo(plivoWs, streamId, "मैं क्लिनिक से बोल रही हूँ। क्या आप अभी बात कर सकते हैं?");
          answered = true;
        } catch {}
      } finally {
        agentBusy = false;
      }

      // 3-min watchdog
      setTimeout(() => {
        if (!closed) {
          endReason = "watchdog";
          try {
            plivoWs.close();
          } catch {}
        }
      }, 180_000);
    } else if (msg.event === "media") {
      // Plivo PCM Lin16 8kHz mono, base64 little-endian.
      const buf = Buffer.from(msg.media?.payload ?? "", "base64");
      if (buf.length === 0 || agentBusy) return;
      // Construct an Int16Array view (LE → host LE assumption is fine on x64/arm64).
      const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
      vad.push(pcm);
    } else if (msg.event === "stop") {
      console.log("[plivo] stop");
      cleanup();
    }
  });

  plivoWs.on("close", () => {
    console.log(`[plivo] closed answered=${answered} hadPatientTurn=${hadPatientTurn}`);
    cleanup();
  });
  plivoWs.on("error", (e) => console.error("[plivo] error", e));

  function cleanup() {
    if (closed) return;
    closed = true;
    const finalCallId = callId ?? urlCallId;
    if (finalCallId) {
      const dur = tStreamStart ? Math.max(0, Math.round((Date.now() - tStreamStart) / 1000)) : 0;
      timing.record("bridge_end_request", {
        end_reason: endReason,
        answered,
        had_patient_turn: hadPatientTurn,
        duration_seconds: dur,
      });
      timing.record("call_terminal", { end_reason: endReason });
      timing.flush().catch((e) => console.error("[timing/flush] cleanup error:", e instanceof Error ? e.message : e));
      notifyBridgeEnd(finalCallId, endReason, answered, hadPatientTurn, dur).catch((e) =>
        console.error("[bridge/end] notify failed:", e instanceof Error ? e.message : e),
      );
    }
  }
});

httpServer.listen(PORT, () => {
  console.log(`Plivo bridge listening on :${PORT}`);
});

// =============================================================
// VAD segmenter (energy-based, simple)
// =============================================================
type VadOpts = { onUtterance: (pcm: Int16Array) => void | Promise<void> };
function createVad(opts: VadOpts) {
  const SR = 8000;
  const FRAME_MS = 20;
  const FRAME_SAMPLES = (SR * FRAME_MS) / 1000; // 160
  const SILENCE_HANG_MS = 700; // commit after this much silence post-speech
  const MIN_SPEECH_MS = 250; // ignore blips
  const MAX_UTTERANCE_MS = 15_000;

  // Energy threshold (RMS of int16). ~500 corresponds roughly to quiet voice.
  // Adapts upward to room noise floor.
  let noiseFloor = 200;
  const buffers: Int16Array[] = [];
  let speaking = false;
  let speechSamples = 0;
  let silenceSamples = 0;
  let totalSamples = 0;

  function rms(frame: Int16Array): number {
    let s = 0;
    for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
    return Math.sqrt(s / frame.length);
  }

  function commit() {
    if (buffers.length === 0) return;
    const total = buffers.reduce((n, b) => n + b.length, 0);
    const out = new Int16Array(total);
    let off = 0;
    for (const b of buffers) {
      out.set(b, off);
      off += b.length;
    }
    buffers.length = 0;
    speaking = false;
    speechSamples = 0;
    silenceSamples = 0;
    totalSamples = 0;
    if ((out.length / SR) * 1000 >= MIN_SPEECH_MS) {
      Promise.resolve(opts.onUtterance(out)).catch(() => {});
    }
  }

  function push(pcm: Int16Array) {
    // Slice into 20ms frames (Plivo sends ~20ms but be defensive).
    let off = 0;
    while (off < pcm.length) {
      const take = Math.min(FRAME_SAMPLES, pcm.length - off);
      const frame = pcm.subarray(off, off + take);
      off += take;
      const e = rms(frame);
      const isSpeech = e > Math.max(400, noiseFloor * 2.5);
      if (!isSpeech) noiseFloor = noiseFloor * 0.995 + e * 0.005;

      if (speaking) {
        buffers.push(frame.slice());
        totalSamples += frame.length;
        if (isSpeech) {
          speechSamples += frame.length;
          silenceSamples = 0;
        } else {
          silenceSamples += frame.length;
          if ((silenceSamples / SR) * 1000 >= SILENCE_HANG_MS) commit();
        }
        if ((totalSamples / SR) * 1000 >= MAX_UTTERANCE_MS) commit();
      } else if (isSpeech) {
        speaking = true;
        buffers.push(frame.slice());
        speechSamples = frame.length;
        silenceSamples = 0;
        totalSamples = frame.length;
      }
    }
  }

  return { push };
}

// =============================================================
// Sarvam Saaras (Speech to Text — batch)
// Docs: POST https://api.sarvam.ai/speech-to-text
//   form-data: file=<wav>, model=saaras:v2.5
// =============================================================
async function sarvamStt(pcm: Int16Array, _onFirstByte?: (ms: number) => void): Promise<string> {
  void _onFirstByte;
  const wav = pcm16ToWav(pcm, 8000);
  const blob = new Blob([wav], { type: "audio/wav" });
  const fd = new FormData();
  fd.set("file", blob, "audio.wav");
  fd.set("model", SARVAM_STT_MODEL);
  const t0 = Date.now();
  const res = await fetch("https://api.sarvam.ai/speech-to-text", {
    method: "POST",
    headers: { "api-subscription-key": SARVAM_API_KEY },
    body: fd as unknown as BodyInit,
  });
  if (!res.ok) {
    const t = await res.text();
    console.error(`[sarvam.stt] ${res.status}: ${t.slice(0, 200)}`);
    return "";
  }
  const json = (await res.json()) as { transcript?: string };
  console.log(`[sarvam.stt] ok in ${Date.now() - t0}ms`);
  return json.transcript ?? "";
}

function pcm16ToWav(pcm: Int16Array, sampleRate: number): Buffer {
  const dataBytes = pcm.byteLength;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // format = PCM
  buf.writeUInt16LE(1, 22); // channels
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits/sample
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buf, 44);
  return buf;
}

// =============================================================
// Sarvam Bulbul v3 streaming TTS → Plivo
// Endpoint: POST https://api.sarvam.ai/text-to-speech/stream
//   { text, target_language_code:"hi-IN", speaker:"anushka",
//     model:"bulbul:v3", output_audio_codec:"mp3" }
// Response: chunked MP3. We decode with mpg123-decoder (WASM) to f32 PCM,
// convert to Int16, resample to 8kHz, and ship to Plivo as playAudio frames.
// =============================================================
let mpegDecoder: MPEGDecoder | null = null;
async function getDecoder(): Promise<MPEGDecoder> {
  if (mpegDecoder) return mpegDecoder;
  mpegDecoder = new MPEGDecoder();
  await mpegDecoder.ready;
  return mpegDecoder;
}

async function streamSarvamTtsToPlivo(
  plivoWs: WebSocket,
  streamId: string | null,
  text: string,
  onFirstByte?: (ms: number) => void,
) {
  if (!text?.trim()) return;
  const t0 = Date.now();

  const ttsRes = await fetch("https://api.sarvam.ai/text-to-speech/stream", {
    method: "POST",
    headers: {
      "api-subscription-key": SARVAM_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      target_language_code: "hi-IN",
      speaker: SARVAM_TTS_SPEAKER,
      model: SARVAM_TTS_MODEL,
      output_audio_codec: "mp3",
    }),
  });
  if (!ttsRes.ok || !ttsRes.body) {
    const t = await ttsRes.text().catch(() => "");
    console.error(`[sarvam.tts] ${ttsRes.status}: ${t.slice(0, 200)}`);
    throw new Error(`Sarvam TTS ${ttsRes.status}`);
  }

  // Recreate decoder per call so it's clean.
  const decoder = new MPEGDecoder();
  await decoder.ready;

  const reader = ttsRes.body.getReader();
  // We accumulate decoded PCM samples (at decoder's sample rate, typically
  // 22050 or 24000), resample to 8kHz, and ship in 20ms (160-sample) frames.
  let resampleAccum: Float32Array = new Float32Array(0);
  let decoderRate = 0;
  let firstByteAt = 0;
  // Plivo plays frames at real time. We pace 20ms-per-frame.
  let nextSendAt = Date.now();
  let totalFramesSent = 0;

  async function sendFrame(pcmFrame: Int16Array) {
    if (plivoWs.readyState !== WebSocket.OPEN) return;
    // ArrayBuffer-based Buffer creation (Int16Array → bytes LE).
    const bytes = Buffer.from(pcmFrame.buffer, pcmFrame.byteOffset, pcmFrame.byteLength);
    const wait = nextSendAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    nextSendAt = Math.max(nextSendAt + 20, Date.now());
    plivoWs.send(
      JSON.stringify({
        event: "playAudio",
        media: {
          contentType: "audio/x-l16;rate=8000",
          sampleRate: 8000,
          payload: bytes.toString("base64"),
        },
      }),
    );
    totalFramesSent++;
  }

  function appendF32(a: Float32Array, b: Float32Array): Float32Array {
    const out = new Float32Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  // Naive linear resampler: srcRate → 8000.
  function resampleTo8k(src: Float32Array, srcRate: number): { out: Float32Array; carry: Float32Array } {
    if (srcRate === 8000) return { out: src, carry: new Float32Array(0) };
    const ratio = srcRate / 8000;
    const outLen = Math.floor(src.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcIdx = i * ratio;
      const i0 = Math.floor(srcIdx);
      const i1 = Math.min(i0 + 1, src.length - 1);
      const frac = srcIdx - i0;
      out[i] = src[i0] * (1 - frac) + src[i1] * frac;
    }
    // Carry remaining tail samples that didn't fit a full output sample.
    const consumed = Math.floor(outLen * ratio);
    const carry = src.subarray(consumed);
    return { out, carry: carry.slice() };
  }

  let srcCarry = new Float32Array(0);
  const FRAME_SAMPLES_8K = 160; // 20ms @ 8kHz

  async function processDecoded(channelData: Float32Array[], rate: number) {
    if (!decoderRate) decoderRate = rate;
    // Mono mix
    const mono =
      channelData.length === 1
        ? channelData[0]
        : (() => {
            const m = new Float32Array(channelData[0].length);
            for (let i = 0; i < m.length; i++) {
              let sum = 0;
              for (let c = 0; c < channelData.length; c++) sum += channelData[c][i];
              m[i] = sum / channelData.length;
            }
            return m;
          })();
    const merged = appendF32(srcCarry, mono);
    const { out, carry } = resampleTo8k(merged, decoderRate);
    srcCarry = carry;
    resampleAccum = appendF32(resampleAccum, out);

    // Slice into 160-sample frames and send paced.
    while (resampleAccum.length >= FRAME_SAMPLES_8K) {
      const f32 = resampleAccum.subarray(0, FRAME_SAMPLES_8K);
      resampleAccum = resampleAccum.slice(FRAME_SAMPLES_8K);
      const i16 = new Int16Array(FRAME_SAMPLES_8K);
      for (let i = 0; i < FRAME_SAMPLES_8K; i++) {
        const v = Math.max(-1, Math.min(1, f32[i]));
        i16[i] = (v * 0x7fff) | 0;
      }
      await sendFrame(i16);
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!firstByteAt) {
        firstByteAt = Date.now();
        console.log(`[sarvam.tts] first byte ${firstByteAt - t0}ms`);
        onFirstByte?.(firstByteAt - t0);
      }
      const decoded = decoder.decode(value);
      if (decoded.channelData?.length) {
        await processDecoded(decoded.channelData, decoded.sampleRate);
      }
    }
    // Flush decoder.
    const tail = decoder.flush();
    if (tail.channelData?.length) {
      await processDecoded(tail.channelData, tail.sampleRate || decoderRate || 22050);
    }
    // Pad and send any final partial frame.
    if (resampleAccum.length > 0) {
      const padded = new Int16Array(FRAME_SAMPLES_8K);
      for (let i = 0; i < resampleAccum.length; i++) {
        const v = Math.max(-1, Math.min(1, resampleAccum[i]));
        padded[i] = (v * 0x7fff) | 0;
      }
      await sendFrame(padded);
      resampleAccum = new Float32Array(0);
    }
  } finally {
    decoder.free();
  }

  console.log(
    `[sarvam.tts] streamed ${totalFramesSent} frames (${totalFramesSent * 20}ms) in ${Date.now() - t0}ms wall`,
  );
}

// =============================================================
// Ringback streamer (PCM Lin16 8kHz, paced at 20ms / 320 bytes per frame).
// Used only for inbound calls so the caller hears a tone instead of dead
// air before the agent's greeting.
// =============================================================
async function streamRingToPlivo(
  plivoWs: WebSocket,
  streamId: string | null,
  ringPcm16: Buffer,
  stopSignal?: Promise<void>,
  tCallStart?: number,
) {
  void streamId; // not required for playAudio
  const t0 = tCallStart ?? Date.now();
  const FRAME = 320; // 160 samples * 2 bytes (PCM16 little-endian)
  let nextSendAt = Date.now();
  let sent = 0;
  let stopped = false;
  let stopReason: "greeting_resolved" | "max_ms" | "ws_closed" = "max_ms";
  if (stopSignal) {
    void stopSignal.then(() => {
      stopped = true;
      stopReason = "greeting_resolved";
    });
  }
  console.log(`[ring] start +${Date.now() - t0}ms maxMs=${((ringPcm16.length / 16000) * 1000) | 0}`);
  for (let off = 0; off + FRAME <= ringPcm16.length; off += FRAME) {
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
          contentType: "audio/x-l16;rate=8000",
          sampleRate: 8000,
          payload: ringPcm16.subarray(off, off + FRAME).toString("base64"),
        },
      }),
    );
    sent++;
  }
  console.log(`[ring] stop +${Date.now() - t0}ms reason=${stopReason} frames=${sent} (${sent * 20}ms)`);
}

// =============================================================
// Lovable agent endpoints (same as Twilio bridge)
// =============================================================
async function fetchAgentReply(callId: string, utterance: string, isFirstTurn: boolean) {
  const res = await fetch(`${LOVABLE_BASE_URL}/api/public/agent/turn`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bridge-secret": BRIDGE_SHARED_SECRET,
    },
    body: JSON.stringify({ callId, utterance, isFirstTurn }),
  });
  if (!res.ok) throw new Error(`agent/turn ${res.status}: ${await res.text()}`);
  return (await res.json()) as { agent_reply: string; end_call: boolean };
}

async function fetchAgentGreeting(callId: string) {
  const res = await fetch(`${LOVABLE_BASE_URL}/api/public/agent/greeting`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bridge-secret": BRIDGE_SHARED_SECRET,
    },
    body: JSON.stringify({ callId }),
  });
  if (!res.ok) throw new Error(`agent/greeting ${res.status}: ${await res.text()}`);
  return (await res.json()) as { agent_reply: string; end_call: boolean; play_ring?: boolean };
}

async function notifyBridgeEnd(
  callId: string,
  reason: "stream_closed" | "agent_end_call" | "watchdog",
  answered: boolean,
  hadPatientTurn: boolean,
  durationSeconds: number,
) {
  const res = await fetch(`${LOVABLE_BASE_URL}/api/public/bridge/end`, {
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
  console.log(`[bridge/end] -> ${res.status}`);
}
