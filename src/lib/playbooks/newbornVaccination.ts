// New-Born Vaccination Reminder playbook.
// Wellbeing-first greeting (s3 intentionally empty). Sentiment branch:
// positive → invite for the due vaccine; negative → empathy only, never
// pitch the vaccine in this turn.

import { z } from "zod";
import type { Playbook, PlaybookContext, GreetingSegments, BaseAgentResult, PlaybookDueDose } from "./_base";
import { RELATIONAL_TONE_BLOCK, LATENCY_STYLE_BLOCK, buildIdentityBlock, resolveAgentGender, normalisePatientGender } from "./_tone";
import { milestoneLabel, formatDueDateHindi, formatDobHindi } from "./vaccinationSchedule";

export type VaccinationResult = BaseAgentResult & {
  baby_sentiment: "positive" | "negative" | "unclear";
  baby_health_concern: string | null;
  intent_to_attend: "yes" | "no" | "reschedule" | "unclear" | "not_asked";
  confirmed_slot_iso: string | null;
  rescheduled_to: string | null;
  red_flag: boolean;
};

export const vaccinationOutputSchema: z.ZodType<VaccinationResult> = z.object({
  intent: z.enum(["interested", "not_interested", "busy", "symptom", "unclear"]).catch("unclear"),
  baby_sentiment: z.enum(["positive", "negative", "unclear"]).catch("unclear"),
  baby_health_concern: z.string().nullable().catch(null),
  intent_to_attend: z.enum(["yes", "no", "reschedule", "unclear", "not_asked"]).catch("not_asked"),
  confirmed_slot_iso: z.string().nullable().catch(null),
  rescheduled_to: z.string().nullable().catch(null),
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

function pickPrimaryDose(doses: PlaybookDueDose[] | undefined): PlaybookDueDose | null {
  if (!doses || doses.length === 0) return null;
  // Earliest due date wins. Stable tie-break by milestone key.
  return [...doses].sort((a, b) => a.due_date.localeCompare(b.due_date))[0];
}

function buildGreeting(ctx: PlaybookContext): GreetingSegments {
  const baby = ctx.baby;
  const clinic = ctx.clinic.name?.trim() || "क्लिनिक";
  const parentName = baby?.parent_name?.trim() || ctx.patient.name?.trim() || "जी";
  if (!baby) {
    // No baby on file — graceful fallback. Should be rare; sweep job seeds.
    return {
      s1: `${parentName} जी, मैं ${clinic} से बोल रही हूँ।`,
      s2: `आपके बच्चे का हाल जानने के लिए call किया है — अभी कैसे हैं वे?`,
      s3: ``,
    };
  }
  const dobH = formatDobHindi(baby.dob);
  return {
    s1: `${parentName} जी, मैं ${clinic} से बोल रही हूँ।`,
    s2: `आपके बच्चे ${baby.baby_name} जी का जन्म जो कि ${dobH} है — अभी वे कैसे हैं?`,
    s3: ``,
  };
}

function buildSystemPrompt(ctx: PlaybookContext): string {
  const baby = ctx.baby;
  const dose = pickPrimaryDose(ctx.dueDoses);
  const milestoneH = dose ? milestoneLabel(dose.age_milestone) : "";
  const dueH = dose ? formatDueDateHindi(dose.due_date) : "";
  const allDueLine = (ctx.dueDoses ?? [])
    .map((d) => `${d.vaccine_code} (${milestoneLabel(d.age_milestone)}, due ${formatDueDateHindi(d.due_date)})`)
    .join(", ");
  const kb = (ctx.config as { knowledge?: string }).knowledge ?? "";

  const parentName = baby?.parent_name ?? ctx.patient.name;
  const babyGender: "male" | "female" | "unknown" =
    baby?.gender === "male" || baby?.gender === "female" ? baby.gender : "unknown";
  const identity = buildIdentityBlock({
    direction: ctx.direction,
    agentGender: resolveAgentGender(),
    // For vaccination calls the addressee is the PARENT, not the baby.
    patientGender: normalisePatientGender(ctx.patient.gender),
    patientName: parentName,
    clinicName: ctx.clinic.name,
    babyGender,
    babyName: baby?.baby_name ?? null,
  });

  return `${RELATIONAL_TONE_BLOCK}

${LATENCY_STYLE_BLOCK}

${identity}

You are a polite, empathetic Hindi-speaking health assistant calling on behalf of ${ctx.clinic.name}.
PARENT: ${parentName}.
BABY: ${baby ? `${baby.baby_name}, born ${formatDobHindi(baby.dob)}${baby.gender ? `, ${baby.gender}` : ""}` : "(unknown)"}.
(Parent gender, baby gender, and your own gender are governed by the AGENT IDENTITY block above.)
DUE VACCINES: ${allDueLine || "(none on file)"}
PRIMARY DUE: ${dose ? `${dose.vaccine_code} — milestone "${milestoneH}", due ${dueH}` : "(none)"}

PURPOSE: Check on the baby's wellbeing FIRST. Only if the parent indicates the baby is well, gently invite them to bring the baby for the due vaccine.

SENTIMENT BRANCH (MANDATORY — applies to the parent's first reply about the baby):
1. Classify sentiment as POSITIVE / NEGATIVE / UNCLEAR.
   - POSITIVE: baby is well, healthy, growing, eating, sleeping, "ठीक है", "अच्छे हैं".
   - NEGATIVE: baby has fever, cough, not feeding, parent stressed/tired/worried, baby unwell, baby in hospital, or any loss/grief signal.
   - UNCLEAR: ambiguous reply.
2. If POSITIVE → respond warmly in 3–6 words, THEN say:
   "बहुत अच्छा सुनकर खुशी हुई। ${baby?.baby_name ?? "बच्चे"} जी का ${milestoneH} का टीका ${dueH} को है — क्या आप clinic आ पाएँगी?"
   Set baby_sentiment="positive". Set intent_to_attend based on their next reply.
3. If NEGATIVE → DO NOT mention the vaccine at all this turn. Respond with empathy:
   "ओह, सुनकर चिंता हुई। आप घबराइए मत — क्या आप मुझे थोड़ा और बता सकती हैं कि क्या तकलीफ है?"
   Set baby_sentiment="negative". Capture details into baby_health_concern.
   PAEDIATRIC RED FLAGS (any one → set red_flag=true, agent_reply MUST include "तुरंत nearest hospital ले जाइए" and end_call=true):
     - बुख़ार 102°F से ज़्यादा / fever > 102F
     - दौरा / seizure / झटके
     - होंठ नीले पड़ना / blue lips / cyanosis
     - 8 घंटे से दूध नहीं पी रहा / not feeding > 8 hours
     - severe dehydration / सूखे होंठ + पेशाब नहीं
     - साँस लेने में बहुत तकलीफ / severe breathing difficulty
   If NOT a red flag: offer a callback in 2–3 days and softly mention the vaccine can be rescheduled when the baby is better. Set intent_to_attend="not_asked".
4. If UNCLEAR → ask ONE gentle clarifying question. Do NOT mention the vaccine yet.

GENERAL RULES:
- Reply ONLY in Hindi (Devanagari). (Length governed by the LATENCY & STYLE block above. The vaccine-invite turn with date/time is one of the allowed 2-sentence exceptions.)
- For this playbook, "patient name" in the LATENCY & STYLE rule means the PARENT'S name. The baby's name MAY be used naturally when referring to the baby (e.g. "${baby?.baby_name ?? "बच्चे"} जी"); that is not the same as repeating the parent's address.
- Baby's name: write the baby's name AS GIVEN in BABY above (could be Latin or Devanagari).
- NEVER name a doctor. NEVER quote prices. NEVER list multiple vaccines to the parent — only refer to "${milestoneH} का टीका" by milestone label.
- If parent asks "कौन सा टीका?" you may briefly say "${milestoneH} का टीका जो कि ${dose?.vaccine_code ?? "scheduled"} है" but keep it short.
- If parent confirms attendance: intent_to_attend="yes", thank them, end_call=true.
- If parent declines: intent_to_attend="no", capture reason in baby_health_concern, end_call=true. NEVER push twice.
- If parent wants to reschedule: intent_to_attend="reschedule", capture date in rescheduled_to (ISO date), end_call=true.
- If parent is busy: callback_requested=true, intent="busy", end_call=true.

CLINIC INFO (answer questions about the clinic ONLY from this block — never invent doctor names, address, fees, or services):
${kb || "(no clinic info loaded — if asked, say \"मैं front desk से confirm करवा कर callback दिला देती हूँ\" and continue)"}

CLINIC Q&A RULES:
- If the parent asks about clinic address / timings / pediatrician / fees: answer in ONE short Hindi sentence using ONLY the CLINIC INFO block above, then steer back to the vaccine reminder. NEVER list multiple doctors by name — only mention a pediatrician if explicitly asked AND present in CLINIC INFO.
- If the requested fact is missing from CLINIC INFO, say "मैं front desk से confirm करवा कर callback दिला देती हूँ" and set callback_requested=true. Do NOT invent. Do NOT end the call just for an info question.

IMPORTANT: callback_time MUST be an ISO-8601 timestamp (e.g. "2026-05-04T14:30:00+05:30") or null. NEVER a Hindi or English word like "शनिवार" / "kal" / "Saturday".

Respond with strict JSON:
{ "intent": "...", "baby_sentiment": "positive|negative|unclear", "baby_health_concern": null|string, "intent_to_attend": "yes|no|reschedule|unclear|not_asked", "confirmed_slot_iso": null|string, "rescheduled_to": null|string, "red_flag": bool, "callback_requested": bool, "callback_time": null|string, "agent_reply": "...", "end_call": bool }`;
}

async function postProcess(args: {
  out: VaccinationResult;
  ctx: PlaybookContext;
  supabase: import("./_base").AdminClient;
  isEndOfCall: boolean;
}): Promise<void> {
  const { ctx, out, supabase, isEndOfCall } = args;
  // Always bump reminded_count + last_call_id on the primary due dose.
  const dose = pickPrimaryDose(ctx.dueDoses);
  if (dose) {
    const { data: cur } = await supabase
      .from("vaccination_doses")
      .select("reminded_count,status")
      .eq("id", dose.id)
      .maybeSingle();
    const update: import("@/integrations/supabase/types").TablesUpdate<"vaccination_doses"> = {
      last_call_id: ctx.callId,
      reminded_count: (cur?.reminded_count ?? 0) + 1,
    };
    if (out.intent_to_attend === "reschedule" && out.rescheduled_to) {
      update.status = "rescheduled";
      update.rescheduled_to = out.rescheduled_to;
    } else if (out.intent_to_attend === "no") {
      update.status = "declined";
    }
    await supabase.from("vaccination_doses").update(update).eq("id", dose.id);
  }

  if (!isEndOfCall) return;
  await supabase.from("call_outcomes").upsert(
    [{
      call_id: ctx.callId,
      clinic_id: ctx.clinic.id,
      playbook_key: "newborn_vaccination",
      structured: {
        intent: out.intent,
        baby_sentiment: out.baby_sentiment,
        baby_health_concern: out.baby_health_concern,
        intent_to_attend: out.intent_to_attend,
        confirmed_slot_iso: out.confirmed_slot_iso,
        rescheduled_to: out.rescheduled_to,
        callback_requested: out.callback_requested,
        callback_time: out.callback_time,
      },
      config_snapshot: {
        baby: ctx.baby,
        primary_dose: dose,
      } as never,
      red_flag: out.red_flag,
      success: out.intent_to_attend === "yes" || out.intent_to_attend === "reschedule",
    }],
    { onConflict: "call_id" },
  );
}

export const newbornVaccinationPlaybook: Playbook<VaccinationResult> = {
  key: "newborn_vaccination",
  buildGreeting,
  buildSystemPrompt,
  outputSchema: vaccinationOutputSchema,
  postProcess,
};
