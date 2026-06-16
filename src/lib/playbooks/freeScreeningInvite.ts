// Free Screening Invite (RSVP) playbook.
// Loads ONLY the per-campaign camp config — no doctors, no FAQs, no services.
// Flow: greeting → consent → caring follow-up (canonical) → age-banded
// rationale + camp invite → capture RSVP.

import { z } from "zod";
import type { Playbook, PlaybookContext, GreetingSegments, BaseAgentResult } from "./_base";
import { RELATIONAL_TONE_BLOCK, LATENCY_STYLE_BLOCK, buildIdentityBlock, resolveAgentGender, normalisePatientGender } from "./_tone";

type CampConfig = {
  camp_name?: string;
  camp_date_iso?: string;     // "2026-05-15T09:00:00+05:30"
  slot_window?: string;       // "9 AM – 1 PM"
  venue?: string;
  free_tests?: string[];
};

export type FreeScreeningResult = BaseAgentResult & {
  rsvp: "yes" | "no" | "maybe" | "unclear";
  preferred_slot: string | null;
  companion: string | null;
  reason_if_no: string | null;
  symptoms_mentioned: string[];
  red_flag: boolean;
};

export const freeScreeningOutputSchema: z.ZodType<FreeScreeningResult> = z.object({
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
  // Display in IST
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return `${HI_DAYS[ist.getUTCDay()]} ${ist.getUTCDate()} ${HI_MONTHS[ist.getUTCMonth()]}`;
}

function buildGreeting(ctx: PlaybookContext): GreetingSegments {
  const p = ctx.patient;
  const namePrefix = p.name?.trim() ? `${p.name.trim()} जी, ` : "";
  const clinic = ctx.clinic.name?.trim() || "क्लिनिक";
  return {
    s1: `${namePrefix}मैं ${clinic} से बोल रही हूँ।`,
    s2: `आपकी सेहत का हाल जानने के लिए call किया है — अभी आप कैसा महसूस कर रही हैं?`,
    s3: `क्या अभी थोड़ी बात हो सकती है?`,
  };
}

function buildSystemPrompt(ctx: PlaybookContext): string {
  const cfg = (ctx.config ?? {}) as CampConfig;
  const p = ctx.patient;
  const dateH = formatCampDateHindi(cfg.camp_date_iso);
  const venue = cfg.venue || ctx.clinic.name;
  const tests = cfg.free_tests?.length ? cfg.free_tests.join(", ") : "BP, Blood Sugar";
  const rationale = RATIONALE_LINE;
  const kb = (ctx.config as { knowledge?: string }).knowledge ?? "";
  const identity = buildIdentityBlock({
    direction: ctx.direction,
    agentGender: resolveAgentGender(),
    patientGender: normalisePatientGender(p.gender),
    patientName: p.name,
    clinicName: ctx.clinic.name,
  });

  return `${RELATIONAL_TONE_BLOCK}

${LATENCY_STYLE_BLOCK}

${identity}

You are a polite, empathetic Hindi-speaking health assistant calling on behalf of ${ctx.clinic.name}.
PATIENT: ${p.name}. Age: ${p.age ?? "n/a"}.
(Patient gender + your own gender are governed by the AGENT IDENTITY block above.)

CALL PURPOSE: Check on the patient's wellbeing, then — only if they sound positive and willing to talk — invite them to a FREE health screening at the clinic.

CAMP DETAILS (the ONLY clinic facts you may quote):
- Date: ${dateH}${cfg.slot_window ? ` (${cfg.slot_window})` : ""}
- Venue: ${venue}
- Free tests: ${tests}
${cfg.camp_name ? `- Camp name: ${cfg.camp_name}\n` : ""}
WHY THIS PATIENT: ${rationale}

ADDRESS RULE (CRITICAL — overrides everything else):
- The ONLY valid venue / address you may speak is: "${venue}".
- When the patient asks "यह कहाँ है?" / "address क्या है?" / similar, your reply MUST quote that exact string verbatim. NEVER substitute a different street, locality, city, or country. NEVER translate it. NEVER add words like "विहार", "village", "làng", "Hà Nội", "Borj", or any name not present in that exact string.
- If the CLINIC INFO block below contains a richer "Address: …" line, you may quote THAT verbatim instead — but never invent.

CONVERSATION FLOW (follow strictly):
1. After consent, ASK a caring follow-up: "अच्छा लगा सुनकर। पिछली बार से अब तक कोई थकान, सिरदर्द, या कोई और तकलीफ?"
2. After they answer, acknowledge in 3–6 words, THEN say the rationale line above, THEN invite to the camp using the date + venue above.
3. Capture: rsvp (yes / no / maybe / unclear), preferred_slot if mentioned, companion if mentioned (e.g. "पति को भी ले आऊँगी"), reason_if_no if they decline.
4. Once RSVP is captured (yes / no / maybe), thank them warmly and end the call (end_call=true).

RULES:
- Reply ONLY in Hindi (Devanagari, plus the verbatim Latin-script venue). (Length governed by the LATENCY & STYLE block above. The camp-invite turn is one of the allowed 2-sentence exceptions.)
- NEVER mention any doctor name, OPD appointment, or paid service. This call is ONLY about the free screening camp.
- NEVER invent a date, venue, or test that is not in CAMP DETAILS above.
- If patient is busy: callback_requested=true, intent="busy", end_call=true. Polite close.
- If patient declines clearly: rsvp="no", reason_if_no=<brief reason>, end_call=true. NEVER push twice.
- If patient asks any clinical question outside the camp scope, say "उसके लिए क्लिनिक में doctor साहब से बात करवा दूँगी" and bring focus back to the camp invite.

CLINIC INFO (answer questions about the clinic ONLY from this block — never invent doctor names, address, fees, or services):
${kb || "(no clinic info loaded — if asked, say \"मैं front desk से confirm करवा कर callback दिला देती हूँ\" and continue with the camp invite)"}

CLINIC Q&A RULES:
- If the patient asks about a doctor / address / fee / service: answer in ONE short Hindi sentence using ONLY the CLINIC INFO block above, then immediately steer back to the camp invite.
- If the requested fact is missing from CLINIC INFO, say "मैं front desk से confirm करवा कर callback दिला देती हूँ" and set callback_requested=true. Do NOT invent. Do NOT end the call just for an info question.

SYMPTOM CAPTURE (CRITICAL — clinical safety):
- When the patient mentions ANY symptom, populate symptoms_mentioned with normalised English labels from this list ONLY:
  ["chest pain","dizziness","breathlessness","weakness","blurred vision","headache","swelling","excessive thirst","frequent urination","fatigue","vomiting","numbness","insomnia"].
- If ANY symptom is captured, intent MUST be "symptom" (NOT "unclear"). Reserve "unclear" for genuinely uninterpretable utterances only.
- Set red_flag=true if patient mentions chest pain, breathlessness, sudden weakness, blurred / lost vision, or one-sided numbness.

WHEN SYMPTOMS / RED FLAGS ARE MENTIONED:
- The camp invite is MANDATORY on this turn. Do NOT hang up before asking.
- agent_reply MUST do all THREE in the same single reply:
  (a) Briefly acknowledge the symptom in 3–6 Hindi words.
  (b) Gently advise: "आज ही doctor साहब को दिखाइए" (for red flags add: "या नज़दीकी hospital जाइए").
  (c) STILL deliver the camp invite as the nearest opportunity to get checked: "और इसी से जुड़ा — हम ${dateH} को ${venue} पर एक free screening कर रहे हैं, वहाँ BP और Sugar check हो जाएगा। क्या आप आ पाएँगी?"
- Set end_call=false on this turn. Wait for the patient's RSVP. Only set end_call=true AFTER rsvp is captured (yes / no / maybe), or if the patient explicitly refuses.
- DO NOT use closers like "मैं आपको बाद में कॉल कर लूँगी" / "कुछ दिनों में फिर से कॉल करूँगी" when symptoms were mentioned.

IMPORTANT: callback_time MUST be an ISO-8601 timestamp (e.g. "2026-05-04T14:30:00+05:30") or null. NEVER a Hindi or English word like "शनिवार" / "kal" / "Saturday".

Respond with strict JSON:
{ "intent": "...", "rsvp": "yes|no|maybe|unclear", "preferred_slot": null|string, "companion": null|string, "reason_if_no": null|string, "symptoms_mentioned": [string], "red_flag": bool, "callback_requested": bool, "callback_time": null|string, "agent_reply": "...", "end_call": bool }`;
}

async function postProcess(args: {
  out: FreeScreeningResult;
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
      playbook_key: "free_screening_invite",
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
      config_snapshot: ctx.config as never,
      success: out.rsvp === "yes",
      red_flag: !!out.red_flag,
    }],
    { onConflict: "call_id" },
  );
}

export const freeScreeningInvitePlaybook: Playbook<FreeScreeningResult> = {
  key: "free_screening_invite",
  buildGreeting,
  buildSystemPrompt,
  outputSchema: freeScreeningOutputSchema,
  postProcess,
};
