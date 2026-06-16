import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Twilio fetches this when the call connects. We return TwiML that opens a
// Media Stream WebSocket to our self-hosted bridge, AND wires a Stream
// statusCallback back to /api/public/twilio/status so we observe stream
// start/stop/error events server-side too.
export const Route = createFileRoute("/api/public/twilio/voice")({
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

async function handle(request: Request) {
  const url = new URL(request.url);
  const callId = url.searchParams.get("callId") ?? "";
  const rawHost = process.env.BRIDGE_PUBLIC_HOST;

  console.log(`[twilio/voice] hit callId=${callId} bridge=${rawHost ? "set" : "MISSING"}`);

  if (!rawHost) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say voice="alice" language="en">The voice bridge is not configured. Goodbye.</Say><Hangup/></Response>`;
    return new Response(xml, { status: 200, headers: { "Content-Type": "text/xml" } });
  }

  const host = sanitizeHost(rawHost);
  const wssUrl = `wss://${host}/twilio`;
  const streamStatusUrl = `${publicBase(request)}/api/public/twilio/status?callId=${callId}`;

  // Look up direction synchronously so the bridge can decide whether to play
  // the inbound ringback the moment the WS `start` event lands — without
  // waiting on the greeting fetch (which is what caused the silence).
  let direction = "";
  if (callId) {
    try {
      const { data } = await supabaseAdmin
        .from("calls")
        .select("direction")
        .eq("id", callId)
        .maybeSingle();
      direction = (data?.direction ?? "").toLowerCase();
    } catch (e) {
      console.warn(`[twilio/voice] direction lookup failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  const directionParam =
    direction === "inbound"
      ? `\n      <Parameter name="direction" value="inbound"/>`
      : "";

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wssUrl}" statusCallback="${streamStatusUrl}" statusCallbackMethod="POST">
      <Parameter name="callId" value="${callId}"/>${directionParam}
    </Stream>
  </Connect>
</Response>`;

  return new Response(xml, { status: 200, headers: { "Content-Type": "text/xml" } });
}
