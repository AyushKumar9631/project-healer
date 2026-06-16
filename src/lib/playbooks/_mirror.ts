// Mirror a finalized `calls` row into `call_outcomes` so the Outcomes
// dashboard always reflects every completed call, regardless of which side
// (LLM, bridge, or carrier webhook) marked it terminal.
//
// Idempotent: upserts on `call_id` (which is the PK on call_outcomes).

import type { AdminClient, PlaybookKey } from "./_base";
import { isValidPlaybookKey } from "./registry";

type CallRow = {
  id: string;
  clinic_id: string;
  campaign_id: string | null;
  status: string | null;
  intent: string | null;
  condition_mentioned: string | null;
  appointment_time: string | null;
  callback_requested: boolean | null;
  callback_time: string | null;
  suggested_doctor_id: string | null;
};

const SUCCESS_INTENTS = new Set(["interested"]);

// Carrier-level non-conversational call statuses. When the call ends in one
// of these, the LLM never set rsvp/intent_to_attend/intent — so we surface
// the carrier status itself in the playbook's outcome cell instead of
// showing an empty dash or a misleading "unclear".
const NON_CONVERSATIONAL_STATUSES = new Set([
  "no_answer",
  "busy",
  "voicemail",
  "declined",
  "failed",
]);

function isNonConversational(status: string | null): boolean {
  return !!status && NON_CONVERSATIONAL_STATUSES.has(status);
}

// True when the playbook already captured a real spoken answer that we must
// never downgrade to a carrier status.
function hasRealAnswer(key: string | undefined): boolean {
  return key === "yes" || key === "no";
}

// Convert a Postgres timestamptz string to a strict ISO-8601 string (...Z).
// Postgres can serialise as `+00` (no colon), which JS `new Date()` rejects.
function toIsoZ(ts: string | null): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (!isNaN(d.getTime())) return d.toISOString();
  // Repair common bad-offset shapes like `+00` or `-05`
  const repaired = ts.replace(/([+-]\d{2})$/, "$1:00");
  const d2 = new Date(repaired);
  return isNaN(d2.getTime()) ? ts : d2.toISOString();
}

// Tokens the LLM sometimes emits when there is no real condition / symptom.
// Treated as null so the dashboard doesn't render garbage like "no_symptoms".
const JUNK_CONDITION = new Set(["no_symptoms", "no symptoms", "none", "no", "n/a", "-", ""]);

function cleanCondition(raw: string | null): string | null {
  if (!raw) return null;
  return JUNK_CONDITION.has(raw.trim().toLowerCase()) ? null : raw;
}

function cleanSymptoms(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s && !JUNK_CONDITION.has(s.toLowerCase()));
}

function buildStructured(
  playbookKey: PlaybookKey,
  c: CallRow,
  doctorName: string | null,
  existing: Record<string, unknown> | null,
): Record<string, unknown> {
  const cleanedCondition = cleanCondition(c.condition_mentioned);
  const symptoms = cleanSymptoms(c.condition_mentioned);
  // For non-conversational calls (busy / no_answer / failed / declined /
  // voicemail) the LLM never set an intent. Surface the call status so the
  // Outcomes Intent column shows e.g. "busy" instead of an empty dash.
  const intentValue = c.intent ?? c.status ?? null;

  // For RSVP playbooks, prefer an `rsvp` value already captured by the
  // playbook's postProcess (lives in `existing.structured.rsvp`) over the
  // intent-derived guess — the LLM often emits intent="symptom"|"unclear"
  // even when rsvp="yes" is unambiguous.
  const existingRsvp = typeof existing?.rsvp === "string" ? (existing.rsvp as string) : null;
  const intentDerivedRsvp =
    c.intent === "interested" ? "yes" : c.intent === "not_interested" ? "no" : "unclear";
  const rsvpValue = existingRsvp ?? intentDerivedRsvp;

  const carrierStatus = c.status ?? null;
  const nonConv = isNonConversational(carrierStatus);
  // Common to every playbook: always expose the carrier status so the
  // dashboard can show it as a dedicated badge column.
  const callStatusField = { call_status: carrierStatus };

  switch (playbookKey) {
    case "screening_to_opd":
      return {
        ...(existing ?? {}),
        ...callStatusField,
        intent: intentValue,
        condition: cleanedCondition,
        appointment_iso: toIsoZ(c.appointment_time),
        doctor_name: doctorName ?? (existing?.doctor_name as string | null) ?? null,
        doctor_id: c.suggested_doctor_id ?? (existing?.doctor_id as string | null) ?? null,
        symptoms_mentioned: symptoms.length > 0 ? symptoms : (existing?.symptoms_mentioned ?? []),
        callback_requested: !!c.callback_requested,
        callback_time: c.callback_time,
      };
    case "free_screening_invite":
    case "free_screening_invite_existing": {
      // If the patient never spoke (no_answer/busy/voicemail/declined/failed)
      // and the playbook never captured a real yes/no, surface the carrier
      // status as the RSVP value so reviewers see why the call didn't land.
      const finalRsvp =
        nonConv && !hasRealAnswer(existingRsvp ?? undefined)
          ? (carrierStatus as string)
          : rsvpValue;
      return {
        ...(existing ?? {}),
        ...callStatusField,
        rsvp: finalRsvp,
        symptoms_mentioned:
          symptoms.length > 0
            ? symptoms
            : ((existing?.symptoms_mentioned as string[] | undefined) ?? []),
        callback_requested: !!c.callback_requested || !!existing?.callback_requested,
        callback_time: c.callback_time ?? (existing?.callback_time as string | null) ?? null,
      };
    }
    case "newborn_vaccination": {
      const existingAttend =
        typeof existing?.intent_to_attend === "string"
          ? (existing.intent_to_attend as string)
          : null;
      const finalAttend =
        nonConv && !hasRealAnswer(existingAttend ?? undefined)
          ? (carrierStatus as string)
          : (existingAttend ?? intentDerivedRsvp);
      return {
        ...(existing ?? {}),
        ...callStatusField,
        intent_to_attend: finalAttend,
        callback_requested: !!c.callback_requested || !!existing?.callback_requested,
        callback_time: c.callback_time ?? (existing?.callback_time as string | null) ?? null,
      };
    }
    case "inbound_reception": {
      // Caller dialled us. Carrier-status backfill (no_answer / failed)
      // shouldn't normally happen for inbound — Plivo only invokes the
      // answer URL after pickup — but guard anyway.
      const existingCallerIntent =
        typeof existing?.caller_intent === "string"
          ? (existing.caller_intent as string)
          : null;
      const finalCallerIntent =
        nonConv && !existingCallerIntent ? (carrierStatus as string) : (existingCallerIntent ?? "unclear");
      return {
        ...(existing ?? {}),
        ...callStatusField,
        caller_intent: finalCallerIntent,
        topic: (existing?.topic as string | null) ?? null,
        appointment_iso: toIsoZ(c.appointment_time) ?? (existing?.appointment_iso as string | null) ?? null,
        symptoms_mentioned:
          symptoms.length > 0 ? symptoms : ((existing?.symptoms_mentioned as string[] | undefined) ?? []),
        resolved: !!existing?.resolved,
        callback_requested: !!c.callback_requested || !!existing?.callback_requested,
        callback_time: c.callback_time ?? (existing?.callback_time as string | null) ?? null,
      };
    }
    default:
      return {
        ...(existing ?? {}),
        ...callStatusField,
        intent: intentValue,
        condition: cleanedCondition,
        appointment_iso: toIsoZ(c.appointment_time),
        symptoms_mentioned: symptoms.length > 0 ? symptoms : (existing?.symptoms_mentioned ?? []),
      };
  }
}

function computeSuccess(
  playbookKey: PlaybookKey,
  c: CallRow,
  structured: Record<string, unknown>,
): boolean {
  if (playbookKey === "screening_to_opd") {
    return SUCCESS_INTENTS.has(c.intent ?? "") || !!c.appointment_time;
  }
  if (
    playbookKey === "free_screening_invite" ||
    playbookKey === "free_screening_invite_existing"
  ) {
    // Success for the camp-invite playbooks is "patient said yes to the
    // camp", which the LLM captures as rsvp="yes" — NOT necessarily as
    // intent="interested" (it often emits intent="symptom" or "unclear"
    // alongside a clean rsvp="yes").
    return structured.rsvp === "yes";
  }
  if (playbookKey === "newborn_vaccination") {
    return structured.intent_to_attend === "yes" || SUCCESS_INTENTS.has(c.intent ?? "");
  }
  if (playbookKey === "inbound_reception") {
    return (
      !!structured.resolved ||
      structured.caller_intent === "appointment_request" ||
      structured.caller_intent === "info_request" ||
      !!c.appointment_time
    );
  }
  return SUCCESS_INTENTS.has(c.intent ?? "");
}

/**
 * Mirror the given call's terminal state into call_outcomes.
 * Best-effort: errors are logged, never thrown.
 */
export async function mirrorOutcomeFromCall(
  supabase: AdminClient,
  callId: string,
): Promise<void> {
  try {
    const { data: call, error: callErr } = await supabase
      .from("calls")
      .select(
        "id, clinic_id, campaign_id, status, intent, condition_mentioned, appointment_time, callback_requested, callback_time, suggested_doctor_id, direction",
      )
      .eq("id", callId)
      .maybeSingle();
    if (callErr || !call) {
      console.error(`[mirrorOutcome] call lookup failed callId=${callId}: ${callErr?.message ?? "not found"}`);
      return;
    }

    let useCase: string | null = null;
    if (call.campaign_id) {
      const { data: camp } = await supabase
        .from("campaigns")
        .select("use_case")
        .eq("id", call.campaign_id)
        .maybeSingle();
      useCase = camp?.use_case ?? null;
    }
    // Inbound calls always run the inbound_reception playbook regardless of
    // campaign_id (which is null for inbound today).
    const playbookKey: PlaybookKey =
      (call as { direction?: string }).direction === "inbound"
        ? "inbound_reception"
        : useCase && isValidPlaybookKey(useCase)
          ? (useCase as PlaybookKey)
          : "screening_to_opd";

    let doctorName: string | null = null;
    if (call.suggested_doctor_id) {
      const { data: doc } = await supabase
        .from("doctors")
        .select("name")
        .eq("id", call.suggested_doctor_id)
        .maybeSingle();
      doctorName = doc?.name ?? null;
    }

    // Read any existing call_outcomes row first so mirror can MERGE rather
    // than CLOBBER. The playbook's postProcess often runs first and writes
    // a richer payload (rsvp, companion, preferred_slot, red_flag, ...);
    // we must preserve those fields and never downgrade success or red_flag.
    const { data: existing } = await supabase
      .from("call_outcomes")
      .select("structured, success, red_flag")
      .eq("call_id", callId)
      .maybeSingle();

    const existingStructured =
      (existing?.structured as Record<string, unknown> | null) ?? null;

    const structured = buildStructured(
      playbookKey,
      call as CallRow,
      doctorName,
      existingStructured,
    );
    const computedSuccess = computeSuccess(playbookKey, call as CallRow, structured);
    // Never downgrade truth that the playbook already established.
    const success = computedSuccess || !!existing?.success;
    const red_flag = !!existing?.red_flag;

    const { error: upErr } = await supabase
      .from("call_outcomes")
      .upsert(
        [{
          call_id: callId,
          clinic_id: call.clinic_id,
          playbook_key: playbookKey,
          structured: structured as never,
          success,
          red_flag,
        }],
        { onConflict: "call_id" },
      );
    if (upErr) {
      console.error(`[mirrorOutcome] upsert failed callId=${callId}: ${upErr.message}`);
    }
  } catch (e) {
    console.error(`[mirrorOutcome] unexpected callId=${callId}:`, e instanceof Error ? e.message : e);
  }
}
