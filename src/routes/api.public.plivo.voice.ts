// Plivo Answer URL.
//
// OUTBOUND: Dashboard → /api/calls/start-plivo → Plivo REST creates the
// call with answer URL `?callId=<row uuid>`. We render Stream XML pointed
// at the bridge.
//
// INBOUND (new): A patient dials the Plivo DID. Plivo POSTs here WITHOUT
// `callId` in the query string. We bootstrap a `calls` row from the form
// fields (`From`, `To`, `CallUUID`), then render the SAME Stream XML using
// the freshly-minted callId. The bridge has no idea whether the call is
// inbound or outbound — both look identical from its perspective.
//
// Plivo AudioStream uses bidirectional PCM Lin16 / mu-law @ 8kHz.
// Docs: https://www.plivo.com/docs/voice-agents/audio-streaming/concepts/audio-streaming-guide
import { createFileRoute } from "@tanstack/react-router";
import { bootstrapInboundCall } from "@/lib/inbound-call.server";

export const Route = createFileRoute("/api/public/plivo/voice")({
  server: {
    handlers: {
      POST: async ({ request }) => handle(request),
      GET: async ({ request }) => handle(request),
    },
  },
});

function sanitizeHost(raw: string): string {
  return raw
    .trim()
    .replace(/^wss?:\/\//i, "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

function publicBase(request: Request): string {
  const explicit =
    process.env.PLIVO_PUBLIC_BASE_URL ||
    process.env.PUBLIC_APP_BASE_URL ||
    process.env.LOVABLE_PUBLIC_BASE_URL ||
    process.env.LOVABLE_PUBLIC_HOST;
  if (explicit) {
    let v = explicit.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
    return v;
  }
  const url = new URL(request.url);
  const host =
    request.headers.get("x-forwarded-host") ||
    request.headers.get("host") ||
    url.host;
  const proto =
    request.headers.get("x-forwarded-proto") ||
    (host.includes("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

// XML-escape any value before interpolating it into Plivo Answer XML.
// CRITICAL: Plivo rejects the entire response with "Invalid Answer XML" if a
// raw `&` (or `<`, `>`, `"`, `'`) appears in element text or attribute
// values. The WebSocket URL contains query params separated by `&`, which
// MUST be encoded as `&amp;` inside the `<Stream>` body.
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function gracefulFailureXml(message: string): Response {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Speak voice="Polly.Aditi" language="en-IN">${xmlEscape(message)}</Speak><Hangup/></Response>`;
  return new Response(xml, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

async function handle(request: Request) {
  const url = new URL(request.url);
  let callId = url.searchParams.get("callId") ?? "";
  let isInbound = false;
  const rawHost = process.env.PLIVO_BRIDGE_PUBLIC_HOST;

  // ----- Inbound bootstrap path -----
  // Plivo can send the Answer URL request as either GET (default) or POST,
  // depending on the application's "Answer Method" config. We must read the
  // call fields (`From`, `To`, `CallUUID`, `Direction`) from BOTH:
  //   - POST → request.formData() (form-encoded body)
  //   - GET  → URL query string
  // Previously we only handled POST, so any account configured with the
  // Plivo default (GET) hit the "no fields → probe" guard and we returned
  // the failure XML — caller heard "could not be set up" and Plivo hung up.
  if (!callId) {
    let from = "";
    let to = "";
    let plivoCallUuid = "";
    let direction = "";
    if (request.method === "POST") {
      try {
        const form = await request.formData();
        from = String(form.get("From") ?? "").trim();
        to = String(form.get("To") ?? "").trim();
        plivoCallUuid = String(form.get("CallUUID") ?? "").trim();
        direction = String(form.get("Direction") ?? "").trim().toLowerCase();
      } catch (e) {
        console.error(
          `[plivo/voice] inbound: failed to read form data: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    // GET path (Plivo default Answer Method) — and POST fallback if the body
    // was empty (e.g. status callbacks that share the URL).
    if (!from && !to && !plivoCallUuid) {
      from = (url.searchParams.get("From") ?? "").trim();
      to = (url.searchParams.get("To") ?? "").trim();
      plivoCallUuid = (url.searchParams.get("CallUUID") ?? "").trim();
      direction = (url.searchParams.get("Direction") ?? "").trim().toLowerCase();
    }

    console.log(
      `[plivo/voice] inbound hit method=${request.method} from=${from} to=${to} CallUUID=${plivoCallUuid} direction=${direction} host=${request.headers.get("host") ?? ""} xfh=${request.headers.get("x-forwarded-host") ?? ""}`,
    );

    // Defensive fallback: if Plivo fields are missing (typically due to a
    // proxy/redirect dropping the POST body), DO NOT hang up the call.
    // Bootstrap with safe placeholders so the patient at least reaches the
    // bridge and hears the agent. Inbound bootstrap tolerates empty caller.
    const fieldsMissing = !from && !to && !plivoCallUuid;
    if (fieldsMissing) {
      console.warn(
        `[plivo/voice] missing_plivo_fields — falling back to placeholder bootstrap (method=${request.method})`,
      );
      to = process.env.PLIVO_PHONE_NUMBER ?? "";
    }

    try {
      const result = await bootstrapInboundCall({
        callerFrom: from,
        dialledTo: to,
        plivoCallUuid,
      });
      callId = result.callId;
      isInbound = true;
      if (fieldsMissing) {
        console.log(
          `[plivo/voice] placeholder bootstrap ok callId=${callId} (no Plivo form fields received)`,
        );
      }
    } catch (e) {
      console.error(
        `[plivo/voice] inbound bootstrap failed: ${e instanceof Error ? e.message : e}`,
      );
      return gracefulFailureXml(
        "We are unable to connect you right now. Please call back shortly.",
      );
    }
  }

  console.log(
    `[plivo/voice] hit callId=${callId} bridge=${rawHost ? "set" : "MISSING"}`,
  );

  if (!rawHost) {
    return gracefulFailureXml("The Plivo bridge is not configured. Goodbye.");
  }

  const host = sanitizeHost(rawHost);
  // Pass callId both via the WS upgrade URL query string AND extraHeaders.
  // The query-string fallback is the most reliable channel because Plivo
  // sometimes reformats extra_headers (e.g. wraps them as "{X-PH-x-call-id: ...}")
  // which our event-payload parser then can't read.
  const wssUrl = `wss://${host}/plivo?callId=${encodeURIComponent(callId)}${isInbound ? "&direction=inbound" : ""}`;
  const streamStatusUrl = `${publicBase(request)}/api/public/plivo/stream-status?callId=${callId}`;

  // bidirectional + extraHeaders carries our callId through. statusCallback
  // fires "started"/"stopped"/"failed" so we can see WS-handshake failures
  // without reading Railway logs.
  // IMPORTANT: do NOT set audioTrack — that attribute restricts to a single
  // direction (e.g. inbound recording) and silently disables outbound playback,
  // which is what was causing the caller to hear nothing while our bridge
  // happily streamed `playAudio` frames with no error.
  // Codec: mu-law 8 kHz is Plivo's recommended default — universally supported,
  // no transcoding overhead on Plivo's side, lowest latency.
  const directionHeader = isInbound ? `;x-direction=inbound` : "";
  const extraHeadersValue = `x-call-id=${callId}${directionHeader}`;

  // Plivo native server-side noise cancellation. Filters background noise on
  // Plivo's edge BEFORE audio reaches our bridge / ElevenLabs Scribe — which
  // directly reduces false VAD commits on background sounds and improves STT
  // accuracy. Docs: https://docs.plivo.com/docs/voice/xml/audio-streaming#noise-cancellation
  // Defaults: enabled, level 85 (Plivo's default; "moderate noise" sweet spot).
  // Tune via Railway env without code changes:
  //   PLIVO_NOISE_CANCELLATION=false        → disable
  //   PLIVO_NOISE_CANCELLATION_LEVEL=70     → quieter callers (less artifacts)
  //   PLIVO_NOISE_CANCELLATION_LEVEL=95     → noisier callers (more aggressive)
  const ncEnabled =
    (process.env.PLIVO_NOISE_CANCELLATION ?? "true").trim().toLowerCase() !== "false";
  const ncLevelRaw = Number(process.env.PLIVO_NOISE_CANCELLATION_LEVEL ?? "85");
  const ncLevel = Number.isFinite(ncLevelRaw)
    ? Math.min(100, Math.max(60, Math.round(ncLevelRaw)))
    : 85;
  const noiseAttrs = ncEnabled
    ? `\n    noiseCancellation="true"\n    noiseCancellationLevel="${ncLevel}"`
    : "";

  // Plivo session recording. Runs in parallel with <Stream> on Plivo's edge —
  // does not touch the bridge, LLM, TTS or latency budgets. Stereo so agent
  // and patient land on separate channels for clean intern QA. Plivo posts
  // the final RecordUrl to /api/public/plivo/recording when the call ends.
  // Kill-switch: PLIVO_RECORDING_ENABLED=false to disable without redeploy.
  const recordingEnabled =
    (process.env.PLIVO_RECORDING_ENABLED ?? "true").trim().toLowerCase() !== "false";
  // Plivo's <Record> defaults maxLength to 60s — without this, a 98s call
  // gets a 60s recording. Cap at Plivo's max (3600s = 1h). Override via
  // PLIVO_RECORDING_MAX_LENGTH env without a redeploy.
  const maxLengthRaw = Number(process.env.PLIVO_RECORDING_MAX_LENGTH ?? "3600");
  const recordingMaxLength = Number.isFinite(maxLengthRaw)
    ? Math.min(3600, Math.max(15, Math.round(maxLengthRaw)))
    : 3600;
  const recordingCallbackUrl = `${publicBase(request)}/api/public/plivo/recording?callId=${encodeURIComponent(callId)}`;
  const recordElement = recordingEnabled
    ? `\n  <Record
    recordSession="true"
    startOnDialAnswer="false"
    recordChannelType="stereo"
    maxLength="${recordingMaxLength}"
    callbackUrl="${xmlEscape(recordingCallbackUrl)}"
    callbackMethod="POST"
    redirect="false" />`
    : "";

  console.log(
    `[plivo/voice] stream callId=${callId} noiseCancellation=${ncEnabled} level=${ncEnabled ? ncLevel : "n/a"} recording=${recordingEnabled} maxLength=${recordingEnabled ? recordingMaxLength : "n/a"}`,
  );

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>${recordElement}
  <Stream
    bidirectional="true"
    contentType="audio/x-mulaw;rate=8000"
    keepCallAlive="true"${noiseAttrs}
    statusCallbackUrl="${xmlEscape(streamStatusUrl)}"
    statusCallbackMethod="POST"
    extraHeaders="${xmlEscape(extraHeadersValue)}">${xmlEscape(wssUrl)}</Stream>
</Response>`;

  return new Response(xml, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
