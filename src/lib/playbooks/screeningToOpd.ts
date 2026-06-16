// Screening → OPD playbook. This is a verbatim move of the existing prompt
// and greeting so behavior is unchanged for live screening campaigns.
// All clinic KB (doctors, profile, services, faqs, policies) is loaded by
// the dispatcher and injected into the prompt via `ctx.config.knowledge`.

import { z } from "zod";
import type { Playbook, PlaybookContext, GreetingSegments, BaseAgentResult } from "./_base";
import { RELATIONAL_TONE_BLOCK, LATENCY_STYLE_BLOCK, buildIdentityBlock, resolveAgentGender, normalisePatientGender } from "./_tone";
import { NURSING_KNOWLEDGE_BLOCK } from "../agent-knowledge";
import { FOLLOWUP_BP_GLUCOSE } from "../agent-canonical";

export type ScreeningResult = BaseAgentResult & {
  condition: string | null;
  suggested_doctor_key: string | null;
  appointment_iso: string | null;
  symptoms_mentioned: string[];
  red_flag: boolean;
};

export const screeningOutputSchema: z.ZodType<ScreeningResult> = z.object({
  intent: z.enum(["interested", "not_interested", "busy", "symptom", "unclear"]).catch("unclear"),
  condition: z.string().nullable().catch(null),
  suggested_doctor_key: z.string().nullable().catch(null),
  appointment_iso: z.string().nullable().catch(null),
  symptoms_mentioned: z.array(z.string()).catch([]),
  red_flag: z.boolean().catch(false),
  callback_requested: z.boolean().catch(false),
  callback_time: z.preprocess(
    (v) => {
      if (typeof v !== "string" || !v.trim()) return null;
      const d = new Date(v);
      return isNaN(d.getTime()) ? null : d.toISOString();
    },
    z.string().nullable(),
  ).catch(null),
  agent_reply: z.string().catch("ठीक है।"),
  end_call: z.boolean().catch(false),
});

function buildGreeting(ctx: PlaybookContext): GreetingSegments {
  const p = ctx.patient;
  const namePrefix = p.name?.trim() ? `${p.name.trim()} जी, ` : "";
  const clinic = ctx.clinic.name?.trim() || "क्लिनिक";
  const camp = p.health_camp?.trim();
  const campLabel = camp ? `हमारे ${camp} स्वास्थ्य शिविर` : "हमारे स्वास्थ्य शिविर";

  const bp = p.bp?.trim();
  const sugar = p.blood_sugar?.trim();
  let measureClause: string;
  if (bp && sugar) {
    measureClause = `में अपना BP जो कि ${bp} और Blood Glucose जो कि ${sugar} की जाँच करवाई थी, जो थोड़ी अधिक थी।`;
  } else if (bp) {
    measureClause = `में अपना BP जो कि ${bp} की जाँच करवाई थी, जो थोड़ी अधिक थी।`;
  } else if (sugar) {
    measureClause = `में अपना Blood Glucose जो कि ${sugar} की जाँच करवाई थी, जो थोड़ी अधिक थी।`;
  } else {
    measureClause = `में जाँच करवाई थी।`;
  }

  return {
    s1: `${namePrefix}मैं ${clinic} से बोल रही हूँ।`,
    s2: `आपने ${campLabel} ${measureClause}`,
    s3: `क्या अभी आपसे थोड़ी बात हो सकती है?`,
  };
}

function buildSystemPrompt(ctx: PlaybookContext): string {
  // Knowledge slices are injected by the dispatcher in ctx.config.knowledge.
  const kb = (ctx.config as { knowledge?: string }).knowledge ?? "";
  const p = ctx.patient;
  const identity = buildIdentityBlock({
    direction: ctx.direction,
    agentGender: resolveAgentGender(),
    patientGender: normalisePatientGender(p.gender),
    patientName: p.name,
    clinicName: ctx.clinic.name,
  });

  // Compute current IST wall-clock time at the moment the prompt is built
  // (this function is called once per turn, so it is always fresh).
  // Without this anchor the LLM hallucinates appointment_iso years.
  const nowUtc = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(nowUtc.getTime() + istOffset);
  const pad = (n: number) => String(n).padStart(2, "0");
  const istWall = `${istNow.getUTCFullYear()}-${pad(istNow.getUTCMonth() + 1)}-${pad(istNow.getUTCDate())}T${pad(istNow.getUTCHours())}:${pad(istNow.getUTCMinutes())}:${pad(istNow.getUTCSeconds())}+05:30`;

  return `${RELATIONAL_TONE_BLOCK}

${LATENCY_STYLE_BLOCK}

${identity}

You are a polite, empathetic Hindi-speaking health assistant calling on behalf of ${ctx.clinic.name}.
CONTEXT: Current datetime is ${istWall} (Asia/Kolkata, IST). When the patient says relative times like "kal", "parso", "aaj", "shaam", or a day name, resolve them to an exact ISO-8601 timestamp with +05:30 offset using this datetime as the anchor.
PATIENT: ${p.name}. Age: ${p.age ?? "n/a"}. Risk: ${p.risk ?? "n/a"}. Camp: ${p.health_camp ?? "general"}. BP: ${p.bp ?? "n/a"}. Blood sugar: ${p.blood_sugar ?? "n/a"}.
(Patient gender + your own gender are governed by the AGENT IDENTITY block above.)

CLINICAL KNOWLEDGE (you have GNM / B.Sc Nursing + Care Coordinator training. Use ONLY for general triage education, never to diagnose / prescribe / replace a doctor; always route to OPD or — for red flags — to nearest hospital):
${NURSING_KNOWLEDGE_BLOCK}

GOAL: After acknowledging how the patient feels, gently check for BP/sugar related symptoms and offer an OPD appointment with a matching doctor from this clinic.
${kb}

RULES:
- Reply ONLY in Hindi (Devanagari).
- (Length: governed by the LATENCY & STYLE block above — do not duplicate the cap here.)
- Acknowledge what the patient just said in a half-sentence before the next question.
- NEVER suggest a doctor not in the roster above. NEVER diagnose.
- DOCTOR NAME SCRIPT: write doctor names in Latin script (e.g. "Doctor Rani Kumari"); use English "Doctor" not "डॉक्टर".
- Set suggested_doctor_key to the doctor's key (e.g. "doctor_1") whenever you name one.
- NEVER include UUIDs, "doctor_N", "key:", "id:" in agent_reply — those are for structured fields only.
- When you confirm an appointment, set appointment_iso AND end_call=true in the same turn.
- If patient is busy: callback_requested=true, intent="busy", end_call=true and close politely.
- If your previous agent line was "${FOLLOWUP_BP_GLUCOSE}", do NOT repeat it.

CLINIC Q&A (when the patient asks about doctors, address, timings, fees, or services):
- Answer ONLY from the CLINIC INFO block injected above (doctors / clinic profile / services / FAQs / policies). NEVER invent a doctor name, address, phone, fee, or service that is not present there.
- If the requested fact is missing from that block, say one short line: "एक minute, मैं front desk से confirm करवा कर callback दिला देती हूँ" — then set callback_requested=true and continue with the screening flow on the next turn (do NOT end the call just for an info question).
- Keep clinic-info answers to ONE short Hindi sentence and immediately steer back to the screening / OPD goal.

SYMPTOM CAPTURE (CRITICAL — clinical safety):
- Populate symptoms_mentioned with normalised English labels from this list ONLY:
  ["chest pain","dizziness","breathlessness","weakness","blurred vision","headache","swelling","excessive thirst","frequent urination","fatigue","vomiting","numbness","insomnia"].
- Set red_flag=true if patient mentions chest pain, breathlessness, sudden weakness, blurred / lost vision, or one-sided numbness; advise immediate clinic / hospital visit.

APPOINTMENT BOOKING — MANDATORY FIELDS (CRITICAL):
When you confirm an appointment (patient has agreed to a date, time, and doctor), ALL of the following JSON fields are REQUIRED and must be non-null in the same turn:
  - suggested_doctor_key: the key of the chosen doctor (e.g. "doctor_1") — NEVER null on a confirmed booking.
  - appointment_iso: exact ISO-8601 timestamp with +05:30 offset derived from the current datetime above (e.g. "${istWall.slice(0, 11)}10:00:00+05:30"). Resolve "kal", "parso", day names, or times the patient mentions into a full timestamp. NEVER null on a confirmed booking. NEVER use a past year.
  - intent: must be "interested".
  - end_call: must be true.
If ANY of the above fields is missing or null when the patient has agreed to an appointment, the booking will be LOST. Double-check before emitting JSON.

IMPORTANT: callback_time MUST be an ISO-8601 timestamp (e.g. "2026-05-04T14:30:00+05:30") or null. NEVER a Hindi or English word like "शनिवार" / "kal" / "Saturday".

Respond with strict JSON:
{ "intent": "...", "condition": null|string, "suggested_doctor_key": null|string, "appointment_iso": null|string, "symptoms_mentioned": [string], "red_flag": bool, "callback_requested": bool, "callback_time": null|string, "agent_reply": "...", "end_call": bool }`;
}

async function postProcess(args: {
  out: ScreeningResult;
  ctx: PlaybookContext;
  supabase: import("./_base").AdminClient;
  isEndOfCall: boolean;
}): Promise<void> {
  // Mirror to call_outcomes for dashboard parity. The legacy call.* columns
  // are still written by the dispatcher.
  const { ctx, out, supabase, isEndOfCall } = args;
  if (!isEndOfCall) return;

  // Resolve doctor name from suggested_doctor_key (e.g. "doctor_1") via clinic roster
  let doctorName: string | null = null;
  let doctorId: string | null = null;
  if (out.suggested_doctor_key) {
    const roster = (ctx.config as { doctors?: Array<{ key?: string; id?: string; name?: string }> })
      .doctors ?? [];
    const match = roster.find((d) => d.key === out.suggested_doctor_key);
    if (match) {
      doctorName = match.name ?? null;
      doctorId = match.id ?? null;
    }
  }

  // Force ISO with 'Z' so the dashboard never gets `+00`
  const apptIso = out.appointment_iso
    ? (() => {
        const d = new Date(out.appointment_iso!);
        return isNaN(d.getTime()) ? out.appointment_iso : d.toISOString();
      })()
    : null;

  await supabase
    .from("call_outcomes")
    .upsert(
      [{
        call_id: ctx.callId,
        clinic_id: ctx.clinic.id,
        playbook_key: "screening_to_opd",
        structured: {
          intent: out.intent,
          condition: out.condition,
          appointment_iso: apptIso,
          doctor_name: doctorName,
          doctor_id: doctorId,
          symptoms_mentioned: out.symptoms_mentioned ?? [],
          callback_requested: out.callback_requested,
          callback_time: out.callback_time,
        },
        success: out.intent === "interested" || !!out.appointment_iso,
        red_flag: !!out.red_flag,
      }],
      { onConflict: "call_id" },
    );
}

export const screeningToOpdPlaybook: Playbook<ScreeningResult> = {
  key: "screening_to_opd",
  buildGreeting,
  buildSystemPrompt,
  outputSchema: screeningOutputSchema,
  postProcess,
};
