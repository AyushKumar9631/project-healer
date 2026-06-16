// Server-only helper: starts a Plivo call for a patient.
// Extracted from src/routes/api.calls.start-plivo.ts so both the unified
// /api/calls/start route and the legacy /api/calls/start-plivo route can
// share one implementation.

import type { AuthedSupabase } from "@/lib/calls.server";
import { plivoPost } from "@/lib/plivo";

function httpError(status: number, message: string, extra?: Record<string, unknown>) {
  return new Response(JSON.stringify({ error: message, ...(extra ?? {}) }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getPublicBase(request: Request): string {
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
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || url.host;
  const proto =
    request.headers.get("x-forwarded-proto") || (host.includes("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

function sanitizeBridgeHost(raw: string): string {
  return raw
    .trim()
    .replace(/^wss?:\/\//i, "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

async function preflightBridge(
  rawHost: string,
): Promise<{ ok: boolean; reason?: string; healthStatus?: number; plivoHealthStatus?: number }> {
  const host = sanitizeBridgeHost(rawHost);
  async function get(url: string): Promise<{ ok: boolean; status?: number; error?: string }> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(url, { method: "GET", signal: ctrl.signal });
      clearTimeout(timer);
      return { ok: res.ok, status: res.status };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  const [health, plivoHealth] = await Promise.all([
    get(`https://${host}/health`),
    get(`https://${host}/health/plivo`),
  ]);
  if (!health.ok) {
    return {
      ok: false,
      healthStatus: health.status,
      reason: `/health failed (${health.status ?? health.error})`,
    };
  }
  if (!plivoHealth.ok) {
    return {
      ok: false,
      healthStatus: health.status,
      plivoHealthStatus: plivoHealth.status,
      reason: `/health/plivo failed (${plivoHealth.status ?? plivoHealth.error})`,
    };
  }
  return { ok: true, healthStatus: health.status, plivoHealthStatus: plivoHealth.status };
}

export async function startPlivoCallForPatient(opts: {
  request: Request;
  supabase: AuthedSupabase;
  patientId: string;
  campaignId: string | null;
}): Promise<{ callId: string; plivoRequestUuid: string | null; phone: string }> {
  const { request, supabase, patientId, campaignId } = opts;

  const plivoFrom = process.env.PLIVO_PHONE_NUMBER;
  // Plivo logic is hosted in the same Railway service as Twilio. Fall back
  // to BRIDGE_PUBLIC_HOST when PLIVO_BRIDGE_PUBLIC_HOST is unset/stale so a
  // misconfigured Plivo-specific secret never blocks production calls.
  const plivoBridgeHost = process.env.PLIVO_BRIDGE_PUBLIC_HOST || process.env.BRIDGE_PUBLIC_HOST;
  if (!plivoFrom) throw httpError(500, "PLIVO_PHONE_NUMBER not configured");
  if (!plivoBridgeHost)
    throw httpError(500, "PLIVO_BRIDGE_PUBLIC_HOST / BRIDGE_PUBLIC_HOST not configured");

  const preflight = await preflightBridge(plivoBridgeHost);
  if (!preflight.ok) {
    throw httpError(
      502,
      `Bridge preflight failed: ${preflight.reason}. Verify Railway service is up and /plivo WebSocket returns 101.`,
      { preflight },
    );
  }

  const { data: patient, error: pErr } = await supabase
    .from("patients")
    .select("id,name,phone,clinic_id")
    .eq("id", patientId)
    .maybeSingle();
  if (pErr) throw httpError(500, `Patient lookup failed: ${pErr.message}`);
  if (!patient) throw httpError(404, "Patient not found (or not in your clinic)");

  const { data: call, error: cErr } = await supabase
    .from("calls")
    .insert({
      clinic_id: patient.clinic_id,
      patient_id: patient.id,
      campaign_id: campaignId,
      status: "starting",
      simulated: false,
      direction: "outbound",
      phone_number: patient.phone,
      transcript: [],
      provider: "plivo",
    })
    .select("id")
    .single();
  if (cErr || !call)
    throw httpError(500, `Failed to create call row: ${cErr?.message ?? "unknown"}`);

  const base = getPublicBase(request);
  const answerUrl = `${base}/api/public/plivo/voice?callId=${call.id}`;
  const hangupUrl = `${base}/api/public/plivo/status?callId=${call.id}`;
  console.log(
    `[plivo.start] callId=${call.id} to=${patient.phone} bridge=${sanitizeBridgeHost(plivoBridgeHost)} answer=${answerUrl}`,
  );

  try {
    // AMD intentionally disabled — see api.calls.start-plivo.ts history.
    const res = await plivoPost<{ request_uuid?: string; api_id?: string }>("/Call/", {
      from: plivoFrom,
      to: patient.phone,
      answer_url: answerUrl,
      answer_method: "POST",
      hangup_url: hangupUrl,
      hangup_method: "POST",
      ring_timeout: 30,
    });

    const requestUuid = res.request_uuid ?? null;
    await supabase
      .from("calls")
      .update({ status: "dialing", plivo_call_uuid: requestUuid })
      .eq("id", call.id);

    // NEW: Tell the campaign engine that this patient is currently being dialed manually!
    if (campaignId) {
      const { error: queueErr } = await supabase
        .from("campaign_call_queue")
        .update({
          call_id: call.id,
          status: "dialing",
        })
        .match({ campaign_id: campaignId, patient_id: patientId });

      if (queueErr) {
        console.error("Failed to update campaign queue for manual call:", queueErr);
      }
    }

    return { callId: call.id, plivoRequestUuid: requestUuid, phone: patient.phone };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabase.from("calls").update({ status: "failed", notes: msg }).eq("id", call.id);
    throw httpError(502, `Plivo call failed: ${msg}`);
  }
}
