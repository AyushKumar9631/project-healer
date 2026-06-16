/**
 * Ringback tone synthesis (μ-law 8kHz).
 *
 * Generates an in-memory ringback buffer at boot — no asset, no network.
 * Default profile: Indian-style 400Hz tone, 0.4s on / 0.2s off, total ~2s.
 *
 * Used only for inbound calls (gated by `play_ring` from the greeting API)
 * so the caller hears a ring rather than dead air before the agent speaks.
 */

const SAMPLE_RATE = 8000;

// G.711 μ-law encoder (lin16 → 8-bit μ-law).
function linearToMuLaw(sample: number): number {
  const MU = 255;
  const BIAS = 0x84;
  const CLIP = 32635;
  let s = sample;
  let sign = 0;
  if (s < 0) { s = -s; sign = 0x80; }
  if (s > CLIP) s = CLIP;
  s = s + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  const ulawByte = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return ulawByte;
}

function buildPcm16(durationMs: number, style: "in" | "us"): Int16Array {
  const totalSamples = Math.floor((durationMs / 1000) * SAMPLE_RATE);
  const out = new Int16Array(totalSamples);

  // Cadence: Indian (400Hz, 400ms on / 200ms off) or US (440+480Hz, 2s on / 4s off).
  const onMs = style === "in" ? 400 : 2000;
  const offMs = style === "in" ? 200 : 4000;
  const periodMs = onMs + offMs;
  const ATTACK_MS = 5;
  const attackSamples = (ATTACK_MS / 1000) * SAMPLE_RATE;
  const amplitude = 0.25 * 32767; // headroom + comfortable level over a phone

  for (let i = 0; i < totalSamples; i++) {
    const tMs = (i / SAMPLE_RATE) * 1000;
    const phaseMs = tMs % periodMs;
    if (phaseMs >= onMs) {
      out[i] = 0;
      continue;
    }
    // Envelope: 5ms attack at burst start, 5ms release at burst end.
    const sampleInBurst = (phaseMs / 1000) * SAMPLE_RATE;
    const samplesUntilEnd = ((onMs - phaseMs) / 1000) * SAMPLE_RATE;
    let env = 1;
    if (sampleInBurst < attackSamples) env = sampleInBurst / attackSamples;
    else if (samplesUntilEnd < attackSamples) env = Math.max(0, samplesUntilEnd / attackSamples);

    const t = i / SAMPLE_RATE;
    let v: number;
    if (style === "in") {
      v = Math.sin(2 * Math.PI * 400 * t);
    } else {
      v = 0.5 * (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t));
    }
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v * amplitude * env)));
  }
  return out;
}

export interface RingBuffers {
  ulaw: Buffer;        // μ-law 8kHz, frame-aligned (160-byte frames)
  pcm16: Buffer;       // little-endian Int16 8kHz, frame-aligned (320-byte frames)
  durationMs: number;
  style: "in" | "us";
}

export function buildRingBuffers(): RingBuffers {
  const durationMs = Number(process.env.RING_DURATION_MS ?? 2000);
  const styleEnv = (process.env.RING_STYLE ?? "in").toLowerCase();
  const style: "in" | "us" = styleEnv === "us" ? "us" : "in";

  const pcm = buildPcm16(durationMs, style);
  // μ-law
  const ulaw = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) ulaw[i] = linearToMuLaw(pcm[i]);

  // Little-endian PCM16 buffer
  const pcm16 = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) pcm16.writeInt16LE(pcm[i], i * 2);

  return { ulaw, pcm16, durationMs, style };
}
