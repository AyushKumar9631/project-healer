import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import type { Database, TablesUpdate } from "@/integrations/supabase/types";
import { FOLLOWUP_BP_GLUCOSE, CALLBACK_ASK_TIME } from "@/lib/agent-canonical";
import { resolvePlaybook } from "@/lib/playbooks/registry";
import { runPlaybookTurn } from "@/lib/playbooks/_runner";
import type { PlaybookContext, PlaybookKey } from "@/lib/playbooks/_base";
import { mirrorOutcomeFromCall } from "@/lib/playbooks/_mirror";
import { buildIdentityBlock, resolveAgentGender, normalisePatientGender } from "@/lib/playbooks/_tone";
import {
  loadClinicKnowledge,
  sanitizeAgentReply,
  validateDoctorId,
  validateAgentAddress,
  enforceReplyLength,
} from "@/lib/agent-kb.server";
import { sendAppointmentWhatsappAsync, sendDenialWhatsappAsync } from "@/lib/appointment-whatsapp.server";
import { extractInboundCallData } from "@/lib/inbound-post-call-extractor";

// Consent + callback-time helpers live in src/lib/agent-consent.ts so the
// streaming endpoint (/agent/turn-stream) can reuse them verbatim.
import { isPositiveConsentReply, isNegativeConsentReply, parseCallbackTime } from "@/lib/agent-consent";

// Internal endpoint called by the self-hosted bridge per patient utterance.
// Auth: shared secret in `x-bridge-secret` header.

// Schema for an LLM-generated AgentResult that the streaming endpoint can
// inject so that this legacy route ONLY persists/post-processes the turn
// without re-invoking the LLM. Keep keys aligned with the AgentResult type
// below; all fields nullable so partial models still validate.
const InjectedReplySchema = z.object({
  intent: z.enum([
    "interested",
    "not_interested",
    "busy",
    "symptom",
    "unclear",
    "general_enquiry",
    "appointment_request",
    "follow_up_request",
    "complaint",
    "callback_request",
    "report_enquiry",
    "emergency",
  ]),
  condition: z.string().nullable().optional().default(null),
  suggested_doctor_id: z.string().nullable().optional().default(null),
  appointment_iso: z.string().nullable().optional().default(null),
  callback_requested: z.boolean().optional().default(false),
  callback_time: z.string().nullable().optional().default(null),
  agent_reply: z.string(),
  end_call: z.boolean().optional().default(false),
  // inbound_reception-specific fields passed through from turn-stream.
  // classified_call_type replaces caller_intent as the lock signal.
  classified_call_type: z.string().nullable().optional(),
  topic: z.string().nullable().optional().default(null),
  symptoms_mentioned: z.array(z.string()).optional().default([]),
  red_flag: z.boolean().optional().default(false),
  resolved: z.boolean().optional().default(false),
  // validate_time: when non-null, triggers server-side slot validation instead
  // of normal turn processing. The bridge TTS speaks agent_reply as the hold
  // phrase, then the server validates and re-runs the agent automatically.
  validate_time: z.string().nullable().optional().default(null),
  // Already-loaded clinic KB (rendered text) from turn-stream.ts's context
  // load for this exact turn. When present, this route reuses it instead of
  // calling loadClinicKnowledge again (which would re-derive the same data).
  clinic_kb_rendered: z.string().nullable().optional(),
  // Already-loaded patient/clinic rows + identifiers from turn-stream.ts's
  // context load for this exact turn. When all three are present, this route
  // seeds getCallContext from them instead of re-querying calls/patients/
  // clinics/doctors/clinic_profile/kb_services/kb_faqs/kb_policies.
  patient_snapshot: z
    .object({
      id: z.string(),
      name: z.string(),
      bp: z.string().nullable(),
      blood_sugar: z.string().nullable(),
      health_camp: z.string().nullable(),
      age: z.number().nullable(),
      gender: z.string().nullable(),
      risk: z.string().nullable(),
      phone: z.string(),
    })
    .nullable()
    .optional(),
  clinic_snapshot: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
  clinic_id: z.string().nullable().optional(),
  patient_id: z.string().nullable().optional(),
  campaign_id: z.string().nullable().optional(),
});

const InputSchema = z
  .object({
    callId: z.string().uuid(),
    utterance: z.string().max(2000).optional().default(""),
    isFirstTurn: z.boolean().optional().default(false),
    // When set, this route skips the LLM call and uses this reply for
    // persistence + post-processing. Used by /api/public/agent/turn-stream
    // which has already streamed the reply for sentence-level TTS.
    injectedReply: InjectedReplySchema.optional(),
  })
  .refine((v) => v.isFirstTurn || (v.utterance && v.utterance.trim().length > 0), {
    message: "utterance is required unless isFirstTurn is true",
    path: ["utterance"],
  });

type Phase = "in_conversation" | "scheduling_callback";

export interface AgentResult {
  intent:
    | "interested"
    | "not_interested"
    | "busy"
    | "symptom"
    | "unclear"
    | "general_enquiry"
    | "appointment_request"
    | "follow_up_request"
    | "complaint"
    | "callback_request"
    | "report_enquiry"
    | "emergency";
  condition: string | null;
  suggested_doctor_id: string | null;
  appointment_iso: string | null;
  callback_requested: boolean;
  callback_time: string | null;
  agent_reply: string;
  end_call: boolean;
}

function jsonError(msg: string, where: string, status = 500) {
  console.error(`[agent.turn] FAIL where=${where}: ${msg}`);
  return Response.json({ error: msg, where }, { status });
}

// Verifiable update for the `calls` row. PostgREST `update().eq()` returns
// 204 No Content with no affected-row count, so a dropped/serialised write
// fails silently. Forcing `.select("id")` makes Supabase return the touched
// rows; if length===0 we retry once and, if still empty, log a structured
// `calls_update_failed` event so `bridge/end` can reconcile.
// Coerce a model-emitted callback_time string to a valid ISO-8601 timestamp,
// or null if it can't be interpreted. Tries the Hindi/English natural-language
// parser first ("शनिवार", "kal", "shaam 5 baje"), then a strict Date parse,
// and finally gives up. Used at every site that copies pbOut.callback_time
// into a `calls` update — calls.callback_time is timestamptz and rejects
// anything else, which previously caused entire updates (including transcript
// turns) to be lost. See incident notes in .lovable/plan.md.
function coerceCallbackTime(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  // ISO-like fast path.
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  // Natural-language relative time ("कल शाम 5 बजे", "in an hour").
  try {
    const parsed = parseCallbackTime(s);
    if (parsed?.iso) return parsed.iso;
  } catch {
    // fall through
  }
  // Last-ditch generic Date parse (handles RFC strings etc.).
  const d2 = new Date(s);
  if (!isNaN(d2.getTime())) return d2.toISOString();
  return null;
}

// Fields that the patient-transcript MUST never be coupled to. If a write
// fails because of one of these (e.g. bad timestamp value), retry with a
// transcript-only payload so we never lose conversation history.
const OPTIONAL_UPDATE_FIELDS = [
  "callback_time",
  "callback_requested",
  "condition_mentioned",
  "appointment_time",
  "suggested_doctor_id",
] as const;

async function safeUpdateCall(
  supabase: ReturnType<typeof buildAdminClient>,
  callId: string,
  clinicId: string,
  update: TablesUpdate<"calls">,
  where: string,
): Promise<boolean> {
  let lastErrorMsg: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { data, error } = await supabase.from("calls").update(update).eq("id", callId).select("id");
    if (error) {
      lastErrorMsg = error.message;
      console.error(`[agent.turn] safeUpdateCall FAILED ${where} attempt=${attempt}: ${error.message}`);
    } else if (data && data.length > 0) {
      if (attempt > 1) console.log(`[agent.turn] safeUpdateCall recovered on retry ${where}`);
      return true;
    } else {
      console.error(`[agent.turn] safeUpdateCall NO-OP ${where} attempt=${attempt} callId=${callId}`);
    }
    if (attempt === 1) await new Promise((r) => setTimeout(r, 100));
  }

  // Validation-error rescue: if any optional column might be the culprit
  // (typically a malformed callback_time emitted by the LLM), strip them and
  // retry with only the safe fields so the transcript turn still lands.
  const dropped: Record<string, unknown> = {};
  let hasOptional = false;
  const safeUpdate: TablesUpdate<"calls"> = { ...update };
  for (const k of OPTIONAL_UPDATE_FIELDS) {
    if (k in safeUpdate) {
      hasOptional = true;
      dropped[k] = (safeUpdate as Record<string, unknown>)[k];
      delete (safeUpdate as Record<string, unknown>)[k];
    }
  }
  if (hasOptional) {
    const { data, error } = await supabase.from("calls").update(safeUpdate).eq("id", callId).select("id");
    if (!error && data && data.length > 0) {
      console.log(
        `[agent.turn] safeUpdateCall transcript-only rescue OK ${where} dropped=${Object.keys(dropped).join(",")}`,
      );
      // Audit what we dropped so reconciliation can replay later.
      try {
        await supabase.from("call_events").insert([
          {
            call_id: callId,
            clinic_id: clinicId,
            event_type: "calls_update_partial",
            payload: { where, dropped, original_error: lastErrorMsg } as never,
          },
        ]);
      } catch {}
      return true;
    }
    if (error) {
      console.error(`[agent.turn] safeUpdateCall rescue FAILED ${where}: ${error.message}`);
    }
  }

  // Persist full payload as a structured event so end-of-call reconciliation
  // can replay it.
  try {
    await supabase.from("call_events").insert([
      {
        call_id: callId,
        clinic_id: clinicId,
        event_type: "calls_update_failed",
        payload: { where, update: update as never, error: lastErrorMsg } as never,
      },
    ]);
  } catch (e) {
    console.error(`[agent.turn] failed to log calls_update_failed: ${e instanceof Error ? e.message : e}`);
  }
  return false;
}

function buildAdminClient() {
  const url =
    process.env.SUPABASE_URL ||
    (typeof import.meta !== "undefined"
      ? (import.meta as { env?: Record<string, string> }).env?.VITE_SUPABASE_URL
      : undefined);
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      `Supabase server env missing: SUPABASE_URL=${url ? "set" : "MISSING"} SUPABASE_SERVICE_ROLE_KEY=${key ? "set" : "MISSING"}`,
    );
  }
  return createClient<Database>(url, key, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  });
}

// ---------------------------------------------------------------------------
// isValidFutureSlot — check appointment_iso is a real future time.
// Returns { ok: true } when the slot is ≥ now (with 5-minute grace to handle
// call lag), or { ok: false, reason } when it must be rejected.
// "past" = slot is in the past; "invalid" = not a parseable date.
function isValidFutureSlot(appointmentIso: string): { ok: true } | { ok: false; reason: "past" | "invalid" } {
  const apptDate = new Date(appointmentIso);
  if (isNaN(apptDate.getTime())) return { ok: false, reason: "invalid" };
  // Allow 5-minute grace window so a slot booked "right now" isn't rejected due to call lag
  if (apptDate.getTime() < Date.now() - 5 * 60 * 1000) return { ok: false, reason: "past" };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// checkSlotAvailability — server-side slot conflict check.
//
// Queries the appointments table for any EXISTING booking for the given doctor
// on the same date within a ±15-minute window of the requested time.
// Returns:
//   { available: true }                      — slot is free
//   { available: false; alternatives: [] }   — slot taken; up to 2 nearby free
//                                              half-hour slots suggested
// ---------------------------------------------------------------------------
async function checkSlotAvailability(
  supabase: ReturnType<typeof buildAdminClient>,
  args: {
    doctorId: string;
    clinicId: string;
    requestedIso: string;
  },
): Promise<{ available: true } | { available: false; alternatives: string[] }> {
  const { doctorId, clinicId, requestedIso } = args;
  const reqDate = new Date(requestedIso);
  if (isNaN(reqDate.getTime())) return { available: false, alternatives: [] };

  // Derive YYYY-MM-DD in IST for the requested appointment date.
  const pad = (n: number) => String(n).padStart(2, "0");
  const ist = new Date(reqDate.getTime() + 5.5 * 60 * 60 * 1000);
  const appointmentDate = `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`;

  // Fetch all booked slots for this doctor on the requested date.
  const { data: existing, error } = await supabase
    .from("appointments")
    .select("appointment_time")
    .eq("doctor_id", doctorId)
    .eq("clinic_id", clinicId)
    .eq("appointment_date", appointmentDate)
    .in("status", ["scheduled", "confirmed"]);

  if (error) {
    console.error(`[checkSlotAvailability] query error: ${error.message}`);
    // Fail open — if we can't check, treat as available to avoid blocking the call
    return { available: true };
  }

  const bookedMinutes = new Set<number>();
  for (const row of existing ?? []) {
    if (!row.appointment_time) continue;
    // appointment_time is stored as "HH:MM:SS+05:30"
    const match = String(row.appointment_time).match(/^(\d{1,2}):(\d{2})/);
    if (match) {
      bookedMinutes.add(Number(match[1]) * 60 + Number(match[2]));
    }
  }

  // Requested time in minutes-since-midnight (IST)
  const reqMinutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();

  // Conflict: any booked slot within ±15 minutes of the requested time
  let conflict = false;
  for (const booked of bookedMinutes) {
    if (Math.abs(booked - reqMinutes) <= 15) {
      conflict = true;
      break;
    }
  }

  if (!conflict) return { available: true };

  // Build alternative suggestions: try ±30 and ±60 minute slots
  const offsets = [30, -30, 60, -60, 90, -90];
  const alternatives: string[] = [];
  for (const offset of offsets) {
    if (alternatives.length >= 2) break;
    const altMinutes = reqMinutes + offset;
    if (altMinutes < 0 || altMinutes >= 24 * 60) continue;
    const alreadyBooked = [...bookedMinutes].some((b) => Math.abs(b - altMinutes) <= 15);
    if (!alreadyBooked) {
      // Reconstruct ISO string for the alternative slot
      const altIst = new Date(ist);
      altIst.setUTCHours(Math.floor(altMinutes / 60), altMinutes % 60, 0, 0);
      // Convert back to UTC
      const altUtc = new Date(altIst.getTime() - 5.5 * 60 * 60 * 1000);
      alternatives.push(altUtc.toISOString().replace("Z", "+05:30").replace(/\.\d{3}/, ""));
    }
  }

  return { available: false, alternatives };
}

// ---------------------------------------------------------------------------
// buildSlotValidationSystemMessage — constructs the Hindi System message to
// append to conversation history after slot validation runs.
// ---------------------------------------------------------------------------
function buildSlotValidationSystemMessage(result: {
  isPast: boolean;
  available?: boolean;
  alternatives?: string[];
  requestedIso: string;
}): string {
  const { isPast, available, requestedIso } = result;
  void result.alternatives; // no longer surfaced — agent must not suggest times

  if (isPast) {
    return "वो समय बीत चुका है। कृपया caller को कोई आने वाला समय चुनने को कहें।";
  }

  if (!available) {
    return `Slot already booked for this doctor at the requested time (${requestedIso}). Please ask caller for a different time. Do NOT suggest a specific time yourself.`;
  }

  return `Slot available confirmed for ${requestedIso}. Proceed to booking confirmation (Step 5).`;
}

// upsertAppointment — canonical, single-place appointment row write.
//
// Called directly from the calls-table update block in BOTH the injectedReply
// path and the runPlaybookTurn path. Previously this lived only inside
// inboundReception.postProcess, which meant it was reachable only when:
//   (a) end_call was true, AND
//   (b) postProcess was actually invoked, AND
//   (c) the bridge passed caller_intent through the chain correctly.
// Any gap in that chain silently dropped the row. Moving the insert here —
// alongside the calls update — means it fires whenever we have the two
// required values (appointment_iso + suggested_doctor_id), regardless of
// which code path arrived at that point.
//
// Uses upsert (onConflict: call_id) because appointments.call_id has a
// UNIQUE constraint (isOneToOne=true in the FK). Retrying a failed turn
// would otherwise hit a unique-violation and swallow the error.
// ---------------------------------------------------------------------------
async function upsertAppointment(
  supabase: ReturnType<typeof buildAdminClient>,
  args: {
    callId: string;
    clinicId: string;
    patientId: string;
    doctorId: string;
    appointmentIso: string;
    notes?: string | null;
  },
): Promise<void> {
  const { callId, clinicId, patientId, doctorId, appointmentIso, notes } = args;
  const apptDate = new Date(appointmentIso);
  if (isNaN(apptDate.getTime())) {
    console.warn(`[upsertAppointment] invalid appointmentIso="${appointmentIso}" callId=${callId} — skipping`);
    return;
  }
  // Derive YYYY-MM-DD and HH:MM:SS+05:30 in IST (+05:30).
  // appointment_date is a `date` column — needs "YYYY-MM-DD".
  // appointment_time is a `time with time zone` column — needs "HH:MM:SS+05:30"
  // NOT a full ISO timestamp. Sending toISOString() (e.g. "2026-06-04T11:30:00.000Z")
  // into a timetz column causes PostgreSQL to reject the insert silently.
  const pad = (n: number) => String(n).padStart(2, "0");
  const ist = new Date(apptDate.getTime() + 5.5 * 60 * 60 * 1000);
  const appointmentDate = `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`;
  // timetz value: "HH:MM:SS+05:30"
  const appointmentTimeTz = `${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}+05:30`;

  const { error } = await supabase.from("appointments").upsert(
    {
      call_id: callId,
      clinic_id: clinicId,
      patient_id: patientId,
      doctor_id: doctorId,
      appointment_date: appointmentDate,
      appointment_time: appointmentTimeTz,
      status: "scheduled",
      notes: notes ?? null,
    },
    { onConflict: "call_id" },
  );
  if (error) {
    console.error(
      `[upsertAppointment] FAILED callId=${callId} doctor=${doctorId} appt=${appointmentDate} time=${appointmentTimeTz}: ${error.message}`,
    );
  } else {
    console.log(
      `[upsertAppointment] OK callId=${callId} doctor=${doctorId} date=${appointmentDate} time=${appointmentTimeTz}`,
    );
  }
}

function fallbackGreeting(patientName: string, clinicName: string): AgentResult {
  return {
    intent: "unclear",
    condition: null,
    suggested_doctor_id: null,
    appointment_iso: null,
    callback_requested: false,
    callback_time: null,
    agent_reply: `नमस्ते ${patientName} जी, मैं ${clinicName} से बोल रही हूँ। क्या आप अभी बात कर सकते हैं?`,
    end_call: false,
  };
}

function fallbackReprompt(): AgentResult {
  return {
    intent: "unclear",
    condition: null,
    suggested_doctor_id: null,
    appointment_iso: null,
    callback_requested: false,
    callback_time: null,
    agent_reply: "माफ़ कीजिए, आवाज़ साफ़ नहीं आई। क्या आप दोहरा सकते हैं?",
    end_call: false,
  };
}

// =============================================================
// Per-call KB cache
// -------------------------------------------------------------
// The patient/clinic/doctors/profile/services/faqs/policies tuple does NOT
// change during a single call. Re-fetching all 7 tables every turn was
// adding 300–700ms of Supabase round-trips to every agent reply.
// We cache the resolved context per callId for the call's lifetime.
// `bridge/end` evicts the entry; we also TTL out after 30 min as a safety
// net (Worker recycle is fine — falls back to fresh fetch on cache miss).
// =============================================================
type AdminClient = ReturnType<typeof buildAdminClient>;

async function loadPatient(supabase: AdminClient, id: string) {
  const r = await supabase
    .from("patients")
    .select("id,name,bp,blood_sugar,health_camp,age,gender,risk,phone")
    .eq("id", id)
    .maybeSingle();
  if (r.error) throw new Error(`patient: ${r.error.message}`);
  return r.data;
}
async function loadClinic(supabase: AdminClient, id: string) {
  const r = await supabase.from("clinics").select("id,name").eq("id", id).maybeSingle();
  if (r.error) throw new Error(`clinic: ${r.error.message}`);
  return r.data;
}
async function loadDoctors(supabase: AdminClient, clinicId: string) {
  const r = await supabase
    .from("doctors")
    .select(
      "id,name,specialization,super_specialization,qualifications,experience_years,conditions,languages,availability,consultation_fee,patients_treated,online_consultation",
    )
    .eq("clinic_id", clinicId)
    .order("id", { ascending: true });
  if (r.error) throw new Error(`doctors: ${r.error.message}`);
  return r.data ?? [];
}
async function loadProfile(supabase: AdminClient, clinicId: string) {
  const r = await supabase
    .from("clinic_profile")
    .select("about,address,timings,emergency_phone,departments,accreditations,extra_notes")
    .eq("clinic_id", clinicId)
    .maybeSingle();
  if (r.error) throw new Error(`profile: ${r.error.message}`);
  return r.data;
}
async function loadServices(supabase: AdminClient, clinicId: string) {
  const r = await supabase
    .from("kb_services")
    .select("name,category,description,price_min,price_max,currency,duration_minutes,prep_notes")
    .eq("clinic_id", clinicId)
    .eq("is_active", true)
    .limit(50);
  if (r.error) throw new Error(`services: ${r.error.message}`);
  return r.data ?? [];
}
async function loadFaqs(supabase: AdminClient, clinicId: string) {
  const r = await supabase
    .from("kb_faqs")
    .select("question,answer,tags")
    .eq("clinic_id", clinicId)
    .eq("is_active", true)
    .limit(30);
  if (r.error) throw new Error(`faqs: ${r.error.message}`);
  return r.data ?? [];
}
async function loadPolicies(supabase: AdminClient, clinicId: string) {
  const r = await supabase
    .from("kb_policies")
    .select("title,rule,priority")
    .eq("clinic_id", clinicId)
    .eq("is_active", true)
    .order("priority", { ascending: true })
    .limit(20);
  if (r.error) throw new Error(`policies: ${r.error.message}`);
  return r.data ?? [];
}

type CallContext = {
  call: { id: string; clinic_id: string; patient_id: string; campaign_id: string | null };
  patient: NonNullable<Awaited<ReturnType<typeof loadPatient>>>;
  clinic: NonNullable<Awaited<ReturnType<typeof loadClinic>>>;
  doctors: Awaited<ReturnType<typeof loadDoctors>>;
  clinicProfile: Awaited<ReturnType<typeof loadProfile>>;
  services: Awaited<ReturnType<typeof loadServices>>;
  faqs: Awaited<ReturnType<typeof loadFaqs>>;
  policies: Awaited<ReturnType<typeof loadPolicies>>;
  expiresAt: number;
};

const CTX_TTL_MS = 30 * 60_000;
const callContextCache = new Map<string, CallContext>();

export function evictCallContext(callId: string) {
  callContextCache.delete(callId);
}

// ---------------------------------------------------------------------------
// runInboundPostCallExtraction
// ---------------------------------------------------------------------------
// Fires after end_call=true for inbound_reception calls. Runs the post-call
// LLM extraction to populate all structured fields (appointment, doctor,
// topic, complaint, etc.) and then performs:
//   1. calls table enrichment
//   2. appointments upsert + WhatsApp confirmation (or denial)
//   3. callback table write if outcome = "callback_scheduled"
//   4. call_events log entry
// Completely fire-and-forget from the caller's perspective (caller uses void).
// ---------------------------------------------------------------------------
export async function runInboundPostCallExtraction(args: {
  supabase: ReturnType<typeof buildAdminClient>;
  callId: string;
  clinicId: string;
  patientId: string;
  transcript: Array<{ role: "agent" | "caller"; text: string }>;
  callerIntent: string | null;
  clinicKB: string | null;
}): Promise<void> {
  const { supabase, callId, clinicId, patientId, transcript, callerIntent, clinicKB } = args;
  console.log(`[inbound-extractor] starting post-call extraction callId=${callId} turns=${transcript.length}`);

  let extracted;
  try {
    extracted = await extractInboundCallData({ transcript, callerIntent, clinicKB, callId });
    console.log(
      `[inbound-extractor] extracted callId=${callId} outcome=${extracted.call_outcome} appt=${extracted.appointment_iso ?? "null"} doctor=${extracted.suggested_doctor_id ?? "null"}`,
    );
  } catch (e) {
    console.error(
      `[inbound-extractor] extraction failed callId=${callId}: ${e instanceof Error ? e.message : e}`,
    );
    return;
  }

  // 0. If extractor learned the caller's name and the patient row is still a
  //    placeholder ("Unknown Caller", etc.), update it so future calls greet
  //    the patient by name.
  if (extracted.caller_name) {
    try {
      const { data: patRow } = await supabase
        .from("patients")
        .select("name")
        .eq("id", patientId)
        .maybeSingle();
      const currentName = patRow?.name ?? "";
      // Only overwrite placeholder names — never clobber a real name that
      // was set by a staff member or a previous successful extraction.
      const PLACEHOLDER_NAMES = new Set([
        "unknown caller", "unknown", "anonymous", "guest",
        "n/a", "na", "test", "patient", "caller", "",
      ]);
      if (PLACEHOLDER_NAMES.has(currentName.trim().toLowerCase())) {
        const { error: nameErr } = await supabase
          .from("patients")
          .update({ name: extracted.caller_name })
          .eq("id", patientId);
        if (nameErr) {
          console.error(`[inbound-extractor] patient name update failed patientId=${patientId}: ${nameErr.message}`);
        } else {
          console.log(`[inbound-extractor] updated patient name="${extracted.caller_name}" patientId=${patientId}`);
        }
      }
    } catch (e) {
      console.error(`[inbound-extractor] patient name update threw: ${e instanceof Error ? e.message : e}`);
    }
  }

  // 1. Update the calls table with extracted fields.
  try {
    const callUpdate: TablesUpdate<"calls"> = {};
    if (extracted.topic) callUpdate.condition_mentioned = extracted.topic;
    if (extracted.suggested_doctor_id) callUpdate.suggested_doctor_id = extracted.suggested_doctor_id;
    if (extracted.callback_time) {
      const cb = new Date(extracted.callback_time);
      if (!isNaN(cb.getTime())) {
        callUpdate.callback_time = cb.toISOString();
        callUpdate.callback_requested = true;
      }
    }
    if (extracted.appointment_iso) {
      const appt = new Date(extracted.appointment_iso);
      if (!isNaN(appt.getTime())) {
        callUpdate.appointment_time = appt.toISOString();
      }
    }
    // Derive calls.intent from the extractor's call_outcome — this is the
    // definitive post-call value and overwrites whatever the live-turn wrote.
    // The live-turn derivation is unreliable because classified_call_type is
    // only emitted on Turn 1 and may not survive the bridge passthrough.
    const OUTCOME_TO_INTENT: Record<string, string> = {
      appointment_booked:    "appointment_request",
      callback_scheduled:    "callback_request",
      enquiry_handled:       "general_enquiry",
      complaint_logged:      "complaint",
      emergency_escalated:   "symptom",
      // no_outcome is intentionally omitted — fall through to callerIntent
      // so the live-turn classified_call_type is preserved rather than
      // overwriting it with "unclear".
    };
    // For no_outcome: use the callerIntent that was classified during the live
    // call (stored in calls.outcome.call_type → currentIntent). This prevents
    // a failed or unresolved call from erasing a correctly-classified intent.
    const derivedIntent =
      OUTCOME_TO_INTENT[extracted.call_outcome] ??
      (callerIntent && callerIntent !== "Unidentified" ? callerIntent : "unclear");
    callUpdate.intent = derivedIntent as TablesUpdate<"calls">["intent"];
    // Merge extracted structured data into existing outcome JSON.
    const existingOutcomeRes = await supabase
      .from("calls")
      .select("outcome")
      .eq("id", callId)
      .maybeSingle();
    const existingOutcome =
      typeof existingOutcomeRes.data?.outcome === "object" &&
      existingOutcomeRes.data.outcome !== null &&
      !Array.isArray(existingOutcomeRes.data.outcome)
        ? (existingOutcomeRes.data.outcome as Record<string, unknown>)
        : {};
    callUpdate.outcome = {
      ...existingOutcome,
      call_outcome: extracted.call_outcome,
      caller_name: extracted.caller_name,
      topic: extracted.topic,
      complaint_text: extracted.complaint_text,
      report_requested: extracted.report_requested,
      post_call_extracted: true,
    } as never;

    if (Object.keys(callUpdate).length > 0) {
      await safeUpdateCall(supabase, callId, clinicId, callUpdate, "post_call_extraction");
    }
  } catch (e) {
    console.error(
      `[inbound-extractor] calls update failed callId=${callId}: ${e instanceof Error ? e.message : e}`,
    );
  }

  // 2. Handle appointment booking.
  if (extracted.call_outcome === "appointment_booked" && extracted.appointment_iso && extracted.suggested_doctor_id) {
    try {
      const slotCheck = isValidFutureSlot(extracted.appointment_iso);
      if (slotCheck.ok) {
        await upsertAppointment(supabase, {
          callId,
          clinicId,
          patientId,
          doctorId: extracted.suggested_doctor_id,
          appointmentIso: extracted.appointment_iso,
          notes: extracted.topic ?? null,
        });
        await sendAppointmentWhatsappAsync({
          supabase,
          callId,
          clinicId,
          patientId,
          doctorId: extracted.suggested_doctor_id,
          appointmentIso: extracted.appointment_iso,
        });
        console.log(
          `[inbound-extractor] appointment upserted + WP sent callId=${callId} doctor=${extracted.suggested_doctor_id}`,
        );
      } else {
        console.warn(
          `[inbound-extractor] appointment_iso rejected (${slotCheck.reason}): "${extracted.appointment_iso}" callId=${callId} — sending denial WP`,
        );
        await sendDenialWhatsappAsync({ supabase, callId, clinicId, patientId });
      }
    } catch (e) {
      console.error(
        `[inbound-extractor] appointment upsert/WP failed callId=${callId}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  // 3. Log extraction event.
  try {
    await supabase.from("call_events").insert({
      call_id: callId,
      clinic_id: clinicId,
      event_type: "post_call_extraction",
      payload: { extracted } as never,
    });
  } catch (e) {
    console.error(
      `[inbound-extractor] event log failed callId=${callId}: ${e instanceof Error ? e.message : e}`,
    );
  }
}

async function getCallContext(
  supabase: AdminClient,
  callId: string,
  seed?: {
    call: { id: string; clinic_id: string; patient_id: string; campaign_id: string | null; direction: string };
    patient: CallContext["patient"];
    clinic: CallContext["clinic"];
  },
): Promise<CallContext> {
  const now = Date.now();
  const cached = callContextCache.get(callId);
  if (cached && cached.expiresAt > now) return cached;

  // Fast path: turn-stream.ts already resolved call/patient/clinic for this
  // exact turn and passed it through via injectedReply. Reuse it instead of
  // re-querying calls/patients/clinics (and skip doctors/clinic_profile/
  // kb_services/kb_faqs/kb_policies entirely — those 5 tables are only
  // consumed by the screening_to_opd/outbound branch, never on this path).
  if (seed) {
    const ctx: CallContext = {
      call: seed.call,
      patient: seed.patient,
      clinic: seed.clinic,
      doctors: [],
      clinicProfile: null,
      services: [],
      faqs: [],
      policies: [],
      expiresAt: now + CTX_TTL_MS,
    };
    callContextCache.set(callId, ctx);
    return ctx;
  }

  const callRes = await supabase
    .from("calls")
    .select("id,clinic_id,patient_id,campaign_id,direction")
    .eq("id", callId)
    .maybeSingle();
  if (callRes.error) throw new Error(`call: ${callRes.error.message}`);
  if (!callRes.data) throw new Error("call not found");
  const call = callRes.data;
  const [patient, clinic, doctors, clinicProfile, services, faqs, policies] = await Promise.all([
    loadPatient(supabase, call.patient_id),
    loadClinic(supabase, call.clinic_id),
    loadDoctors(supabase, call.clinic_id),
    loadProfile(supabase, call.clinic_id),
    loadServices(supabase, call.clinic_id),
    loadFaqs(supabase, call.clinic_id),
    loadPolicies(supabase, call.clinic_id),
  ]);
  if (!patient || !clinic) throw new Error("missing patient or clinic context");
  const ctx: CallContext = {
    call,
    patient,
    clinic,
    doctors,
    clinicProfile,
    services,
    faqs,
    policies,
    expiresAt: now + CTX_TTL_MS,
  };
  callContextCache.set(callId, ctx);
  if (callContextCache.size > 256) {
    for (const [k, v] of callContextCache) if (v.expiresAt <= now) callContextCache.delete(k);
  }
  return ctx;
}

export const Route = createFileRoute("/api/public/agent/turn")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const expected = process.env.BRIDGE_SHARED_SECRET;
          if (!expected) return jsonError("BRIDGE_SHARED_SECRET not configured", "env_secret");
          const provided = request.headers.get("x-bridge-secret");
          if (!provided || provided !== expected) {
            return new Response("unauthorized", { status: 401 });
          }

          let body: unknown;
          try {
            body = await request.json();
          } catch {
            return jsonError("bad json body", "parse_body", 400);
          }

          const parsed = InputSchema.safeParse(body);
          if (!parsed.success) {
            return Response.json(
              { error: "invalid input", where: "validate", issues: parsed.error.flatten() },
              { status: 400 },
            );
          }
          const { callId, utterance, isFirstTurn, injectedReply } = parsed.data;
          console.log(
            `[agent.turn] start callId=${callId} isFirstTurn=${isFirstTurn} utteranceLen=${utterance.length} injected=${injectedReply ? "yes" : "no"}`,
          );

          let supabase;
          try {
            supabase = buildAdminClient();
          } catch (e) {
            return jsonError(e instanceof Error ? e.message : String(e), "build_admin");
          }

          // If turn-stream.ts already resolved patient/clinic for this exact
          // turn and passed them through via injectedReply, seed getCallContext
          // with them so a cache MISS doesn't re-query calls/patients/clinics
          // (this is the persistence leg of a turn whose context was already
          // loaded seconds earlier in the same logical turn).
          const ctxSeed =
            injectedReply?.patient_snapshot &&
            injectedReply?.clinic_snapshot &&
            injectedReply?.clinic_id &&
            injectedReply?.patient_id
              ? {
                  call: {
                    id: callId,
                    clinic_id: injectedReply.clinic_id,
                    patient_id: injectedReply.patient_id,
                    campaign_id: injectedReply.campaign_id ?? null,
                    direction: "inbound",
                  },
                  patient: injectedReply.patient_snapshot,
                  clinic: injectedReply.clinic_snapshot,
                }
              : undefined;

          // Static KB context (cached for the lifetime of the call) +
          // dynamic per-turn call fields fetched in parallel.
          const tCtx = Date.now();
          const [ctxResult, dynRes] = await Promise.allSettled([
            getCallContext(supabase, callId, ctxSeed),
            supabase
              .from("calls")
              .select(
                "transcript,intent,outcome,condition_mentioned,suggested_doctor_id,appointment_time,callback_requested,callback_time",
              )
              .eq("id", callId)
              .maybeSingle(),
          ]);
          if (ctxResult.status === "rejected") {
            return jsonError(
              ctxResult.reason instanceof Error ? ctxResult.reason.message : String(ctxResult.reason),
              "db_call_context",
            );
          }
          if (dynRes.status === "rejected" || !dynRes.value || dynRes.value.error || !dynRes.value.data) {
            const msg =
              dynRes.status === "rejected"
                ? dynRes.reason instanceof Error
                  ? dynRes.reason.message
                  : String(dynRes.reason)
                : (dynRes.value?.error?.message ?? "call dynamic fields not found");
            return jsonError(msg, "db_call_dynamic", 404);
          }
          const ctx = ctxResult.value;
          const dyn = dynRes.value.data;
          const call = { ...ctx.call, ...dyn };
          const patient = ctx.patient;
          const clinic = ctx.clinic;

          const transcript = (Array.isArray(dyn.transcript) ? dyn.transcript : []) as Array<{
            role: "agent" | "patient";
            text: string;
          }>;

          const cacheHit = callContextCache.has(callId);
          console.log(
            `[agent.turn] ctx ${cacheHit ? "HIT" : "MISS"} in ${Date.now() - tCtx}ms patient=${patient.name} clinic=${clinic.name} doctors=${ctx.doctors.length}`,
          );

          // -----------------------------------------------------------------
          // Identity Unlock (Mid-Call Promotion)
          // -----------------------------------------------------------------
          // NOTE: effectiveMemory (patient call-history timeline) is intentionally
          // NOT fetched here. It was previously fetched on every turn via
          // fetchPatientCallHistoryContext but never consumed anywhere in this
          // file — the LLM system prompt that uses it is built exclusively in
          // /api/public/agent/turn-stream.ts (injectMemoryToSystemPrompt), which
          // already fetches and caches it. Fetching it again here duplicated that
          // DB query on every single inbound/outbound turn for no used output.
          const isInbound = (call as { direction?: string }).direction === "inbound";
          const transcriptLen = transcript.length;
          const turnNumber = transcriptLen === 0 ? 1 : Math.floor(transcriptLen / 2) + 1;

          // -----------------------------------------------------------------
          // Playbook dispatch: non-screening use-cases (free_screening_invite,
          // newborn_vaccination) run through the modular playbook system. The
          // screening_to_opd path below is unchanged.
          // -----------------------------------------------------------------
          let playbookKey: PlaybookKey = isInbound ? "inbound_reception" : "screening_to_opd";
          let playbookConfig: Record<string, unknown> = {};
          let playbookBaby: PlaybookContext["baby"] = null;
          let playbookDueDoses: PlaybookContext["dueDoses"] = [];
          if (call.campaign_id) {
            const campRes = await supabase
              .from("campaigns")
              .select("use_case")
              .eq("id", call.campaign_id)
              .maybeSingle();
            if (campRes.data?.use_case && !isInbound) {
              playbookKey = campRes.data.use_case as PlaybookKey;
            }
            const cfgRes = await supabase
              .from("campaign_playbook_config")
              .select("config_json")
              .eq("campaign_id", call.campaign_id)
              .maybeSingle();
            playbookConfig = (cfgRes.data?.config_json as Record<string, unknown>) ?? {};
          }

          // Load the full clinic KB for EVERY playbook (not just inbound).
          // Patients on outbound calls also ask about doctors / address /
          // fees / services mid-call — without ground truth the model
          // hallucinates. Cached per clinic for 30 min in agent-kb.server.
          //
          // EXCEPTION: for inbound_reception turns where the streaming
          // endpoint (agent.turn-stream.ts) already loaded this same KB for
          // this same turn and passed it through via injectedReply.clinic_kb_rendered,
          // skip the reload entirely — this is the persistence-only leg of an
          // already-completed turn, so doctors/profile/services/faqs/policies
          // (not used on this path) and the rendered KB text (already in hand)
          // would otherwise be re-fetched/re-derived for no reason.
          let inboundKb: Awaited<ReturnType<typeof loadClinicKnowledge>> | null = null;
          const reuseInjectedKb =
            isInbound && playbookKey === "inbound_reception" && !!injectedReply &&
            injectedReply.clinic_kb_rendered !== undefined && injectedReply.clinic_kb_rendered !== null;
          if (reuseInjectedKb) {
            playbookConfig = { ...playbookConfig, knowledge: injectedReply.clinic_kb_rendered };
            console.log(`[agent.turn] KB reused from injectedReply (skip loadClinicKnowledge) playbook=${playbookKey}`);
          } else {
            try {
              inboundKb = await loadClinicKnowledge(supabase, clinic.id);
              playbookConfig = { ...playbookConfig, knowledge: inboundKb.rendered };
              console.log(
                `[agent.turn] KB loaded playbook=${playbookKey}: doctors=${inboundKb.doctors.length} services=${inboundKb.services.length} faqs=${inboundKb.faqs.length} policies=${inboundKb.policies.length} profile=${inboundKb.profile ? "Y" : "N"}`,
              );
            } catch (e) {
              console.error(`[agent.turn] loadClinicKnowledge failed: ${e instanceof Error ? e.message : e}`);
            }
          }
          if (playbookKey === "newborn_vaccination") {
            const babyRes = await supabase
              .from("babies")
              .select("id,baby_name,parent_name,dob,gender")
              .eq("patient_id", patient.id)
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();
            playbookBaby = babyRes.data ?? null;
            if (playbookBaby) {
              const dosesRes = await supabase
                .from("vaccination_doses")
                .select("id,age_milestone,vaccine_code,due_date")
                .eq("baby_id", playbookBaby.id)
                .eq("status", "due")
                .order("due_date", { ascending: true })
                .limit(10);
              playbookDueDoses = (dosesRes.data ?? []) as PlaybookContext["dueDoses"];
            }
          }

          if (playbookKey !== "screening_to_opd") {
            const playbook = resolvePlaybook(playbookKey);
            const pbCtx: PlaybookContext = {
              callId,
              clinic: { id: clinic.id, name: clinic.name },
              patient: {
                id: patient.id,
                name: patient.name,
                // FIX: phone was missing — inboundReception.buildSystemPrompt uses it
                // in the callerLine and CALLER block. loadPatient already fetches it.
                phone: (patient as { phone?: string | null }).phone ?? null,
                age: patient.age ?? null,
                gender: patient.gender ?? null,
                bp: patient.bp ?? null,
                blood_sugar: patient.blood_sugar ?? null,
                health_camp: patient.health_camp ?? null,
                risk: patient.risk ?? null,
              },
              campaignId: call.campaign_id,
              playbookKey,
              config: {
                ...playbookConfig,
                // currentIntent: prefer the early-classification stored in
                // calls.outcome.call_type (written on Turn 1 by classified_call_type).
                // Fall back to calls.intent (only reaches its terminal value at
                // end-of-call). This lets every turn from Turn 2 onward know the
                // call type without waiting for the booking/resolution to complete.
                currentIntent: (() => {
                  const outcomeCallType =
                    typeof dyn.outcome === "object" &&
                    dyn.outcome !== null &&
                    !Array.isArray(dyn.outcome) &&
                    typeof (dyn.outcome as Record<string, unknown>).call_type === "string"
                      ? ((dyn.outcome as Record<string, unknown>).call_type as string)
                      : null;
                  const rowIntent = (dyn as { intent?: string | null }).intent;
                  // outcomeCallType is the authoritative early-lock.
                  // rowIntent is the semantic turn-level intent (changes as call progresses).
                  // Use outcomeCallType first; fall back to rowIntent; then "Unidentified".
                  return outcomeCallType ?? rowIntent ?? "Unidentified";
                })(),
                // Turn number = number of entries already in transcript before this turn.
                // Each completed turn adds 2 entries (patient + agent), so turn 1 = 0 entries.
                turnNumber: transcript.length === 0 ? 1 : Math.floor(transcript.length / 2) + 1,
              },
              direction: (call as { direction?: string }).direction === "inbound" ? "inbound" : "outbound",
              baby: playbookBaby,
              dueDoses: playbookDueDoses,
            };

            // ---- injectedReply short-circuit (Phase 3) ----
            // If the streaming endpoint already produced a reply for this
            // playbook (today only screening_to_opd; any future streaming
            // expansion will land here too), DO NOT re-run the playbook LLM.
            // Re-running was the cause of audio/transcript divergence: the
            // bridge would TTS the streamed reply while this branch wrote
            // a different (re-LLM'd) reply into transcript.
            if (injectedReply && !injectedReply.validate_time) {
              console.log(
                `[agent.turn] playbook=${playbookKey} using injectedReply (skip LLM) intent=${injectedReply.intent}`,
              );
              try {
                const newTranscript = [
                  ...transcript,
                  ...(isFirstTurn ? [] : [{ role: "patient" as const, text: utterance }]),
                  { role: "agent" as const, text: injectedReply.agent_reply },
                ];
                const update: TablesUpdate<"calls"> = {
                  transcript: newTranscript,
                  // For inbound_reception, derive calls.intent from classified_call_type
                  // (injected Turn-1 value) or from the already-locked currentIntent.
                  intent: (() => {
                    if (playbookKey !== "inbound_reception") return injectedReply.intent;
                    const injAnyCI = injectedReply as Record<string, unknown>;
                    const rawCurrentIntent = (pbCtx.config as { currentIntent?: string }).currentIntent;
                    const ci: string | null =
                      (typeof injAnyCI.classified_call_type === "string" && injAnyCI.classified_call_type) ||
                      (typeof rawCurrentIntent === "string" && rawCurrentIntent !== "Unidentified" && rawCurrentIntent) ||
                      null;
                    const CALL_TYPE_TO_INTENT: Record<string, string> = {
                      appointment_request: "appointment_request",
                      follow_up_request: "follow_up_request",
                      info_request: "general_enquiry",
                      report_enquiry: "report_enquiry",
                      complaint: "complaint",
                      callback_request: "callback_request",
                      symptom: "symptom",
                      other: "interested",
                      unclear: "unclear",
                    };
                    return (ci && CALL_TYPE_TO_INTENT[ci])
                      ? (CALL_TYPE_TO_INTENT[ci] as typeof injectedReply.intent)
                      : injectedReply.intent;
                  })(),
                  status: "in_progress",
                };
                // Lock calls.outcome.call_type from classified_call_type on the
                // first turn it is determined. Never overwritten once set.
                const injAny = injectedReply as Record<string, unknown>;
                const injExistingCallType =
                  typeof dyn.outcome === "object" &&
                  dyn.outcome !== null &&
                  !Array.isArray(dyn.outcome)
                    ? ((dyn.outcome as Record<string, unknown>).call_type as string | undefined)
                    : undefined;
                const injNewCallType =
                  (typeof injAny.classified_call_type === "string" && injAny.classified_call_type) || null;
                if (injNewCallType && !injExistingCallType) {
                  const existingOutcome =
                    typeof dyn.outcome === "object" && dyn.outcome !== null && !Array.isArray(dyn.outcome)
                      ? (dyn.outcome as Record<string, unknown>)
                      : {};
                  update.outcome = { ...existingOutcome, call_type: injNewCallType } as never;
                  console.log(
                    `[agent.turn] injectedReply: call_type locked="${injNewCallType}" → calls.outcome callId=${callId}`,
                  );
                }
                if (injectedReply.callback_requested) {
                  update.callback_requested = true;
                  const cb = coerceCallbackTime(injectedReply.callback_time);
                  if (cb) update.callback_time = cb;
                }
                // Write appointment columns to the calls row whenever both
                // appointment_iso and suggested_doctor_id are present.
                // For inbound_reception, this data comes from post-call extraction
                // (not the live-turn LLM), so skip the mid-call upsert here.
                let apptReadyForInsert = false;
                if (playbookKey !== "inbound_reception" && injectedReply.appointment_iso && injectedReply.suggested_doctor_id) {
                  const apptDate = new Date(injectedReply.appointment_iso);
                  if (!isNaN(apptDate.getTime())) {
                    update.appointment_time = apptDate.toISOString();
                    update.suggested_doctor_id = injectedReply.suggested_doctor_id;
                    apptReadyForInsert = true;
                    console.log(
                      `[agent.turn] injectedReply: appointment_time=${update.appointment_time} suggested_doctor_id=${injectedReply.suggested_doctor_id} callId=${callId}`,
                    );
                  } else {
                    console.warn(
                      `[agent.turn] injectedReply: invalid appointment_iso="${injectedReply.appointment_iso}" callId=${callId}`,
                    );
                  }
                }
                await safeUpdateCall(supabase, callId, call.clinic_id, update, `pb_injected:${playbookKey}`);

                // Upsert the appointments row — only for non-inbound paths.
                // inbound_reception appointments are handled by post-call extraction.
                if (apptReadyForInsert) {
                  const slotCheck = isValidFutureSlot(injectedReply.appointment_iso!);
                  if (slotCheck.ok) {
                    await upsertAppointment(supabase, {
                      callId,
                      clinicId: call.clinic_id,
                      patientId: ctx.patient.id,
                      doctorId: injectedReply.suggested_doctor_id!,
                      appointmentIso: injectedReply.appointment_iso!,
                      notes: (injectedReply as { topic?: string | null }).topic ?? null,
                    });
                    await sendAppointmentWhatsappAsync({
                      supabase,
                      callId,
                      clinicId: call.clinic_id,
                      patientId: ctx.patient.id,
                      doctorId: injectedReply.suggested_doctor_id!,
                      appointmentIso: injectedReply.appointment_iso!,
                    });
                  } else {
                    console.warn(
                      `[agent.turn] appointment_iso rejected (${slotCheck.reason}): "${injectedReply.appointment_iso}" callId=${callId} — skipping upsert, sending denial WP`,
                    );
                    await sendDenialWhatsappAsync({
                      supabase,
                      callId,
                      clinicId: call.clinic_id,
                      patientId: ctx.patient.id,
                    });
                  }
                }

                await supabase.from("call_events").insert({
                  call_id: callId,
                  clinic_id: call.clinic_id,
                  event_type: "agent_turn",
                  payload: {
                    utterance,
                    agent_reply: injectedReply.agent_reply,
                    intent: injectedReply.intent,
                    end_call: injectedReply.end_call,
                    isFirstTurn,
                    playbook: playbookKey,
                    injected: true,
                  },
                });
                if (injectedReply.end_call) {
                  const pbOutForPost = {
                    intent: injectedReply.intent,
                    // postProcess reads lockedCallType from classified_call_type ?? currentIntent
                    classified_call_type: (injectedReply as Record<string, unknown>).classified_call_type as string | null ?? null,
                    agent_reply: injectedReply.agent_reply,
                    end_call: true,
                    callback_requested: injectedReply.callback_requested ?? false,
                    callback_time: injectedReply.callback_time ?? null,
                    suggested_doctor_id: injectedReply.suggested_doctor_id ?? null,
                    appointment_iso: injectedReply.appointment_iso ?? null,
                    topic: injectedReply.topic ?? null,
                    symptoms_mentioned: injectedReply.symptoms_mentioned ?? [],
                    red_flag: injectedReply.red_flag ?? false,
                    resolved: injectedReply.resolved ?? true,
                  };
                  await playbook.postProcess({
                    out: pbOutForPost as never,
                    ctx: pbCtx,
                    supabase,
                    isEndOfCall: true,
                  });
                  console.log(`[agent.turn] injectedReply: postProcess called end_call=true playbook=${playbookKey}`);

                  // Fire post-call extraction asynchronously for inbound_reception.
                  if (playbookKey === "inbound_reception") {
                    const finalTranscript = [
                      ...update.transcript as Array<{ role: "agent" | "patient"; text: string }>,
                    ];
                    // classified_call_type is only on Turn 1; read locked value
                    // from currentIntent (calls.outcome.call_type) for later turns.
                    const injAnyCI3 = injectedReply as Record<string, unknown>;
                    const callerIntent: string | null =
                      (typeof injAnyCI3.classified_call_type === "string" && injAnyCI3.classified_call_type) ||
                      (pbCtx.config as { currentIntent?: string }).currentIntent ||
                      null;
                    const kbRendered = (playbookConfig as { knowledge?: string }).knowledge ?? inboundKb?.rendered ?? null;
                    // CRITICAL: await before returning — Cloudflare Workers kill
                    // unresolved promises the moment Response is returned. Using
                    // void here silently drops ALL appointment writes and WhatsApp
                    // notifications for inbound_reception end-of-call turns.
                    await runInboundPostCallExtraction({
                      supabase,
                      callId,
                      clinicId: call.clinic_id,
                      patientId: ctx.patient.id,
                      transcript: finalTranscript.map((t) => ({ role: t.role === "patient" ? "caller" as const : "agent" as const, text: t.text })),
                      callerIntent,
                      clinicKB: kbRendered,
                    }).catch((e) =>
                      console.error(`[agent.turn] runInboundPostCallExtraction failed (non-fatal): ${e instanceof Error ? e.message : e}`)
                    );
                  }
                }
              } catch (dbErr) {
                console.error(
                  `[agent.turn] injected persist failed (non-fatal): ${dbErr instanceof Error ? dbErr.message : dbErr}`,
                );
              }
              return Response.json({
                intent: injectedReply.intent,
                condition: injectedReply.condition ?? null,
                suggested_doctor_id: injectedReply.suggested_doctor_id ?? null,
                appointment_iso: injectedReply.appointment_iso ?? null,
                callback_requested: injectedReply.callback_requested ?? false,
                callback_time: injectedReply.callback_time ?? null,
                agent_reply: injectedReply.agent_reply,
                end_call: injectedReply.end_call ?? false,
              });
            }

            // ---- Zero-latency fast-paths for free_screening_invite_existing ----
            // Mirrors the screening_to_opd consent fast-paths so the bridge
            // can play pre-cached FOLLOWUP_BP_GLUCOSE / CALLBACK_ASK_TIME audio.
            if (playbookKey === "free_screening_invite_existing") {
              const isConsentTurn =
                !isFirstTurn &&
                (transcript.length === 0 || (transcript.length === 1 && transcript[0]?.role === "agent"));
              if (isConsentTurn && isPositiveConsentReply(utterance)) {
                console.log(`[agent.turn] playbook=${playbookKey} consent-positive fast-path → FOLLOWUP_BP_GLUCOSE`);
                const fastReply = FOLLOWUP_BP_GLUCOSE;
                try {
                  const newTranscript = [
                    ...transcript,
                    { role: "patient" as const, text: utterance },
                    { role: "agent" as const, text: fastReply },
                  ];
                  await safeUpdateCall(
                    supabase,
                    callId,
                    call.clinic_id,
                    {
                      transcript: newTranscript,
                      intent: "interested",
                      status: "in_progress",
                    } as TablesUpdate<"calls">,
                    `pb_fast_consent_positive:${playbookKey}`,
                  );
                  await supabase.from("call_events").insert({
                    call_id: callId,
                    clinic_id: call.clinic_id,
                    event_type: "agent_turn",
                    payload: {
                      utterance,
                      agent_reply: fastReply,
                      intent: "interested",
                      end_call: false,
                      isFirstTurn: false,
                      playbook: playbookKey,
                      fast_path: "consent_positive",
                    },
                  });
                } catch (dbErr) {
                  console.error(
                    `[agent.turn] fast-path persist failed (non-fatal): ${dbErr instanceof Error ? dbErr.message : dbErr}`,
                  );
                }
                return Response.json({
                  intent: "interested",
                  condition: null,
                  suggested_doctor_id: null,
                  appointment_iso: null,
                  callback_requested: false,
                  callback_time: null,
                  agent_reply: fastReply,
                  end_call: false,
                });
              }
              if (isConsentTurn && isNegativeConsentReply(utterance)) {
                console.log(`[agent.turn] playbook=${playbookKey} consent-negative fast-path → callback`);
                const t = parseCallbackTime(utterance);
                const fastReply = t ? `ठीक है, मैं आपको ${t.human} पर कॉल करूँगी। धन्यवाद, नमस्ते।` : CALLBACK_ASK_TIME;
                const endNow = !!t;
                try {
                  const newTranscript = [
                    ...transcript,
                    { role: "patient" as const, text: utterance },
                    { role: "agent" as const, text: fastReply },
                  ];
                  const update: TablesUpdate<"calls"> = {
                    transcript: newTranscript,
                    intent: "busy",
                    status: "in_progress",
                    callback_requested: true,
                  };
                  if (t) update.callback_time = t.iso;
                  await safeUpdateCall(
                    supabase,
                    callId,
                    call.clinic_id,
                    update,
                    `pb_fast_consent_negative:${playbookKey}`,
                  );
                  await supabase.from("call_events").insert({
                    call_id: callId,
                    clinic_id: call.clinic_id,
                    event_type: "agent_turn",
                    payload: {
                      utterance,
                      agent_reply: fastReply,
                      intent: "busy",
                      end_call: endNow,
                      isFirstTurn: false,
                      playbook: playbookKey,
                      fast_path: "consent_negative",
                    },
                  });
                } catch (dbErr) {
                  console.error(
                    `[agent.turn] fast-path persist failed (non-fatal): ${dbErr instanceof Error ? dbErr.message : dbErr}`,
                  );
                }
                return Response.json({
                  intent: "busy",
                  condition: null,
                  suggested_doctor_id: null,
                  appointment_iso: null,
                  callback_requested: true,
                  callback_time: t?.iso ?? null,
                  agent_reply: fastReply,
                  end_call: endNow,
                });
              }
            }

            let pbOut;
            if (injectedReply && injectedReply.validate_time) {
              // turn-stream.ts already streamed injectedReply.agent_reply
              // (the hold phrase) to the bridge as TTS chunks before this
              // request was made. Seed pbOut from it so the existing
              // VALIDATE_TIME LOOP below runs unchanged — same as it already
              // does on the non-streaming fallback path — instead of
              // re-running the LLM for a reply the caller already heard.
              console.log(
                `[agent.turn] playbook=${playbookKey} using injectedReply.validate_time (skip LLM, enter validate_time loop) callId=${callId}`,
              );
              pbOut = injectedReply as never;
            } else {
            try {
              pbOut = await runPlaybookTurn({
                playbook,
                ctx: pbCtx,
                utterance,
                isFirstTurn,
                history: transcript.slice(-12),
              });
            } catch (aiErr) {
              console.error(
                `[agent.turn] playbook=${playbookKey} AI failed: ${aiErr instanceof Error ? aiErr.message : aiErr}`,
              );
              pbOut = {
                intent: "unclear" as const,
                agent_reply: "माफ़ कीजिए, आवाज़ साफ़ नहीं आई। क्या आप दोहरा सकते हैं?",
                end_call: false,
                callback_requested: false,
                callback_time: null,
              } as never;
            }
            }

            // ---------------------------------------------------------------
            // VALIDATE_TIME LOOP — inbound_reception only.
            //
            // When the LLM emits validate_time (non-null), it is requesting
            // server-side slot validation. The flow:
            //   1. Speak the agent_reply hold phrase to the caller via TTS
            //      (handled by the bridge — we just return it normally).
            //   2. Run past-time check + slot conflict check here.
            //   3. Append a System message to the working history.
            //   4. Re-invoke runPlaybookTurn immediately (no caller input).
            //   5. Repeat if the LLM emits validate_time again (max 3 loops
            //      to prevent infinite recursion on LLM misbehaviour).
            //
            // The bridge TTS-plays the first agent_reply (hold phrase) before
            // calling /agent/turn for the next caller utterance. So the final
            // pbOut after this loop is what the bridge will TTS next — which
            // will be either the slot-unavailable ask or the booking confirmation.
            // ---------------------------------------------------------------
            // Tracks whether the validate_time loop wrote new entries to the
            // DB transcript during THIS turn (as opposed to a prior turn).
            // Used by the persist block below to decide whether to re-fetch
            // the DB transcript as the base (avoiding clobbering this turn's
            // intermediate hold-phrase / System entries).
            let validationLoopRanThisTurn = false;
            // Running copy of the full DB transcript, accumulated across
            // validation-loop iterations so intermediate writes don't
            // clobber each other (see persist block below). Declared here
            // (outer scope) so the persist block can use it as a fallback.
            let accumulatedTranscript: typeof transcript = transcript;

            if (playbookKey === "inbound_reception") {
              // Working copy of history that accumulates System messages.
              // Explicitly typed to include "system" role so TypeScript allows
              // passing it to runPlaybookTurn (whose Turn type now includes system).
              let workingHistory: Array<{ role: "agent" | "patient" | "system"; text: string }> = transcript.slice(-12);
              const MAX_VALIDATION_LOOPS = 3;

              for (let vLoop = 0; vLoop < MAX_VALIDATION_LOOPS; vLoop++) {
                const pbAnyVT = pbOut as unknown as {
                  validate_time?: string | null;
                  suggested_doctor_id?: string | null;
                  agent_reply?: string;
                };
                const validateTime = pbAnyVT.validate_time;
                if (!validateTime) break; // No validation requested — normal flow

                console.log(
                  `[agent.turn] validate_time loop ${vLoop + 1} requestedIso="${validateTime}" doctorId="${pbAnyVT.suggested_doctor_id ?? "null"}" callId=${callId}`,
                );

                // Step 1: Record the hold-phrase turn into working history so
                // the LLM sees it in the next iteration. Use patient utterance
                // for first loop (it contains the stated time), then empty.
                workingHistory = [
                  ...workingHistory,
                  ...(vLoop === 0 ? [{ role: "patient" as const, text: utterance }] : []),
                  { role: "agent" as const, text: pbAnyVT.agent_reply ?? "kripya pratikshe karein" },
                ];

                // Step 2: Past-time check
                const futureCheck = isValidFutureSlot(validateTime);
                let systemMsg: string;

                if (!futureCheck.ok && futureCheck.reason === "past") {
                  systemMsg = buildSlotValidationSystemMessage({ isPast: true, requestedIso: validateTime });
                  console.log(`[agent.turn] validate_time: past-time rejected callId=${callId}`);
                } else if (!futureCheck.ok && futureCheck.reason === "invalid") {
                  systemMsg = `validate_time value "${validateTime}" could not be parsed as a date. Please ask caller to repeat the time more clearly.`;
                  console.warn(`[agent.turn] validate_time: invalid ISO callId=${callId}`);
                } else {
                  // Step 3: Slot conflict check
                  const doctorId = pbAnyVT.suggested_doctor_id ?? null;
                  let slotResult: { available: true } | { available: false; alternatives: string[] } = { available: true };
                  if (doctorId) {
                    slotResult = await checkSlotAvailability(supabase, {
                      doctorId,
                      clinicId: call.clinic_id,
                      requestedIso: validateTime,
                    });
                  } else {
                    console.warn(`[agent.turn] validate_time: no suggested_doctor_id — skipping conflict check callId=${callId}`);
                  }
                  systemMsg = buildSlotValidationSystemMessage({
                    isPast: false,
                    available: slotResult.available,
                    alternatives: slotResult.available ? [] : (slotResult as { available: false; alternatives: string[] }).alternatives,
                    requestedIso: validateTime,
                  });
                  console.log(
                    `[agent.turn] validate_time: slotAvailable=${slotResult.available} callId=${callId}`,
                  );
                }

                // Was this validation a rejection (past time or slot taken)?
                // Rejections require the CALLER to supply a new time — the
                // loop must not auto-continue past this point even if the
                // re-run LLM tries to emit another validate_time for an
                // alternative it picked itself.
                const isRejection =
                  (!futureCheck.ok && (futureCheck.reason === "past" || futureCheck.reason === "invalid")) ||
                  systemMsg.startsWith("Slot already booked");

                // Step 4: Append System message and re-run the LLM
                workingHistory = [
                  ...workingHistory,
                  { role: "system" as const, text: systemMsg },
                ];

                // Persist the System message into the DB transcript so the
                // conversation record is complete and the KB/extractor can see it.
                // Accumulate across loop iterations so earlier loops' entries
                // (hold phrase + System message) aren't overwritten.
                accumulatedTranscript = [
                  ...accumulatedTranscript,
                  ...(vLoop === 0 && !isFirstTurn ? [{ role: "patient" as const, text: utterance }] : []),
                  { role: "agent" as const, text: pbAnyVT.agent_reply ?? "kripya pratikshe karein" },
                  { role: "system" as const, text: systemMsg },
                ];
                validationLoopRanThisTurn = true;
                try {
                  await supabase
                    .from("calls")
                    .update({ transcript: accumulatedTranscript })
                    .eq("id", callId);
                } catch (dbSysErr) {
                  console.warn(`[agent.turn] validate_time: system-msg DB write failed (non-fatal): ${dbSysErr instanceof Error ? dbSysErr.message : dbSysErr}`);
                }

                // Step 5: Re-run the LLM with updated history (no caller utterance)
                try {
                  pbOut = await runPlaybookTurn({
                    playbook,
                    ctx: pbCtx,
                    utterance: "", // No new caller input — system drove this turn
                    isFirstTurn: false,
                    history: workingHistory,
                  });
                } catch (rerunErr) {
                  console.error(`[agent.turn] validate_time: re-run LLM failed loop=${vLoop + 1}: ${rerunErr instanceof Error ? rerunErr.message : rerunErr}`);
                  pbOut = {
                    intent: "unclear" as const,
                    agent_reply: "माफ़ कीजिए, कृपया दोबारा समय बताइए।",
                    end_call: false,
                    callback_requested: false,
                    callback_time: null,
                  } as never;
                  break;
                }

                if (isRejection) {
                  // The LLM's reply here is the caller-facing question asking
                  // for a different time. Strip any validate_time / end_call
                  // it may have produced (it should not have, but the model
                  // sometimes self-selects an alternative and re-validates).
                  // This forces the turn to end and wait for real caller input.
                  const pbAnyRej = pbOut as unknown as {
                    validate_time?: string | null;
                    end_call?: boolean;
                  };
                  if (pbAnyRej.validate_time) {
                    console.warn(
                      `[agent.turn] validate_time: rejection follow-up emitted another validate_time — discarding to force caller turn callId=${callId}`,
                    );
                    pbAnyRej.validate_time = null;
                  }
                  if (pbAnyRej.end_call) {
                    console.warn(
                      `[agent.turn] validate_time: rejection follow-up set end_call=true — forcing false callId=${callId}`,
                    );
                    pbAnyRej.end_call = false;
                  }
                  break;
                }
              }
            }

            // ---------------------------------------------------------------
            // Defensive guard: for free-screening playbooks, never let the LLM
            // hang up on the very turn a symptom / red-flag is first heard
            // without delivering the camp invite. Root cause of incident
            // 359025da-9c97-4420-916e-c2a64e067053 — model exited after
            // acknowledging chest pain instead of inviting to the camp.
            // ---------------------------------------------------------------
            try {
              const isFreeScreening =
                playbookKey === "free_screening_invite_existing" || playbookKey === "free_screening_invite";
              if (isFreeScreening) {
                const pbAny = pbOut as unknown as {
                  red_flag?: boolean;
                  symptoms_mentioned?: string[];
                  rsvp?: string;
                  end_call?: boolean;
                  agent_reply?: string;
                  intent?: string;
                };
                const hasSymptoms =
                  pbAny.red_flag === true ||
                  (Array.isArray(pbAny.symptoms_mentioned) && pbAny.symptoms_mentioned.length > 0);
                const rsvpUnknown = !pbAny.rsvp || pbAny.rsvp === "unclear";
                if (hasSymptoms && rsvpUnknown && pbAny.end_call === true) {
                  // Force the call to stay open and append the camp invite if
                  // the model did not include one.
                  const cfg = (playbookConfig ?? {}) as { camp_date_iso?: string; venue?: string; address?: string };
                  const HI_DAYS = ["रविवार", "सोमवार", "मंगलवार", "बुधवार", "गुरुवार", "शुक्रवार", "शनिवार"];
                  const HI_MONTHS = [
                    "जनवरी",
                    "फरवरी",
                    "मार्च",
                    "अप्रैल",
                    "मई",
                    "जून",
                    "जुलाई",
                    "अगस्त",
                    "सितंबर",
                    "अक्टूबर",
                    "नवंबर",
                    "दिसंबर",
                  ];
                  let dateH = "इस हफ्ते";
                  if (cfg.camp_date_iso) {
                    const d = new Date(cfg.camp_date_iso);
                    const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
                    dateH = `${HI_DAYS[ist.getUTCDay()]} ${ist.getUTCDate()} ${HI_MONTHS[ist.getUTCMonth()]}`;
                  }
                  const clinicName = pbCtx.clinic.name ?? "क्लिनिक";
                  const address = cfg.address || cfg.venue || clinicName;
                  const reply = pbAny.agent_reply ?? "";
                  const alreadyHasInvite = /free\s*screening|आ पाएँगी|आ पाएंगी|क्या आप आ/.test(reply);
                  const inviteSuffix = ` और इसी से जुड़ा — हम ${dateH} को ${clinicName}, ${address} पर एक free screening कर रहे हैं, वहाँ BP और Sugar फिर से check हो जाएगा। क्या आप आ पाएँगी?`;
                  pbOut = {
                    ...pbOut,
                    end_call: false,
                    intent: "symptom",
                    agent_reply: alreadyHasInvite ? reply : reply.trim() + inviteSuffix,
                  } as typeof pbOut;
                  console.log(
                    `[agent.turn] playbook=${playbookKey} red-flag-guard: forced end_call=false, invite ${alreadyHasInvite ? "kept" : "appended"}`,
                  );
                }
              }
            } catch (guardErr) {
              console.error(
                `[agent.turn] red-flag guard non-fatal: ${guardErr instanceof Error ? guardErr.message : guardErr}`,
              );
            }

            // Sanitize spoken reply: strip [brackets], (id: ...), bare UUIDs
            // the model occasionally leaks into the Hindi sentence.
            try {
              const pbAnyR = pbOut as unknown as { agent_reply?: string; suggested_doctor_id?: string | null };
              if (typeof pbAnyR.agent_reply === "string") {
                const after = sanitizeAgentReply(pbAnyR.agent_reply);
                if (after !== pbAnyR.agent_reply) {
                  console.warn(`[agent.turn] sanitized reply (UUID/brackets) playbook=${playbookKey}`);
                  pbAnyR.agent_reply = after;
                }
              }
              if (inboundKb && typeof pbAnyR.suggested_doctor_id === "string") {
                const v = validateDoctorId(pbAnyR.suggested_doctor_id, inboundKb.doctorIds);
                if (!v.valid) {
                  console.warn(
                    `[agent.turn] hallucinated suggested_doctor_id="${pbAnyR.suggested_doctor_id}" — nulled`,
                  );
                  pbAnyR.suggested_doctor_id = null;
                }
              }
              // Address-hallucination guard. Only enforced for inbound_reception
              // (where the LLM has wide latitude). For outbound playbooks the
              // address is template-injected, and the heuristic was rewriting
              // legitimate camp-invite replies. We dry-run for outbound so any
              // real drift still shows in logs.
              if (typeof pbAnyR.agent_reply === "string") {
                const cfg = (playbookConfig ?? {}) as { address?: string; venue?: string };
                const cfgAddress = cfg.address || cfg.venue || "";
                const profileAddress = inboundKb?.profile?.address ?? "";
                const safeAddress = cfgAddress || profileAddress || call.clinic_id;
                if (safeAddress) {
                  const safeReply = `यह ${clinic.name}, ${safeAddress} पर है।`;
                  const verdict = validateAgentAddress({
                    reply: pbAnyR.agent_reply,
                    addressSources: [cfgAddress, profileAddress, cfg.venue, clinic.name],
                    safeReply,
                  });
                  const runAddressGuard = playbookKey === "inbound_reception";
                  if (!verdict.ok) {
                    if (runAddressGuard) {
                      console.warn(
                        `[agent.turn] address-guard rewrote reply playbook=${playbookKey} original="${pbAnyR.agent_reply.slice(0, 200)}"`,
                      );
                      pbAnyR.agent_reply = verdict.replacement;
                    } else {
                      console.warn(
                        `[agent.turn] address-guard DRY-RUN would have rewritten on playbook=${playbookKey} — skipped. original="${pbAnyR.agent_reply.slice(0, 200)}"`,
                      );
                    }
                  }
                }
              }
              // Hard length cap — trim overflow before TTS.
              if (typeof pbAnyR.agent_reply === "string") {
                const lenCheck = enforceReplyLength(pbAnyR.agent_reply);
                if (lenCheck.trimmed) {
                  console.warn(
                    `[agent.turn] length-cap trimmed playbook=${playbookKey} ${lenCheck.originalWords}→${lenCheck.finalWords}w callId=${callId}`,
                  );
                  pbAnyR.agent_reply = lenCheck.reply;
                  pbOut.agent_reply = lenCheck.reply;
                }
              }
            } catch {}

            // Persist transcript + canonical call columns (best-effort).
            // IMPORTANT: When the validate_time loop ran, it already wrote
            // intermediate hold-phrase + System messages to the DB. The final
            // persist here must include those entries so the conversation record
            // is complete. We re-fetch the latest transcript from the DB when
            // a validation loop ran, rather than reconstructing from scratch.
            try {
              let baseTranscript = transcript;

              // If the validate_time loop ran THIS turn, the DB already has
              // the accumulated state (patient utterance + hold phrase(s) +
              // System message(s)) written inside the loop. Fetch the latest
              // DB transcript to use as the base so we don't lose those
              // intermediate entries — and so we don't clobber them by
              // falling back to the stale pre-turn `transcript` below.
              if (playbookKey === "inbound_reception" && validationLoopRanThisTurn) {
                // Fetch fresh transcript from DB in case the validate_time loop
                // wrote System entries since `transcript` was loaded.
                const freshDyn = await supabase
                  .from("calls")
                  .select("transcript")
                  .eq("id", callId)
                  .maybeSingle();
                const freshTranscript = Array.isArray(freshDyn.data?.transcript)
                  ? (freshDyn.data!.transcript as Array<{ role: string; text: string }>)
                  : null;
                // Use the fresh DB transcript if available; otherwise fall
                // back to the in-memory accumulatedTranscript (built inside
                // the loop) so we still don't clobber this turn's System
                // entries with the stale pre-turn `transcript`.
                const loopTranscript = freshTranscript ?? accumulatedTranscript;
                {
                  // Loop ran and wrote System entries — use loopTranscript as
                  // base and only append the final agent reply (patient entry
                  // already included).
                  baseTranscript = loopTranscript as typeof transcript;
                  const newTranscript = [
                    ...baseTranscript,
                    { role: "agent" as const, text: pbOut.agent_reply },
                  ];
                  const update: TablesUpdate<"calls"> = {
                    transcript: newTranscript,
                    intent: (() => {
                      if (playbookKey !== "inbound_reception") return pbOut.intent;
                      const pbAnyCI = pbOut as unknown as { classified_call_type?: string | null };
                      const rawCurrentIntent = (pbCtx.config as { currentIntent?: string }).currentIntent;
                      const ci: string | null =
                        pbAnyCI.classified_call_type ||
                        (typeof rawCurrentIntent === "string" && rawCurrentIntent !== "Unidentified" && rawCurrentIntent) ||
                        null;
                      const CALL_TYPE_TO_INTENT: Record<string, string> = {
                        appointment_request: "appointment_request",
                        follow_up_request: "follow_up_request",
                        info_request: "general_enquiry",
                        report_enquiry: "report_enquiry",
                        complaint: "complaint",
                        callback_request: "callback_request",
                        symptom: "symptom",
                        other: "interested",
                        unclear: "unclear",
                      };
                      return (ci && CALL_TYPE_TO_INTENT[ci]) ? CALL_TYPE_TO_INTENT[ci] as typeof pbOut.intent : "unclear" as typeof pbOut.intent;
                    })(),
                    status: "in_progress",
                  };
                  const pbAnyCallTypeVT = pbOut as unknown as { classified_call_type?: string | null };
                  const existingCallTypeVT =
                    typeof dyn.outcome === "object" && dyn.outcome !== null && !Array.isArray(dyn.outcome)
                      ? ((dyn.outcome as Record<string, unknown>).call_type as string | undefined)
                      : undefined;
                  const newCallTypeVT = pbAnyCallTypeVT.classified_call_type || null;
                  if (newCallTypeVT && !existingCallTypeVT) {
                    const existingOutcome =
                      typeof dyn.outcome === "object" && dyn.outcome !== null && !Array.isArray(dyn.outcome)
                        ? (dyn.outcome as Record<string, unknown>)
                        : {};
                    update.outcome = { ...existingOutcome, call_type: newCallTypeVT } as never;
                  }
                  await safeUpdateCall(supabase, callId, call.clinic_id, update, `pb_turn_vt_final:${playbookKey}`);

                  await supabase.from("call_events").insert({
                    call_id: callId,
                    clinic_id: call.clinic_id,
                    event_type: "agent_turn",
                    payload: {
                      utterance,
                      agent_reply: pbOut.agent_reply,
                      intent: pbOut.intent,
                      end_call: pbOut.end_call,
                      isFirstTurn,
                      playbook: playbookKey,
                      validate_time_loop: true,
                    },
                  });
                  await playbook.postProcess({
                    out: pbOut,
                    ctx: pbCtx,
                    supabase,
                    isEndOfCall: pbOut.end_call,
                  });
                  if (pbOut.end_call && playbookKey === "inbound_reception") {
                    const pbAnyCI2 = pbOut as unknown as { classified_call_type?: string | null };
                    const callerIntent: string | null =
                      pbAnyCI2.classified_call_type ||
                      (pbCtx.config as { currentIntent?: string }).currentIntent ||
                      null;
                    const kbRendered = (playbookConfig as { knowledge?: string }).knowledge ?? inboundKb?.rendered ?? null;
                    await runInboundPostCallExtraction({
                      supabase,
                      callId,
                      clinicId: call.clinic_id,
                      patientId: ctx.patient.id,
                      transcript: newTranscript.map((t) => ({ role: t.role === "patient" ? "caller" as const : "agent" as const, text: t.text })),
                      callerIntent,
                      clinicKB: kbRendered,
                    }).catch((e) =>
                      console.error(`[agent.turn] runInboundPostCallExtraction failed (non-fatal): ${e instanceof Error ? e.message : e}`)
                    );
                  }
                  return Response.json({
                    intent: pbOut.intent,
                    condition: null,
                    suggested_doctor_id: null,
                    appointment_iso: null,
                    callback_requested: pbOut.callback_requested,
                    callback_time: coerceCallbackTime(pbOut.callback_time),
                    agent_reply: pbOut.agent_reply,
                    end_call: pbOut.end_call,
                  });
                }
              }

              const newTranscript = [
                ...transcript,
                ...(isFirstTurn ? [] : [{ role: "patient" as const, text: utterance }]),
                { role: "agent" as const, text: pbOut.agent_reply },
              ];
              const update: TablesUpdate<"calls"> = {
                transcript: newTranscript,
                // For inbound_reception, derive calls.intent from classified_call_type
                // (emitted Turn 1 only) or from the already-locked currentIntent in
                // calls.outcome.call_type so the column never defaults to "unclear".
                intent: (() => {
                  if (playbookKey !== "inbound_reception") return pbOut.intent;
                  const pbAnyCI = pbOut as unknown as { classified_call_type?: string | null };
                  const rawCurrentIntent = (pbCtx.config as { currentIntent?: string }).currentIntent;
                  const ci: string | null =
                    pbAnyCI.classified_call_type ||
                    (typeof rawCurrentIntent === "string" && rawCurrentIntent !== "Unidentified" && rawCurrentIntent) ||
                    null;
                  const CALL_TYPE_TO_INTENT: Record<string, string> = {
                    appointment_request: "appointment_request",
                    follow_up_request: "follow_up_request",
                    info_request: "general_enquiry",
                    report_enquiry: "report_enquiry",
                    complaint: "complaint",
                    callback_request: "callback_request",
                    symptom: "symptom",
                    other: "interested",
                    unclear: "unclear",
                  };
                  return (ci && CALL_TYPE_TO_INTENT[ci]) ? CALL_TYPE_TO_INTENT[ci] as typeof pbOut.intent : "unclear" as typeof pbOut.intent;
                })(),
                status: "in_progress",
              };
              // Write classified_call_type to calls.outcome.call_type on the turn it
              // is first emitted (Turn 1 classification). Once written, it is NEVER
              // overwritten — the existing early-lock takes precedence.
              const pbAnyCallType = pbOut as unknown as {
                classified_call_type?: string | null;
              };
              const existingCallType =
                typeof dyn.outcome === "object" &&
                dyn.outcome !== null &&
                !Array.isArray(dyn.outcome)
                  ? ((dyn.outcome as Record<string, unknown>).call_type as string | undefined)
                  : undefined;
              const newCallType = pbAnyCallType.classified_call_type || null;
              if (newCallType && !existingCallType) {
                const existingOutcome =
                  typeof dyn.outcome === "object" && dyn.outcome !== null && !Array.isArray(dyn.outcome)
                    ? (dyn.outcome as Record<string, unknown>)
                    : {};
                update.outcome = { ...existingOutcome, call_type: newCallType } as never;
                console.log(
                  `[agent.turn] call_type locked="${newCallType}" → calls.outcome callId=${callId}`,
                );
              }
              if (pbOut.callback_requested) {
                update.callback_requested = true;
                const cb = coerceCallbackTime(pbOut.callback_time);
                if (cb) update.callback_time = cb;
                else if (pbOut.callback_time) {
                  console.warn(
                    `[agent.turn] dropped non-ISO callback_time="${pbOut.callback_time}" playbook=${playbookKey}`,
                  );
                }
              }
              // Surface clinical signals from playbooks that capture them.
              const pbAny = pbOut as unknown as {
                symptoms_mentioned?: string[];
                condition?: string | null;
                appointment_iso?: string | null;
                suggested_doctor_id?: string | null;
                topic?: string | null;
              };
              if (Array.isArray(pbAny.symptoms_mentioned) && pbAny.symptoms_mentioned.length > 0) {
                update.condition_mentioned = pbAny.symptoms_mentioned.join(", ");
              } else if (pbAny.condition) {
                update.condition_mentioned = pbAny.condition;
              }
              // Write appointment columns whenever a booking is in progress
              // (both fields present). Only for non-inbound playbooks —
              // inbound_reception appointment data comes from post-call extraction.
              let pbApptReady = false;
              if (playbookKey !== "inbound_reception" && pbAny.appointment_iso && pbAny.suggested_doctor_id) {
                const apptDate = new Date(pbAny.appointment_iso);
                if (!isNaN(apptDate.getTime())) {
                  update.appointment_time = apptDate.toISOString();
                  update.suggested_doctor_id = pbAny.suggested_doctor_id;
                  pbApptReady = true;
                }
              }
              await safeUpdateCall(supabase, callId, call.clinic_id, update, `pb_turn:${playbookKey}`);

              // Upsert appointments row — non-inbound only.
              if (pbApptReady) {
                const slotCheck = isValidFutureSlot(pbAny.appointment_iso!);
                if (slotCheck.ok) {
                  await upsertAppointment(supabase, {
                    callId,
                    clinicId: call.clinic_id,
                    patientId: ctx.patient.id,
                    doctorId: pbAny.suggested_doctor_id!,
                    appointmentIso: pbAny.appointment_iso!,
                    notes: pbAny.topic ?? null,
                  });
                  await sendAppointmentWhatsappAsync({
                    supabase,
                    callId,
                    clinicId: call.clinic_id,
                    patientId: ctx.patient.id,
                    doctorId: pbAny.suggested_doctor_id!,
                    appointmentIso: pbAny.appointment_iso!,
                  });
                } else {
                  console.warn(
                    `[agent.turn] appointment_iso rejected (${slotCheck.reason}): "${pbAny.appointment_iso}" callId=${callId} — skipping upsert, sending denial WP`,
                  );
                  await sendDenialWhatsappAsync({
                    supabase,
                    callId,
                    clinicId: call.clinic_id,
                    patientId: ctx.patient.id,
                  });
                }
              }

              await supabase.from("call_events").insert({
                call_id: callId,
                clinic_id: call.clinic_id,
                event_type: "agent_turn",
                payload: {
                  utterance,
                  agent_reply: pbOut.agent_reply,
                  intent: pbOut.intent,
                  end_call: pbOut.end_call,
                  isFirstTurn,
                  playbook: playbookKey,
                },
              });
              await playbook.postProcess({
                out: pbOut,
                ctx: pbCtx,
                supabase,
                isEndOfCall: pbOut.end_call,
              });

              // CRITICAL: await before returning — Cloudflare Workers kill
              // unresolved promises the moment Response is returned. Using
              // void here silently drops ALL appointment writes and WhatsApp
              // notifications for inbound_reception end-of-call turns.
              if (pbOut.end_call && playbookKey === "inbound_reception") {
                const finalTranscript = (update.transcript as Array<{ role: "agent" | "patient"; text: string }>) ?? [];
                // classified_call_type is only on Turn 1; for end-of-call turns read
                // the locked value from currentIntent (already in ctx.config from DB).
                const pbAnyCI2 = pbOut as unknown as { classified_call_type?: string | null };
                const callerIntent: string | null =
                  pbAnyCI2.classified_call_type ||
                  (pbCtx.config as { currentIntent?: string }).currentIntent ||
                  null;
                const kbRendered = (playbookConfig as { knowledge?: string }).knowledge ?? inboundKb?.rendered ?? null;
                await runInboundPostCallExtraction({
                  supabase,
                  callId,
                  clinicId: call.clinic_id,
                  patientId: ctx.patient.id,
                  transcript: finalTranscript.map((t) => ({ role: t.role === "patient" ? "caller" as const : "agent" as const, text: t.text })),
                  callerIntent,
                  clinicKB: kbRendered,
                }).catch((e) =>
                  console.error(`[agent.turn] runInboundPostCallExtraction failed (non-fatal): ${e instanceof Error ? e.message : e}`)
                );
              }
            } catch (dbErr) {
              console.error(
                `[agent.turn] playbook persist failed (non-fatal): ${dbErr instanceof Error ? dbErr.message : dbErr}`,
              );
            }

            return Response.json({
              intent: pbOut.intent,
              condition: null,
              suggested_doctor_id: null,
              appointment_iso: null,
              callback_requested: pbOut.callback_requested,
              callback_time: coerceCallbackTime(pbOut.callback_time),
              agent_reply: pbOut.agent_reply,
              end_call: pbOut.end_call,
            });
          }

          // Fast-path: positive consent reply right after the templated greeting.
          // The greeting endpoint never persists transcript turns, so this is the
          // first patient utterance and `transcript` is empty (or contains only
          // an agent line). Skip the LLM and force the canonical follow-up so
          // (a) the question is asked verbatim every time, and (b) the bridge
          // can play a pre-cached TTS clip with zero round-trip latency.
          const isConsentTurn =
            !isFirstTurn && (transcript.length === 0 || (transcript.length === 1 && transcript[0]?.role === "agent"));

          // Detect "previous agent line was the callback-time ask" — if so,
          // this turn is the patient telling us when to call back.
          const lastAgentLine = [...transcript].reverse().find((m) => m.role === "agent")?.text ?? "";
          const isCallbackTimeReplyTurn = !isFirstTurn && lastAgentLine.trim() === CALLBACK_ASK_TIME.trim();

          let result: AgentResult;
          if (isConsentTurn && isPositiveConsentReply(utterance)) {
            console.log(`[agent.turn] consent-positive fast-path → canonical follow-up`);
            result = {
              intent: "interested",
              condition: null,
              suggested_doctor_id: null,
              appointment_iso: null,
              callback_requested: false,
              callback_time: null,
              agent_reply: FOLLOWUP_BP_GLUCOSE,
              end_call: false,
            };
          } else if (isConsentTurn && isNegativeConsentReply(utterance)) {
            console.log(`[agent.turn] consent-negative fast-path → ask callback time`);
            // Try to opportunistically catch a time mentioned in the same
            // utterance ("baad mein, kal shaam"). If found, jump straight to
            // confirmation; otherwise ask the canonical question.
            const t = parseCallbackTime(utterance);
            if (t) {
              result = {
                intent: "busy",
                condition: null,
                suggested_doctor_id: null,
                appointment_iso: null,
                callback_requested: true,
                callback_time: t.iso,
                agent_reply: `ठीक है, मैं आपको ${t.human} पर कॉल करूँगी। धन्यवाद, नमस्ते।`,
                end_call: true,
              };
            } else {
              result = {
                intent: "busy",
                condition: null,
                suggested_doctor_id: null,
                appointment_iso: null,
                callback_requested: true,
                callback_time: null,
                agent_reply: CALLBACK_ASK_TIME,
                end_call: false,
              };
            }
          } else if (isCallbackTimeReplyTurn) {
            console.log(`[agent.turn] callback-time reply turn → parse time`);
            const t = parseCallbackTime(utterance);
            if (t) {
              result = {
                intent: "busy",
                condition: null,
                suggested_doctor_id: null,
                appointment_iso: null,
                callback_requested: true,
                callback_time: t.iso,
                agent_reply: `ठीक है, मैं आपको ${t.human} पर कॉल करूँगी। धन्यवाद, नमस्ते।`,
                end_call: true,
              };
            } else {
              // Couldn't parse — accept as freetext callback note and close
              // politely instead of looping.
              result = {
                intent: "busy",
                condition: null,
                suggested_doctor_id: null,
                appointment_iso: null,
                callback_requested: true,
                callback_time: null,
                agent_reply: "ठीक है, मैं आपको बाद में कॉल करूँगी। धन्यवाद, नमस्ते।",
                end_call: true,
              };
            }
          } else if (injectedReply) {
            // Streaming endpoint already generated the reply; just persist.
            result = {
              intent: injectedReply.intent,
              condition: injectedReply.condition ?? null,
              suggested_doctor_id: injectedReply.suggested_doctor_id ?? null,
              appointment_iso: injectedReply.appointment_iso ?? null,
              callback_requested: injectedReply.callback_requested ?? false,
              callback_time: injectedReply.callback_time ?? null,
              agent_reply: injectedReply.agent_reply,
              end_call: injectedReply.end_call ?? false,
            };
            console.log(`[agent.turn] using injectedReply (skip LLM) intent=${result.intent}`);
          } else {
            try {
              result = await runAgent({
                utterance,
                isFirstTurn,
                phase: "in_conversation",
                patient,
                clinicName: clinic.name,
                direction: (call as { direction?: string }).direction === "inbound" ? "inbound" : "outbound",
                doctors: ctx.doctors,
                clinicProfile: ctx.clinicProfile,
                services: ctx.services,
                faqs: ctx.faqs,
                policies: ctx.policies,
                history: transcript.slice(-12),
                prior: {
                  condition: call.condition_mentioned,
                  suggested_doctor_id: call.suggested_doctor_id,
                  appointment_iso: call.appointment_time,
                  callback_requested: call.callback_requested ?? false,
                  callback_time: call.callback_time,
                },
              });
              console.log(`[agent.turn] AI ok reply="${result.agent_reply.slice(0, 80)}" intent=${result.intent}`);
            } catch (aiErr) {
              console.error(
                `[agent.turn] AI failed, using fallback: ${aiErr instanceof Error ? aiErr.message : aiErr}`,
              );
              result = isFirstTurn ? fallbackGreeting(patient.name, clinic.name) : fallbackReprompt();
            }
          }

          // Persist (best-effort: never let DB errors swallow the reply)
          try {
            const newTranscript = [
              ...transcript,
              ...(isFirstTurn ? [] : [{ role: "patient" as const, text: utterance }]),
              { role: "agent" as const, text: result.agent_reply },
            ];
            const update: TablesUpdate<"calls"> = {
              transcript: newTranscript,
              intent: result.intent,
              status: "in_progress",
            };
            if (result.condition) update.condition_mentioned = result.condition;
            // Also capture symptoms_mentioned from runAgent (now included in Out schema)
            const resultAny = result as unknown as { symptoms_mentioned?: string[] };
            if (Array.isArray(resultAny.symptoms_mentioned) && resultAny.symptoms_mentioned.length > 0) {
              update.condition_mentioned = resultAny.symptoms_mentioned.join(", ");
            } else if (result.condition) {
              update.condition_mentioned = result.condition;
            }
            // runAgent() already resolves suggested_doctor_key → UUID before
            // returning, so result.suggested_doctor_id is always a real DB UUID
            // (or null). No key-resolution needed here.
            let screeningApptReady = false;
            if (result.suggested_doctor_id && result.appointment_iso) {
              const apptDate = new Date(result.appointment_iso);
              if (!isNaN(apptDate.getTime())) {
                update.suggested_doctor_id = result.suggested_doctor_id;
                update.appointment_time = result.appointment_iso;
                screeningApptReady = true;
              } else {
                console.warn(
                  `[agent.turn] screening_to_opd: invalid appointment_iso="${result.appointment_iso}" callId=${callId}`,
                );
              }
            } else {
              // Write whichever partial field is available so the calls row
              // stays in sync even before a full booking is confirmed.
              if (result.suggested_doctor_id) update.suggested_doctor_id = result.suggested_doctor_id;
              if (result.appointment_iso) update.appointment_time = result.appointment_iso;
            }
            if (result.callback_requested) {
              update.callback_requested = true;
              {
                const cb = coerceCallbackTime(result.callback_time);
                if (cb) update.callback_time = cb;
                else if (result.callback_time) {
                  console.warn(
                    `[agent.turn] dropped non-ISO callback_time="${result.callback_time}" path=screening_to_opd`,
                  );
                }
              }
            }
            await safeUpdateCall(supabase, callId, call.clinic_id, update, "screening_turn");

            // Upsert appointments row in the SAME block — same pattern as
            // inbound_reception. Fires whenever both doctor UUID and
            // appointment ISO are present, regardless of end_call state.
            if (screeningApptReady) {
              const slotCheck = isValidFutureSlot(result.appointment_iso!);
              if (slotCheck.ok) {
                await upsertAppointment(supabase, {
                  callId,
                  clinicId: call.clinic_id,
                  patientId: ctx.patient.id,
                  doctorId: result.suggested_doctor_id!,
                  appointmentIso: result.appointment_iso!,
                  notes: result.condition ?? null,
                });
                await sendAppointmentWhatsappAsync({
                  supabase,
                  callId,
                  clinicId: call.clinic_id,
                  patientId: ctx.patient.id,
                  doctorId: result.suggested_doctor_id!,
                  appointmentIso: result.appointment_iso!,
                });
              } else {
                console.warn(
                  `[agent.turn] appointment_iso rejected (${slotCheck.reason}): "${result.appointment_iso}" callId=${callId} — skipping upsert, sending denial WP`,
                );
                await sendDenialWhatsappAsync({
                  supabase,
                  callId,
                  clinicId: call.clinic_id,
                  patientId: ctx.patient.id,
                });
              }
            }

            await supabase.from("call_events").insert({
              call_id: callId,
              clinic_id: call.clinic_id,
              event_type: "agent_turn",
              payload: {
                utterance,
                agent_reply: result.agent_reply,
                intent: result.intent,
                end_call: result.end_call,
                isFirstTurn,
                suggested_doctor_id: result.suggested_doctor_id ?? undefined,
                appointment_iso: result.appointment_iso ?? undefined,
                ...(screeningApptReady ? { appointment_booked: true } : {}),
              },
            });
            console.log(`[agent.turn] db update ok callId=${callId}${screeningApptReady ? " (appointment upserted)" : ""}`);
            if (result.end_call) {
              // Mirror screening_to_opd terminal state into call_outcomes.
              await mirrorOutcomeFromCall(supabase, callId);
            }
          } catch (dbErr) {
            console.error(
              `[agent.turn] db persist failed (non-fatal): ${dbErr instanceof Error ? dbErr.message : dbErr}`,
            );
          }

          return Response.json(result);
        } catch (e) {
          return jsonError(e instanceof Error ? e.message : String(e), "uncaught");
        }
      },
    },
  },
});

// ---- Agent invocation ----

export async function runAgent(args: {
  utterance: string;
  isFirstTurn: boolean;
  phase: Phase;
  patient: {
    name: string;
    bp: string | null;
    blood_sugar: string | null;
    health_camp: string | null;
    age: number | null;
    gender: string | null;
    risk: string | null;
  };
  clinicName: string;
  direction: "outbound" | "inbound";
  doctors: Array<{
    id: string;
    name: string;
    specialization: string | null;
    super_specialization: string | null;
    qualifications: string | null;
    experience_years: number | null;
    conditions: string[];
    languages: string[];
    availability: string | null;
    consultation_fee: number | null;
    patients_treated: number | null;
    online_consultation: boolean | null;
  }>;
  clinicProfile: {
    about: string | null;
    address: string | null;
    timings: string | null;
    emergency_phone: string | null;
    departments: string[] | null;
    accreditations: string[] | null;
    extra_notes: string | null;
  } | null;
  services: Array<{
    name: string;
    category: string | null;
    description: string | null;
    price_min: number | null;
    price_max: number | null;
    currency: string | null;
    duration_minutes: number | null;
    prep_notes: string | null;
  }>;
  faqs: Array<{ question: string; answer: string; tags: string[] | null }>;
  policies: Array<{ title: string; rule: string; priority: number | null }>;
  history: Array<{ role: "agent" | "patient"; text: string }>;
  prior: {
    condition: string | null;
    suggested_doctor_id: string | null;
    appointment_iso: string | null;
    callback_requested: boolean;
    callback_time: string | null;
  };
  // Optional: when provided, the LLM call uses SSE streaming and this
  // callback fires for each new piece of `agent_reply` text decoded from
  // the partial JSON. Caller is responsible for sentence-buffering and TTS.
  // The function still returns the fully parsed AgentResult once the stream
  // completes — only the agent_reply emission is incremental.
  onReplyChunk?: (delta: string, sentenceClosed: boolean) => void;
}): Promise<AgentResult> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");

  // SECURITY: never expose real doctor database UUIDs to the LLM. Use opaque
  // short keys (doctor_1, doctor_2, ...) and translate back server-side.
  const keyToId = new Map<string, string>();
  const idToKey = new Map<string, string>();
  args.doctors.forEach((d, i) => {
    const k = `doctor_${i + 1}`;
    keyToId.set(k, d.id);
    idToKey.set(d.id, k);
  });

  const doctorsList = args.doctors
    .map((d) => {
      const parts: string[] = [];
      const spec = [d.specialization, d.super_specialization].filter(Boolean).join(" / ");
      parts.push(`- ${d.name} (key: ${idToKey.get(d.id)})${spec ? ` — ${spec}` : ""}`);
      if (d.qualifications) parts.push(`  qualifications: ${d.qualifications}`);
      if (d.experience_years) parts.push(`  ${d.experience_years} yrs experience`);
      if (d.conditions?.length) parts.push(`  treats: ${d.conditions.join(", ")}`);
      if (d.languages?.length) parts.push(`  languages: ${d.languages.join(", ")}`);
      if (d.availability) parts.push(`  availability: ${d.availability}`);
      if (d.consultation_fee != null) parts.push(`  consultation fee: ₹${d.consultation_fee}`);
      if (d.patients_treated != null) parts.push(`  patients treated: ${d.patients_treated}+`);
      if (d.online_consultation) parts.push(`  online consultation: available`);
      return parts.join("\n");
    })
    .join("\n");

  const transcript = args.history.map((t) => `${t.role === "agent" ? "Agent" : "Patient"}: ${t.text}`).join("\n");

  const nowUtc = new Date();
  const ist = new Date(nowUtc.getTime() + 5.5 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const istWall = `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}T${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}+05:30`;

  // ---------- Knowledge Base sections ----------
  const profile = args.clinicProfile;
  const profileBlock =
    profile &&
    (profile.about ||
      profile.address ||
      profile.timings ||
      profile.emergency_phone ||
      (profile.departments?.length ?? 0) ||
      (profile.accreditations?.length ?? 0) ||
      profile.extra_notes)
      ? `\nCLINIC PROFILE:
${profile.about ? `About: ${profile.about}\n` : ""}${profile.address ? `Address: ${profile.address}\n` : ""}${profile.timings ? `Timings: ${profile.timings}\n` : ""}${profile.emergency_phone ? `Emergency: ${profile.emergency_phone}\n` : ""}${profile.departments?.length ? `Departments: ${profile.departments.join(", ")}\n` : ""}${profile.accreditations?.length ? `Accreditations: ${profile.accreditations.join(", ")}\n` : ""}${profile.extra_notes ? `Notes: ${profile.extra_notes}\n` : ""}`
      : "";

  const fmtPrice = (s: (typeof args.services)[number]) => {
    const cur = s.currency || "INR";
    const sym = cur === "INR" ? "₹" : `${cur} `;
    if (s.price_min == null && s.price_max == null) return "price on request";
    if (s.price_max == null || s.price_min === s.price_max) return `${sym}${s.price_min}`;
    return `${sym}${s.price_min}–${sym}${s.price_max}`;
  };
  const servicesBlock = args.services.length
    ? `\nSERVICES & PRICING (quote ONLY these prices; for anything else say "front desk se confirm karwa dungi"):\n${args.services
        .map((s) => {
          const desc = s.description ? ` — ${s.description.slice(0, 120)}` : "";
          const dur = s.duration_minutes ? `, ~${s.duration_minutes} min` : "";
          const prep = s.prep_notes ? ` (prep: ${s.prep_notes.slice(0, 80)})` : "";
          return `- ${s.name}${s.category ? ` [${s.category}]` : ""} — ${fmtPrice(s)}${dur}${desc}${prep}`;
        })
        .join("\n")}\n`
    : "";

  const faqsBlock = args.faqs.length
    ? `\nFAQs (use these answers when the patient asks related questions, translate to Hindi):\n${args.faqs
        .map((f) => `Q: ${f.question}\nA: ${f.answer}`)
        .join("\n\n")}\n`
    : "";

  const policiesBlock = args.policies.length
    ? `\nADDITIONAL CLINIC RULES (must follow strictly, in priority order):\n${args.policies
        .map((p, i) => `${i + 1}. ${p.title}: ${p.rule}`)
        .join("\n")}\n`
    : "";

  const identityBlock = buildIdentityBlock({
    direction: args.direction,
    agentGender: resolveAgentGender(),
    patientGender: normalisePatientGender(args.patient.gender),
    patientName: args.patient.name,
    clinicName: args.clinicName,
  });

  const system = `${identityBlock}

You are a polite, empathetic Hindi-speaking health assistant calling on behalf of ${args.clinicName}.
CONTEXT: Current datetime is ${istWall} (Asia/Kolkata, IST). Resolve relative times to ISO 8601 with +05:30.
PATIENT: ${args.patient.name}. Age: ${args.patient.age ?? "n/a"}. Risk: ${args.patient.risk ?? "n/a"}. Camp: ${args.patient.health_camp ?? "general"}. BP: ${args.patient.bp ?? "n/a"}. Blood sugar: ${args.patient.blood_sugar ?? "n/a"}.
(Patient gender + your own gender are governed by the AGENT IDENTITY block above — follow those Hindi grammar rules strictly.)

GOAL: Check symptoms and offer an OPD appointment with a matching doctor from this clinic's roster ONLY:
${doctorsList || "(no doctors)"}
${profileBlock}${servicesBlock}${faqsBlock}${policiesBlock}
RULES:
- Reply ONLY in Hindi (Devanagari).
- INTERACTIVE & NARRATIVE TONE: Sound like a warm Hindi-speaking health worker guiding a real conversation, NOT a checklist. Reply in 1 short sentence (≤ 25 Hindi words) by default; 2 short sentences (each ≤ 15 words, each ending in "।"/"?"/"!") ONLY when truly needed. Always ACKNOWLEDGE what the patient just said in a half-sentence (e.g. "अच्छा, समझ गई — सिरदर्द है आपको…") before asking the next question. Bridge naturally between turns. Avoid abrupt topic jumps and one-word answers. EXCEPTIONS where you SHOULD be very short (one short sentence): final appointment confirmation, busy/callback close, and the consent reply right after the opening.
- Sound human: it is OK to start with a soft acknowledgement like "अच्छा,", "जी हाँ,", "समझी," when natural. Do NOT use formal lead-ins like "आपकी जानकारी के लिए".
- Do NOT open subsequent turns with a fresh greeting (no "नमस्ते", no "मैं ${args.clinicName} से बोल रही हूँ", no "कॉल कर रही हूँ", no "सेहत की जानकारी लेने के लिए") — the templated prelude already introduced you and the clinic. EXCEPTION: if the patient explicitly asks who you are or where you're calling from ("aap kaun hain?", "कहाँ से call कर रही हैं?", "कौन बोल रहा है?"), answer briefly and naturally — you MAY say the clinic name in that case, then continue the medical follow-up.
- Do NOT proactively re-state the patient's BP, blood sugar, or camp details — they were covered in the opening. HOWEVER, if the patient ASKS about their own readings ("मेरा BP कितना था?", "sugar kitna tha?", "कौन से camp में जाँच हुई थी?", "मेरी जाँच में क्या निकला?"), answer DIRECTLY using the exact values from the PATIENT block above (BP: ${args.patient.bp ?? "n/a"}, Blood sugar: ${args.patient.blood_sugar ?? "n/a"}, Camp: ${args.patient.health_camp ?? "n/a"}). After answering, continue the medical follow-up naturally. Do NOT deflect, do NOT switch to callback mode, do NOT end the call.
- NEVER suggest a doctor not in the list. NEVER diagnose.
- When you name a doctor, set suggested_doctor_key to that doctor's key (e.g. "doctor_1") in the same turn.
- NEVER include any database id, UUID, key, "doctor_N", "key:", "id:", or anything in parentheses like "(id:...)" in agent_reply. The agent_reply is what the patient hears — it must contain ONLY the doctor's spoken name and natural Hindi sentences. Identifiers belong only in the suggested_doctor_key field.
- When you confirm an appointment, set appointment_iso AND end_call=true in the same turn.
- DOCTOR NAME SCRIPT: Write doctor names in Latin script (e.g. "Doctor Rani Kumari"), use English "Doctor" not "डॉक्टर".
- If patient asks about prices/fees/charges/cost, use ONLY the SERVICES & PRICING list above. If a service isn't listed, say "front desk se confirm karwa dungi" — never invent a price.
- If patient asks a general clinic question (insurance, timings, address, ambulance, reports, etc.), use the FAQs and CLINIC PROFILE above.
- Treat every entry under ADDITIONAL CLINIC RULES as non-negotiable.
- If your previous agent line in the history was "${FOLLOWUP_BP_GLUCOSE}", do NOT repeat or rephrase it. Acknowledge the patient's answer (vitals, symptoms, "ठीक हूँ", etc.) and continue the consultation: probe symptoms, suggest a doctor, or schedule.
- If patient busy: callback_requested=true, intent="busy", close politely, end_call=true.

APPOINTMENT BOOKING — MANDATORY FIELDS (CRITICAL):
When the patient confirms an appointment (agreed to a date, time, and doctor), ALL of the following JSON fields MUST be non-null in the SAME turn:
  - suggested_doctor_key: the key of the chosen doctor (e.g. "doctor_1") — NEVER null on a confirmed booking.
  - appointment_iso: exact ISO-8601 timestamp with +05:30 offset, computed from the CONTEXT datetime above (e.g. "${istWall.slice(0, 11)}10:00:00+05:30"). Resolve patient's relative time ("kal", "parso", a day name, a clock time) into a full timestamp using the current datetime as anchor. NEVER null on a confirmed booking. NEVER use a past year.
  - intent: must be "interested".
  - end_call: must be true.
If ANY of these fields is missing or null when the patient has agreed, the appointment will be silently lost. Double-check all four before emitting JSON.

SYMPTOM CAPTURE (CRITICAL — clinical safety):
- Always populate symptoms_mentioned with normalised English labels when the patient mentions any symptom.
- Use ONLY labels from: ["chest pain","dizziness","breathlessness","weakness","blurred vision","headache","swelling","excessive thirst","frequent urination","fatigue","vomiting","numbness","insomnia"].
- Set red_flag=true if patient mentions chest pain, breathlessness, sudden weakness, blurred/lost vision, or one-sided numbness.

CRITICAL INSTRUCTIONS FOR VOICE OUTPUT:
- You are speaking over a voice phone call, so you MUST ONLY output conversational text that is meant to be spoken aloud.
- DO NOT output any code, programming syntax, or JavaScript (e.g., no HTML, no jQuery).
- DO NOT output any Markdown, asterisks, bullet points, or special formatting characters.
- Keep your responses natural, conversational, and completely free of any technical artifacts.

Respond ONLY with strict JSON:
{
  "intent": "interested"|"not_interested"|"busy"|"symptom"|"unclear",
  "condition": string|null,
  "suggested_doctor_key": string|null,
  "appointment_iso": string|null,
  "symptoms_mentioned": [string],
  "red_flag": boolean,
  "callback_requested": boolean,
  "callback_time": string|null,
  "agent_reply": string,
  "end_call": boolean
}`;

  const priorDoctorKey = args.prior.suggested_doctor_id
    ? (idToKey.get(args.prior.suggested_doctor_id) ?? "null")
    : "null";
  const priorBlock = `PREVIOUSLY EXTRACTED:
- condition: ${args.prior.condition ?? "null"}
- suggested_doctor_key: ${priorDoctorKey}
- appointment_iso: ${args.prior.appointment_iso ?? "null"}
- callback_requested: ${args.prior.callback_requested}
- callback_time: ${args.prior.callback_time ?? "null"}

`;

  // ---------- Consent-turn detection ----------
  // The templated greeting (delivered before any LLM turn) ends with
  // "क्या अभी आपसे बात हो सकती है?". When the patient replies to that, our
  // transcript has exactly ONE entry — the agent greeting — and the model
  // tends to re-introduce itself. Detect this turn and force the right branch.
  // Defensive: also match history.length===0 in case the greeting persist
  // hadn't committed yet when the bridge fired this turn (race window).
  const isConsentTurn =
    !args.isFirstTurn &&
    ((args.history.length === 1 && args.history[0]?.role === "agent") || args.history.length === 0);

  const utteranceLower = (args.utterance || "").toLowerCase();
  const positiveRe = /(हाँ|हां|जी|बिल्कुल|बोलिए|बताइए|ठीक|ok|okay|yes|बात कर|सुन रही|बोल|कहिए|हूँ|hoon|haan)/i;
  const negativeBusyRe =
    /(नहीं|busy|व्यस्त|अभी नहीं|बाद में|later|मसरूफ|काम में|समय नहीं|baad mein|kal|phir|abhi nahi|nahi)/i;
  let consentSentiment: "positive" | "negative_busy" | "unclear" = "unclear";
  if (isConsentTurn) {
    if (negativeBusyRe.test(args.utterance) || negativeBusyRe.test(utteranceLower)) {
      consentSentiment = "negative_busy";
    } else if (positiveRe.test(args.utterance) || positiveRe.test(utteranceLower)) {
      consentSentiment = "positive";
    }
  }

  const consentDirective = isConsentTurn
    ? `

CRITICAL CONSENT TURN — the patient just answered your opening "क्या अभी बात हो सकती है?". Detected sentiment: ${consentSentiment}.
- DO NOT re-introduce yourself. DO NOT repeat the clinic name. DO NOT say "नमस्ते" again.
- DO NOT restate BP/sugar/camp details — the templated opening already covered them.
- If sentiment is POSITIVE: your reply MUST be exactly the medical follow-up "क्या उसके बाद आपने BP और Glucose की जाँच दोबारा करवाई है? अब आप कैसे हैं?" — set intent="interested", end_call=false.
- If sentiment is NEGATIVE_BUSY: respond with ONE short polite line that ASKS for a good callback time. Use exactly: "कोई बात नहीं। क्या मैं आपको बाद में कॉल कर सकती हूँ — कब का समय आपके लिए ठीक रहेगा?". Set callback_requested=true, intent="busy", end_call=false. If patient ALREADY gave a relative time in the same utterance (kal/shaam/5 बजे etc.), put it in callback_time and respond with "ठीक है, मैं आपको <time> पर कॉल करूँगी। धन्यवाद, नमस्ते।" with end_call=true.
- If sentiment is UNCLEAR: ask ONCE in one short sentence whether now is a good time. Do NOT re-introduce.`
    : "";

  const systemFinal = system + consentDirective;

  const userMsg = args.isFirstTurn
    ? `This is the OPENING of the call — the patient has just picked up and has not said anything yet.
${priorBlock}
Produce a short, warm Hindi greeting that:
- introduces yourself on behalf of ${args.clinicName}
- greets ${args.patient.name} by name
- asks an open question about how they are feeling or any symptoms
Set intent="unclear", end_call=false. Return JSON only.`
    : `Conversation so far:
${transcript}

${priorBlock}Patient just said: "${args.utterance}"
${isConsentTurn ? `\nNOTE: This is the patient's CONSENT REPLY to your opening question. Detected sentiment: ${consentSentiment}. Follow the CRITICAL CONSENT TURN rules above EXACTLY.\n` : ""}
Produce the next agent turn as JSON.`;

  const useStream = typeof args.onReplyChunk === "function";
  const requestBody: Record<string, unknown> = {
    // Phase-1 latency: switch turn model to flash-lite (fastest TTFB, fine
    // for short JSON responses). Keep gemini-2.5-flash for the opening
    // greeting where reply quality matters more and TTFB is masked by the
    // pre-cached prelude. Override via AGENT_TURN_MODEL / AGENT_GREETING_MODEL.
    model: args.isFirstTurn
      ? (process.env.AGENT_GREETING_MODEL ?? "google/gemini-2.5-flash")
      : (process.env.AGENT_TURN_MODEL ?? "google/gemini-2.5-flash-lite"),
    messages: [
      { role: "system", content: systemFinal },
      { role: "user", content: userMsg },
    ],
    response_format: { type: "json_object" },
    // 800 tokens: a booking confirmation turn must output 10+ JSON fields
    // simultaneously — suggested_doctor_key, appointment_iso (full ISO-8601
    // timestamp), symptoms_mentioned array, agent_reply (Hindi sentence), and
    // end_call=true all in one object. 200 tokens caused guaranteed truncation
    // on confirmation turns → JSON.parse threw → Zod fell back to null for
    // appointment_iso and suggested_doctor_key → upsertAppointment never fired.
    // 800 is sufficient for the largest expected output (~400 tokens) with
    // headroom for longer Hindi replies, and avoids the 2000-token cost on
    // every normal conversational turn.
    max_tokens: 800,
  };
  if (useStream) requestBody.stream = true;

  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`AI gateway error ${res.status}: ${errText.slice(0, 300)}`);
  }

  let content: string;
  if (useStream && res.body) {
    // Incrementally parse the streaming JSON, extracting `agent_reply` text
    // and emitting deltas at sentence boundaries (। . ? !).
    const { AgentReplyExtractor, parseSseLine } = await import("@/lib/agent-stream.server");
    const extractor = new AgentReplyExtractor();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let textBuffer = "";
    let fullContent = "";
    let pendingDelta = "";
    const SENT_BOUNDARY_CH = /[।.?!]/;

    const flushPending = (sentenceClosed: boolean) => {
      if (!pendingDelta) return;
      args.onReplyChunk!(pendingDelta, sentenceClosed);
      pendingDelta = "";
    };

    const handleDelta = (deltaText: string) => {
      if (!deltaText) return;
      fullContent += deltaText;
      const { newText, closed } = extractor.push(deltaText);
      if (newText) {
        pendingDelta += newText;
        // Check whether the accumulated pending contains a sentence boundary;
        // emit at the first one and keep the remainder.
        let m: RegExpExecArray | null;
        const re = /[।.?!]\s|[।.?!]$/;
        while ((m = re.exec(pendingDelta)) !== null) {
          const end = (m.index ?? 0) + 1;
          const sentence = pendingDelta.slice(0, end);
          args.onReplyChunk!(sentence, true);
          pendingDelta = pendingDelta.slice(end).replace(/^\s+/, "");
        }
        if (closed) flushPending(true);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      textBuffer += decoder.decode(value, { stream: true });
      let nlIdx: number;
      while ((nlIdx = textBuffer.indexOf("\n")) !== -1) {
        let line = textBuffer.slice(0, nlIdx);
        textBuffer = textBuffer.slice(nlIdx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        const delta = parseSseLine(line);
        if (delta != null) handleDelta(delta);
      }
    }
    if (textBuffer.trim()) {
      const delta = parseSseLine(textBuffer);
      if (delta != null) handleDelta(delta);
    }
    flushPending(true);
    void SENT_BOUNDARY_CH;
    content = fullContent || "{}";
  } else {
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    content = json.choices?.[0]?.message?.content ?? "{}";
  }

  const Out = z.object({
    intent: z.enum(["interested", "not_interested", "busy", "symptom", "unclear"]).catch("unclear"),
    condition: z.string().nullable().catch(null),
    suggested_doctor_key: z.string().nullable().optional().catch(null),
    suggested_doctor_id: z.string().nullable().optional().catch(null),
    appointment_iso: z.string().nullable().catch(null),
    symptoms_mentioned: z.array(z.string()).catch([]),
    red_flag: z.boolean().catch(false),
    callback_requested: z.boolean().catch(false),
    callback_time: z.string().nullable().catch(null),
    agent_reply: z.string().catch("Theek hai."),
    end_call: z.boolean().catch(false),
  });

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    raw = {};
  }
  const parsedOut = Out.parse(raw);

  // Resolve doctor reference: prefer key (new), fall back to legacy id, then
  // try to extract from reply text. Always end with a real DB UUID or null.
  let resolvedDoctorId: string | null = null;
  if (parsedOut.suggested_doctor_key && keyToId.has(parsedOut.suggested_doctor_key)) {
    resolvedDoctorId = keyToId.get(parsedOut.suggested_doctor_key)!;
  } else if (parsedOut.suggested_doctor_id) {
    const validIds = new Set(args.doctors.map((d) => d.id));
    if (validIds.has(parsedOut.suggested_doctor_id)) resolvedDoctorId = parsedOut.suggested_doctor_id;
  }

  // Sanitize the spoken reply: strip any UUID, "id:...", "key:...", "(doctor_N)"
  // patterns so the patient never hears a database identifier read out.
  const sanitizeReply = (s: string): string => {
    let r = s ?? "";
    // Remove parenthetical id/key blobs: (id:...), (key: doctor_2), (doctor_3)
    r = r.replace(/\s*\(\s*(?:id\s*[:=]|key\s*[:=]|doctor_\d+)[^)]*\)/gi, "");
    // Remove standalone "id: <uuid>" / "key: doctor_N" fragments
    r = r.replace(/\b(?:id|key)\s*[:=]\s*[A-Za-z0-9_-]+/gi, "");
    // Remove standalone doctor_N tokens
    r = r.replace(/\bdoctor_\d+\b/gi, "");
    // Remove bare UUIDs
    r = r.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "");
    // Tidy whitespace and stray empty parens
    r = r
      .replace(/\(\s*\)/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    return r;
  };
  const cleanedReply = sanitizeReply(parsedOut.agent_reply);
  if (cleanedReply !== parsedOut.agent_reply) {
    console.log(`[agent.turn] sanitized reply (stripped id/key/uuid)`);
  }

  const out: AgentResult = {
    intent: parsedOut.intent,
    condition: parsedOut.condition,
    suggested_doctor_id: resolvedDoctorId,
    appointment_iso: parsedOut.appointment_iso,
    callback_requested: parsedOut.callback_requested,
    callback_time: parsedOut.callback_time,
    agent_reply: cleanedReply || "Theek hai.",
    end_call: parsedOut.end_call,
  };

  // ---------- Consent-turn safety net ----------
  // If the model still re-introduced itself on the consent turn, overwrite
  // the reply with the canonical follow-up so the patient never hears two greetings.
  if (isConsentTurn) {
    // Only treat as a re-intro if the reply actually OPENS with a greeting word
    // ("नमस्ते"/"नमस्कार") or pairs a self-introduction verb with the clinic name.
    // A bare clinic-name mention (e.g. answering "aap kaun hain?") is fine.
    const greetingRe = /(नमस्ते|नमस्कार|namaste|namaskar)/i;
    const selfIntroRe =
      /(से\s*बोल\s*रही|से\s*बात\s*कर\s*रही|कॉल\s*कर\s*रही|सेहत\s*की\s*जानकारी|जानकारी\s*लेने|हेल्थ\s*असिस्टेंट|सेहत\s*सहाय|sehat sahay|seht sahay|health\s*assistant)/i;
    const looksLikeReIntro = greetingRe.test(out.agent_reply) || selfIntroRe.test(out.agent_reply);
    if (consentSentiment === "negative_busy") {
      // Always force the busy-callback ASK (not close). The bridge has a
      // pre-cached TTS clip for this exact line so it plays instantly.
      out.agent_reply = CALLBACK_ASK_TIME;
      out.intent = "busy";
      out.callback_requested = true;
      out.end_call = false;
      console.log("[agent.turn] consent-turn: forced negative_busy → callback-time ask");
    } else if (consentSentiment === "positive" && looksLikeReIntro) {
      out.agent_reply = FOLLOWUP_BP_GLUCOSE;
      out.intent = "interested";
      out.end_call = false;
      console.log("[agent.turn] consent-turn: rewrote re-intro to medical follow-up");
    } else if (consentSentiment === "unclear" && looksLikeReIntro) {
      out.agent_reply = "क्या अभी एक मिनट बात हो सकती है?";
      out.end_call = false;
      console.log("[agent.turn] consent-turn: rewrote re-intro to short clarifier");
    }
  }

  return out as AgentResult;
}
