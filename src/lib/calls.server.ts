// Server-only helpers for starting and ending real Twilio calls.
// Validates a Supabase access token from an Authorization header,
// creates the call row scoped to the user's clinic via RLS,
// then triggers the Twilio REST API.

import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { twilioPost } from "@/lib/twilio";

export type AuthedSupabase = ReturnType<typeof createClient<Database>>;

export async function authenticateRequest(request: Request): Promise<{
  supabase: AuthedSupabase;
  userId: string;
}> {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    throw httpError(500, "Server is missing SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY");
  }

  const authHeader = request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    throw httpError(401, "Missing or invalid Authorization header");
  }
  const token = authHeader.slice(7).trim();
  if (!token) throw httpError(401, "Empty bearer token");

  const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) throw httpError(401, "Invalid Supabase token");

  return { supabase, userId: data.user.id };
}

function httpError(status: number, message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getPublicBase(request: Request): string {
  // Prefer an explicit env so Twilio always calls back to a stable, reachable URL.
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

// Fire-and-forget pre-warmers. We use AbortSignal.timeout so a slow worker
// can't keep the request alive on the SSR side.
async function prewarm(appBase: string, bridgeHost: string): Promise<void> {
  let bridgeUrl = bridgeHost.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(bridgeUrl)) bridgeUrl = `https://${bridgeUrl}`;
  const targets = [
    `${bridgeUrl}/health`,
    `${appBase}/api/public/agent/greeting?warm=1`,
  ];
  await Promise.allSettled(
    targets.map((u) =>
      fetch(u, { method: "GET", signal: AbortSignal.timeout(2500) })
        .then((r) => console.log(`[calls.start] prewarm ${u} → ${r.status}`))
        .catch((e) => console.log(`[calls.start] prewarm ${u} failed: ${e instanceof Error ? e.message : e}`)),
    ),
  );
}

export async function startCallForPatient(opts: {
  request: Request;
  supabase: AuthedSupabase;
  patientId: string;
  campaignId: string | null;
}): Promise<{ callId: string; twilioSid: string | null; phone: string }> {
  const { request, supabase, patientId, campaignId } = opts;

  const twilioFrom = process.env.TWILIO_PHONE_NUMBER;
  const bridgeHost = process.env.BRIDGE_PUBLIC_HOST;
  if (!twilioFrom) throw httpError(500, "TWILIO_PHONE_NUMBER not configured");
  if (!bridgeHost) throw httpError(500, "BRIDGE_PUBLIC_HOST not configured");

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
    })
    .select("id")
    .single();
  if (cErr || !call) throw httpError(500, `Failed to create call row: ${cErr?.message ?? "unknown"}`);

  const base = getPublicBase(request);
  const voiceUrl = `${base}/api/public/twilio/voice?callId=${call.id}`;
  const statusUrl = `${base}/api/public/twilio/status?callId=${call.id}`;
  console.log(`[calls.start] callId=${call.id} to=${patient.phone} voiceUrl=${voiceUrl} statusUrl=${statusUrl}`);

  // Pre-warm: wake the bridge worker and JIT-compile the greeting route in
  // parallel with Twilio dialing. Fire-and-forget — never block the call.
  prewarm(base, bridgeHost).catch(() => {});

  try {
    // NOTE: Twilio expects StatusCallbackEvent repeated as separate form fields,
    // but accepts a single space-separated value as well. We send the canonical
    // space-separated form here.
    // CRITICAL: AsyncAmd=true means Twilio connects the <Stream> immediately
    // on answer (no 3-8s AMD delay). The AMD verdict arrives separately at
    // AsyncAmdStatusCallback. Synchronous `MachineDetection: "Enable"` would
    // block media for ~3-8s while AMD analyses the line — that was the entire
    // root cause of "नमस्ते" taking 3-8s to play.
    const amdUrl = `${base}/api/public/twilio/amd?callId=${call.id}`;
    const twilioRes = await twilioPost("/Calls.json", {
      To: patient.phone,
      From: twilioFrom,
      Url: voiceUrl,
      StatusCallback: statusUrl,
      StatusCallbackEvent: "initiated ringing answered completed",
      StatusCallbackMethod: "POST",
      AsyncAmd: "true",
      AsyncAmdStatusCallback: amdUrl,
      AsyncAmdStatusCallbackMethod: "POST",
      MachineDetection: "DetectMessageEnd",
      MachineDetectionSpeechThreshold: "1200",
      MachineDetectionSpeechEndThreshold: "800",
      MachineDetectionSilenceTimeout: "3000",
      // Stop ringing after 30s if patient doesn't answer → Twilio fires
      // CallStatus=no-answer immediately instead of staying in 'dialing'.
      Timeout: "30",
    });

    const sid = (twilioRes.sid as string) || (twilioRes.Sid as string) || null;
    console.log(`[calls.start] twilio created sid=${sid} callId=${call.id}`);
    await supabase
      .from("calls")
      .update({ twilio_call_sid: sid, status: "dialing" })
      .eq("id", call.id);

    return { callId: call.id, twilioSid: sid, phone: patient.phone };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabase
      .from("calls")
      .update({ status: "failed", notes: msg })
      .eq("id", call.id);
    throw httpError(502, `Twilio call failed: ${msg}`);
  }
}

export async function hangupCallById(opts: {
  supabase: AuthedSupabase;
  callId: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const { supabase, callId } = opts;
  const { data: call, error } = await supabase
    .from("calls")
    .select("id,twilio_call_sid")
    .eq("id", callId)
    .maybeSingle();
  if (error) throw httpError(500, `Lookup failed: ${error.message}`);
  if (!call) throw httpError(404, "Call not found");
  if (!call.twilio_call_sid) return { ok: false, reason: "No Twilio SID on this call yet" };

  await twilioPost(`/Calls/${call.twilio_call_sid}.json`, { Status: "completed" });
  return { ok: true };
}
