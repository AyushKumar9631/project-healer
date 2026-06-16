// Bridge connectivity diagnostic. Returns:
//   - healthOk:        whether GET /health returns 200
//   - plivoHealthOk:   whether GET /health/plivo returns 200
//   - latencyMs:       per-probe round-trip
//
// NOTE: We previously also issued a fake WebSocket upgrade via fetch() to
// verify /plivo. The server runtime cannot complete a raw WS handshake
// through fetch(), so that probe always reported "fetch failed" — a false
// negative that blocked real calls. Real WS reachability is verified by
// Plivo at call time via /api/public/plivo/stream-status callbacks.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/calls/bridge-status")({
  server: {
    handlers: {
      GET: async () => handle(),
      POST: async () => handle(),
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

type Probe = {
  ok: boolean;
  status?: number;
  latencyMs: number;
  error?: string;
  body?: unknown;
};

async function probeHttp(url: string, captureBody = false): Promise<Probe> {
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(url, { method: "GET", signal: ctrl.signal });
    clearTimeout(timer);
    let body: unknown;
    if (captureBody) {
      const text = await res.text().catch(() => "");
      try { body = JSON.parse(text); } catch { body = text; }
    }
    return { ok: res.ok, status: res.status, latencyMs: Date.now() - t0, body };
  } catch (e) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function handle() {
  const rawHost = process.env.PLIVO_BRIDGE_PUBLIC_HOST;
  if (!rawHost) {
    return Response.json(
      {
        ok: false,
        error: "PLIVO_BRIDGE_PUBLIC_HOST not configured",
      },
      { status: 500 },
    );
  }
  const host = sanitizeHost(rawHost);

  const [health, plivoHealth] = await Promise.all([
    probeHttp(`https://${host}/health`),
    probeHttp(`https://${host}/health/plivo`, true),
  ]);

  const ok = health.ok && plivoHealth.ok;
  return Response.json({
    ok,
    host,
    healthOk: health.ok,
    plivoHealthOk: plivoHealth.ok,
    health,
    plivoHealth,
    wsProbeSupported: false,
    wsNote:
      "WebSocket upgrade cannot be verified from a server fetch; real verification happens through Plivo stream-status callbacks at call time.",
  });
}
