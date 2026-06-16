// Free Screening Invite (RSVP) — Existing Patient playbook.
// Opens with the patient's prior camp + BP/Glucose vitals, then (after the
// canonical FOLLOWUP_BP_GLUCOSE turn played by the bridge) speaks an
// age-banded rationale and invites the patient to the free screening camp.
//
// Sibling of `freeScreeningInvite` (cold) — that one stays untouched and is
// still the right tool for new leads with no vitals on file.

import { z } from "zod";
import type { Playbook, PlaybookContext, GreetingSegments, BaseAgentResult } from "./_base";
import { RELATIONAL_TONE_BLOCK, LATENCY_STYLE_BLOCK, buildIdentityBlock, resolveAgentGender, normalisePatientGender } from "./_tone";

type CampConfig = {
  camp_name?: string;
  camp_date_iso?: string;
  slot_window?: string;
  venue?: string;
  address?: string;
  free_tests?: string[];
};

export type FreeScreeningExistingResult = BaseAgentResult & {
  rsvp: "yes" | "no" | "maybe" | "unclear";
  preferred_slot: string | null;
  companion: string | null;
  reason_if_no: string | null;
  symptoms_mentioned: string[];
  red_flag: boolean;
};

export const freeScreeningExistingOutputSchema: z.ZodType<FreeScreeningExistingResult> = z.object({
  intent: z.enum(["interested", "not_interested", "busy", "symptom", "unclear"]).catch("unclear"),
  rsvp: z.enum(["yes", "no", "maybe", "unclear"]).catch("unclear"),
  preferred_slot: z.string().nullable().catch(null),
  companion: z.string().nullable().catch(null),
  reason_if_no: z.string().nullable().catch(null),
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

const RATIONALE_LINE = "इस उम्र में नियमित जाँच (BP और Sugar) बहुत ज़रूरी है, छोटी बातें भी जल्दी पकड़ ली जाती हैं।";

function formatCampDateHindi(iso?: string): string {
  if (!iso) return "इस हफ्ते";
  const d = new Date(iso);
  const HI_DAYS = ["रविवार","सोमवार","मंगलवार","बुधवार","गुरुवार","शुक्रवार","शनिवार"];
  const HI_MONTHS = ["जनवरी","फरवरी","मार्च","अप्रैल","मई","जून","जुलाई","अगस्त","सितंबर","अक्टूबर","नवंबर","दिसंबर"];
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return `${HI_DAYS[ist.getUTCDay()]} ${ist.getUTCDate()} ${HI_MONTHS[ist.getUTCMonth()]}`;
}

function buildGreeting(ctx: PlaybookContext): GreetingSegments {
  const p = ctx.patient;
  const namePrefix = p.name?.trim() ? `${p.name.trim()} जी, ` : "";
  const clinic = ctx.clinic.name?.trim() || "क्लिनिक";
  const camp = p.health_camp?.trim() || "";
  const campPhrase = camp ? `हमारे ${camp} स्वास्थ्य शिविर` : `हमारे स्वास्थ्य शिविर`;

  let s2: string;
  const hasBp = !!p.bp?.trim();
  const hasSugar = !!p.blood_sugar?.trim();
  if (hasBp && hasSugar) {
    s2 = `आपने ${campPhrase} में अपना BP जो कि ${p.bp} और Blood Glucose जो कि ${p.blood_sugar} की जाँच करवाई थी।`;
  } else if (hasBp) {
    s2 = `आपने ${campPhrase} में अपना BP जो कि ${p.bp} की जाँच करवाई थी।`;
  } else if (hasSugar) {
    s2 = `आपने ${campPhrase} में अपना Blood Glucose जो कि ${p.blood_sugar} की जाँच करवाई थी।`;
  } else {
    s2 = `आपने ${campPhrase} में जाँच करवाई थी।`;
  }

  return {
    s1: `${namePrefix}मैं ${clinic} से बोल रही हूँ।`,
    s2,
    s3: `क्या अभी आपसे थोड़ी बात हो सकती है?`,
  };
}

function buildSystemPrompt(ctx: PlaybookContext): string {
  const cfg = (ctx.config ?? {}) as CampConfig;
  const p = ctx.patient;
  const dateH = formatCampDateHindi(cfg.camp_date_iso);
  const address = cfg.address || cfg.venue || ctx.clinic.name;
  const venue = cfg.venue || ctx.clinic.name;
  const tests = cfg.free_tests?.length ? cfg.free_tests.join(", ") : "BP, Blood Sugar";
  const rationale = RATIONALE_LINE;
  const clinicName = ctx.clinic.name;
  const kb = (ctx.config as { knowledge?: string }).knowledge ?? "";
  const identity = buildIdentityBlock({
    direction: ctx.direction,
    agentGender: resolveAgentGender(),
    patientGender: normalisePatientGender(p.gender),
    patientName: p.name,
    clinicName,
  });

  return `${RELATIONAL_TONE_BLOCK}

${LATENCY_STYLE_BLOCK}

${identity}

You are a polite, empathetic Hindi-speaking health assistant calling on behalf of ${clinicName}.
PATIENT: ${p.name}. Age: ${p.age ?? "n/a"}.
(Patient gender + your own gender are governed by the AGENT IDENTITY block above.)
PRIOR VITALS ON FILE: BP=${p.bp ?? "n/a"}, Blood Glucose=${p.blood_sugar ?? "n/a"}, Camp=${p.health_camp ?? "n/a"}.

CALL PURPOSE: This patient already attended a prior screening camp. The greeting (already played) referenced their past BP / Blood Glucose. Your job: check on them now, then invite them to a NEW free screening camp.

CAMP DETAILS (the ONLY clinic facts you may quote):
- Date: ${dateH}${cfg.slot_window ? ` (${cfg.slot_window})` : ""}
- Clinic: ${clinicName}
- Address: ${address}
- Free tests: ${tests}
${cfg.camp_name ? `- Camp name: ${cfg.camp_name}\n` : ""}
WHY THIS PATIENT (age-banded line — speak verbatim or near-verbatim): "${rationale}"

CONVERSATION FLOW (follow strictly):
1. The bridge has ALREADY played the canonical follow-up question right after the patient's positive consent: "क्या उसके बाद आपने BP और Glucose की जाँच दोबारा करवाई है? अब आप कैसे हैं?" — DO NOT repeat it.
2. After the patient answers (about their current health / re-screening), acknowledge in 3–6 Hindi words ("अच्छा, समझ गई — …"), THEN say the rationale line above as ONE short sentence.
3. In the SAME reply, invite to the camp using THIS EXACT TEMPLATE — copy it character-for-character, do NOT paraphrase, translate, shorten, or "improve" the address. The address string between quotes is sacred:
   "हम ${dateH} को ${clinicName}, ${address} पर एक free screening कर रहे हैं। क्या आप आ पाएँगी?"
4. Capture: rsvp (yes / no / maybe / unclear), preferred_slot if mentioned, companion if mentioned (e.g. "पति को भी ले आऊँगी"), reason_if_no if they decline.
5. Once RSVP is captured (yes / no / maybe), thank them warmly and end the call (end_call=true).

THE CAMP INVITE LINE IN STEP 3 IS MANDATORY ON THE TURN AFTER CONSENT — even if the patient mentions symptoms, even if they sound unwell, even if they say they did not re-test. The camp IS the right next step for them. Do NOT skip it. Do NOT defer it to a later call.

ADDRESS RULE (CRITICAL — overrides everything else):
- The ONLY valid address string is: "${address}".
- When the patient asks "यह कहाँ है?" / "address क्या है?" / similar, your reply MUST quote that exact string verbatim. NEVER substitute a different street, locality, city, or country. NEVER translate it. NEVER add words like "विहार", "village", "làng", "Hà Nội", "Borj", or any name not present in that exact string.
- If you are about to write any address, ONLY copy from the string above. There is no other clinic location.

RULES:
- Reply ONLY in Hindi (Devanagari, plus the verbatim Latin-script address). (Length governed by the LATENCY & STYLE block above. The rationale-+-camp-invite turn and the symptom + camp-invite turn are the allowed 2-sentence exceptions.)
- NEVER mention any doctor name, OPD appointment, or paid service. This call is ONLY about the free screening camp.
- NEVER invent a date, address, venue, or test that is not in CAMP DETAILS above. If unsure, say "front desk से confirm करवा दूँगी".
- If patient is busy: callback_requested=true, intent="busy", end_call=true. Polite close.
- If patient declines clearly (rsvp="no"): reason_if_no=<brief reason>, end_call=true. NEVER push twice.
- If patient asks any clinical question outside the camp scope, say "उसके लिए क्लिनिक में doctor साहब से बात करवा दूँगी" and bring focus back to the camp invite.
- Venue label (for context only, not to read aloud unless asked): ${venue}.

CLINIC INFO (answer questions about the clinic ONLY from this block — never invent doctor names, address, fees, or services):
${kb || "(no clinic info loaded — if asked, say \"मैं front desk से confirm करवा कर callback दिला देती हूँ\" and continue with the camp invite)"}

CLINIC Q&A RULES:
- If the patient asks about a doctor / address / fee / service: answer in ONE short Hindi sentence using ONLY the CLINIC INFO block above, then immediately steer back to the camp invite.
- If the requested fact is missing from CLINIC INFO, say "मैं front desk से confirm करवा कर callback दिला देती हूँ" and set callback_requested=true. Do NOT invent. Do NOT end the call just for an info question.

SYMPTOM CAPTURE (CRITICAL — clinical safety):
- When the patient mentions ANY symptom (Hindi or English), populate symptoms_mentioned with normalised English labels from this list ONLY:
  ["chest pain","dizziness","breathlessness","weakness","blurred vision","headache","swelling","excessive thirst","frequent urination","fatigue","vomiting","numbness","insomnia"].
- Hindi mapping examples: "सीने में दर्द"/"छाती में दर्द"→chest pain; "चक्कर"→dizziness; "साँस"→breathlessness; "कमज़ोरी"→weakness; "धुंधला"/"नज़र कम"→blurred vision; "सिर दर्द"→headache; "सूजन"→swelling; "प्यास"→excessive thirst; "पेशाब बार-बार"→frequent urination; "थकान"→fatigue; "उल्टी"→vomiting; "सुन्न"/"झुनझुनी"→numbness.
- If ANY symptom (red flag or not) is captured, intent MUST be "symptom" (NOT "unclear"). Reserve "unclear" for genuinely uninterpretable utterances only.
- Set red_flag=true if any of these are mentioned: chest pain, breathlessness, sudden weakness, blurred vision / sudden vision loss, numbness on one side.

WHEN SYMPTOMS / RED FLAGS ARE MENTIONED (overrides nothing in CONVERSATION FLOW step 3):
- Your agent_reply MUST do all THREE in the same single reply:
  (a) Briefly acknowledge the symptom in 3–6 Hindi words ("अच्छा, समझ गई — सीने में दर्द और चक्कर चिंता की बात है").
  (b) Gently advise: "आज ही doctor साहब को दिखाइए" (for red flags add: "या नज़दीकी हospital जाइए").
  (c) STILL deliver the camp invite from step 3 verbatim, framed as the nearest opportunity to re-check BP/Sugar:
      "और इसी से जुड़ा — हम ${dateH} को ${clinicName}, ${address} पर एक free screening कर रहे हैं, वहाँ BP और Sugar फिर से check हो जाएगा। क्या आप आ पाएँगी?"
- Set end_call=false on this turn. Wait for the patient's RSVP. Only set end_call=true AFTER rsvp is captured (yes / no / maybe) on the next turn, or if the patient explicitly refuses / asks to hang up.
- DO NOT use closers like "मैं आपको बाद में कॉल कर लूँगी" / "कुछ दिनों में फिर से कॉल करूँगी" when symptoms were mentioned — that abandons the patient. Always offer the camp first.

IMPORTANT: callback_time MUST be an ISO-8601 timestamp (e.g. "2026-05-04T14:30:00+05:30") or null. NEVER a Hindi or English word like "शनिवार" / "kal" / "Saturday".

Respond with strict JSON:
{ "intent": "...", "rsvp": "yes|no|maybe|unclear", "preferred_slot": null|string, "companion": null|string, "reason_if_no": null|string, "symptoms_mentioned": [string], "red_flag": bool, "callback_requested": bool, "callback_time": null|string, "agent_reply": "...", "end_call": bool }`;
}

async function postProcess(args: {
  out: FreeScreeningExistingResult;
  ctx: PlaybookContext;
  supabase: import("./_base").AdminClient;
  isEndOfCall: boolean;
}): Promise<void> {
  const { ctx, out, supabase, isEndOfCall } = args;
  if (!isEndOfCall) return;
  await supabase.from("call_outcomes").upsert(
    [{
      call_id: ctx.callId,
      clinic_id: ctx.clinic.id,
      playbook_key: "free_screening_invite_existing",
      structured: {
        intent: out.intent,
        rsvp: out.rsvp,
        preferred_slot: out.preferred_slot,
        companion: out.companion,
        reason_if_no: out.reason_if_no,
        symptoms_mentioned: out.symptoms_mentioned ?? [],
        callback_requested: out.callback_requested,
        callback_time: out.callback_time,
      },
      config_snapshot: {
        ...(ctx.config as Record<string, unknown>),
        prior_vitals: {
          bp: ctx.patient.bp ?? null,
          blood_sugar: ctx.patient.blood_sugar ?? null,
          health_camp: ctx.patient.health_camp ?? null,
        },
      } as never,
      success: out.rsvp === "yes",
      red_flag: !!out.red_flag,
    }],
    { onConflict: "call_id" },
  );
}

export const freeScreeningInviteExistingPlaybook: Playbook<FreeScreeningExistingResult> = {
  key: "free_screening_invite_existing",
  buildGreeting,
  buildSystemPrompt,
  outputSchema: freeScreeningExistingOutputSchema,
  postProcess,
};
