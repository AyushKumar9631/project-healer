// Server-only helper: bootstrap a `calls` row for an inbound Plivo call.
// Resolves the clinic from the dialled DID (`To`), finds-or-creates a
// patient stub from the caller's number (`From`), and inserts a new
// `calls` row with direction='inbound'. Returns the new callId and memory summary.
//
// Used by /api/public/plivo/voice when no `?callId=` is present in the
// answer URL — outbound calls always carry callId, so inbound is the
// only path that hits this helper.

import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { isPlaceholderName } from "./playbooks/inboundReception";

function buildAdminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      `Supabase env missing: SUPABASE_URL=${url ? "set" : "MISSING"} SUPABASE_SERVICE_ROLE_KEY=${key ? "set" : "MISSING"}`,
    );
  }
  return createClient<Database>(url, key, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  });
}

function normalisePhone(raw: string | null | undefined): { e164: string | null; last10: string | null } {
  if (!raw) return { e164: null, last10: null };
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D+/g, "");
  if (!digits) return { e164: null, last10: null };
  const e164 = trimmed.startsWith("+") ? trimmed : `+${digits}`;
  const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
  return { e164, last10 };
}

export type InboundBootstrapResult = {
  callId: string;
  clinicId: string;
  patientId: string;
  memoryContext: string | null;
};

export async function bootstrapInboundCall(args: {
  callerFrom: string;
  dialledTo: string;
  plivoCallUuid: string;
}): Promise<InboundBootstrapResult> {
  const supabase = buildAdminClient();
  const { callerFrom, dialledTo, plivoCallUuid } = args;

  const { data: clinics, error: clinicErr } = await supabase
    .from("clinics")
    .select("id,name")
    .order("created_at", { ascending: true })
    .limit(1);
  if (clinicErr) throw new Error(`clinic lookup: ${clinicErr.message}`);
  if (!clinics || clinics.length === 0) throw new Error("no clinic configured");
  const clinic = clinics[0];

  const fromNorm = normalisePhone(callerFrom);
  const candidates = Array.from(
    new Set(
      [
        fromNorm.e164,
        fromNorm.last10 ? `+91${fromNorm.last10}` : null,
        fromNorm.last10,
        callerFrom?.trim() || null,
      ].filter((v): v is string => !!v),
    ),
  );

  let patientId: string | null = null;
  let stubFallbackId: string | null = null;

  if (candidates.length) {
    const { data: matches, error: matchErr } = await supabase
      .from("patients")
      .select("id,name,updated_at")
      .eq("clinic_id", clinic.id)
      .in("phone" as never, candidates)
      .order("updated_at", { ascending: false })
      .limit(5);

    if (matchErr) {
      console.warn(`[inbound-bootstrap] patient lookup error: ${matchErr.message}`);
    } else if (matches && matches.length) {
      for (const row of matches) {
        if (!isPlaceholderName(row.name)) {
          patientId = row.id;
          break;
        }
      }
      if (!patientId) {
        stubFallbackId = matches[0].id;
      }
    }
  }

  if (!patientId && stubFallbackId) {
    patientId = stubFallbackId;
    console.log(`[inbound-bootstrap] reusing old stub patient ${patientId} for ${fromNorm.e164 ?? callerFrom}.`);
  }

  if (!patientId) {
    const { data: created, error: createErr } = await supabase
      .from("patients")
      .insert({
        clinic_id: clinic.id,
        name: "Unknown Caller",
        phone: fromNorm.e164 ?? callerFrom ?? "unknown",
      })
      .select("id")
      .single();
    if (createErr || !created) {
      throw new Error(`patient create failed: ${createErr?.message ?? "unknown"}`);
    }
    patientId = created.id;
    console.log(`[inbound-bootstrap] created new patient stub ${patientId} for ${fromNorm.e164 ?? callerFrom}.`);
  }

  const { data: callRow, error: callErr } = await supabase
    .from("calls")
    .insert({
      clinic_id: clinic.id,
      patient_id: patientId,
      campaign_id: null,
      status: "in_progress",
      direction: "inbound",
      provider: "plivo",
      plivo_call_uuid: plivoCallUuid || null,
      phone_number: fromNorm.e164 ?? callerFrom ?? null,
      simulated: false,
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (callErr || !callRow) {
    throw new Error(`call insert failed: ${callErr?.message ?? "unknown"}`);
  }

  try {
    await supabase.from("call_events").insert({
      call_id: callRow.id,
      clinic_id: clinic.id,
      event_type: "inbound_call_bootstrapped",
      payload: {
        from: callerFrom,
        to: dialledTo,
        CallUUID: plivoCallUuid,
        patient_id: patientId,
      },
    });
  } catch (e) {
    console.warn(`[inbound-bootstrap] audit insert failed: ${e instanceof Error ? e.message : e}`);
  }

  // To prevent shared-number context corruption (e.g. relatives calling from the same phone),
  // inbound streams are always initialized blank. Memory timelines are strictly unlocked 
  // mid-call only after identity verification occurs past Turn 1.
  console.log(`[inbound-bootstrap] callId=${callRow.id} clinic=${clinic.id} patient=${patientId} from=${callerFrom} memoryContextAvailable=false (Inbound Firebreak Enforced)`);
  
  return { callId: callRow.id, clinicId: clinic.id, patientId, memoryContext: null };
}