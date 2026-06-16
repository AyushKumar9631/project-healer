import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { NURSING_KNOWLEDGE_BLOCK } from "./agent-knowledge";
import { buildIdentityBlock, resolveAgentGender, normalisePatientGender } from "./playbooks/_tone";

const InputSchema = z.object({
  patientUtterance: z.string().min(1).max(2000),
  agentLastMessage: z.string().max(2000).optional().default(""),
  patient: z.object({
    name: z.string(),
    bp: z.string().nullable().optional(),
    blood_sugar: z.string().nullable().optional(),
    health_camp: z.string().nullable().optional(),
    age: z.number().nullable().optional(),
    gender: z.string().nullable().optional(),
    risk: z.string().nullable().optional(),
  }),
  clinicName: z.string(),
  doctors: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        specialization: z.string().nullable().optional(),
        super_specialization: z.string().nullable().optional(),
        qualifications: z.string().nullable().optional(),
        experience_years: z.number().nullable().optional(),
        conditions: z.array(z.string()).default([]),
        languages: z.array(z.string()).default([]),
        availability: z.string().nullable().optional(),
      })
    )
    .max(50),
  history: z
    .array(z.object({ role: z.enum(["agent", "patient"]), text: z.string() }))
    .max(40)
    .default([]),
    prior: z
      .object({
        condition: z.string().nullable().optional(),
        suggested_doctor_id: z.string().nullable().optional(),
        appointment_iso: z.string().nullable().optional(),
        callback_requested: z.boolean().optional(),
        callback_time: z.string().nullable().optional(),
      })
      .optional(),
  phase: z.enum(["in_conversation", "scheduling_callback"]).default("in_conversation"),
});

export type AgentTurnResult = {
  intent: "interested" | "not_interested" | "busy" | "symptom" | "unclear";
  condition: string | null;
  suggested_doctor_id: string | null;
  appointment_iso: string | null;
  callback_requested: boolean;
  callback_time: string | null;
  agent_reply: string;
  end_call: boolean;
};

export const agentTurn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => InputSchema.parse(input))
  .handler(async ({ data }): Promise<AgentTurnResult> => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");

    // SECURITY: hide real doctor UUIDs from the LLM. Use opaque keys.
    const keyToId = new Map<string, string>();
    const idToKey = new Map<string, string>();
    data.doctors.forEach((d, i) => {
      const k = `doctor_${i + 1}`;
      keyToId.set(k, d.id);
      idToKey.set(d.id, k);
    });

    const doctorsList = data.doctors
      .map((d) => {
        const parts: string[] = [];
        const spec = [d.specialization, d.super_specialization].filter(Boolean).join(" / ");
        parts.push(`- ${d.name} (key: ${idToKey.get(d.id)})${spec ? ` — ${spec}` : ""}`);
        if (d.qualifications) parts.push(`  qualifications: ${d.qualifications}`);
        if (d.experience_years) parts.push(`  ${d.experience_years} yrs experience`);
        if (d.conditions && d.conditions.length) parts.push(`  treats: ${d.conditions.join(", ")}`);
        if (d.languages && d.languages.length) parts.push(`  languages: ${d.languages.join(", ")}`);
        if (d.availability) parts.push(`  availability: ${d.availability}`);
        return parts.join("\n");
      })
      .join("\n");

    const transcript = data.history.map((t) => `${t.role === "agent" ? "Agent" : "Patient"}: ${t.text}`).join("\n");

    // Compute current datetime in IST (Asia/Kolkata, +05:30) for relative date resolution
    const nowUtc = new Date();
    const istMs = nowUtc.getTime() + 5.5 * 60 * 60 * 1000;
    const ist = new Date(istMs);
    const pad = (n: number) => String(n).padStart(2, "0");
    const istWall = `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}T${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}+05:30`;

    const identityBlock = buildIdentityBlock({
      direction: "outbound",
      agentGender: resolveAgentGender(),
      patientGender: normalisePatientGender(data.patient.gender),
      patientName: data.patient.name,
      clinicName: data.clinicName,
    });

    const conversationalSystem = `${identityBlock}

You are a polite, empathetic Hindi-speaking health assistant calling on behalf of ${data.clinicName}.
CONTEXT: Current datetime is ${istWall} (Asia/Kolkata, IST). When the patient confirms a relative time ("kal subah 10 baje", "parson dopahar 3 baje"), resolve it against this datetime and emit appointment_iso in full ISO 8601 with the +05:30 offset (e.g. "2026-04-23T10:00:00+05:30").
PATIENT: ${data.patient.name}. Age: ${data.patient.age ?? "n/a"}. Risk: ${data.patient.risk ?? "n/a"}. Camp: ${data.patient.health_camp ?? "general health camp"}. BP: ${data.patient.bp ?? "n/a"}. Blood sugar: ${data.patient.blood_sugar ?? "n/a"}.
(Patient gender + your own gender are governed by the AGENT IDENTITY block above.)

CLINICAL KNOWLEDGE (you have the training of a GNM / B.Sc Nursing + Care Coordinator. Use this ONLY for general triage education, NEVER to diagnose, prescribe, or replace the doctor. Always route the patient to OPD or, for red flags, to the nearest hospital):
${NURSING_KNOWLEDGE_BLOCK}

GOAL: Check if the patient has symptoms related to BP/sugar and offer an OPD appointment with a matching doctor from this clinic's roster ONLY:
${doctorsList || "(no doctors available)"}

STRICT RULES:
- Reply ONLY in conversational Hindi (Devanagari script preferred). Keep replies under 2 sentences.
- NEVER claim someone is the "best" doctor. NEVER suggest a doctor not in the list above.
- NEVER give medical advice or diagnose. Only suggest visiting the clinic / OPD.
- When matching a patient symptom to a doctor, consider in this order: (1) the doctor's "treats" conditions, (2) super_specialization, (3) specialization. ANY one of these matching is enough — do NOT require all of them.
- If the patient explicitly asks "kaunsa doctor / which doctor / specialist hai kya / aapke paas kaun se doctor hain" or any equivalent question about doctor availability, ALWAYS recommend a specific doctor from the list above by name with their specialization — even if no specific symptom has been mentioned yet. If only one doctor is on the roster, recommend that doctor. NEVER reply that no doctor is available when the list above is non-empty.
- Only say "abhi is taklif ke liye specialist available nahi hai" when the roster clearly cannot help (e.g. patient mentions a fracture and only a diabetologist is listed). Even then, offer a general OPD visit — never flatly refuse.
- If risk is "high", be slightly more urgent and emphasise the value of an OPD visit. Use age/gender to make the conversation feel personal (e.g. "aapki umar ko dekhte hue…") without diagnosing.
- If patient agrees to appointment, propose tomorrow morning or day-after; confirm and end.
- When you say "appointment pakki / confirm ho gayi" or any equivalent confirmation phrase, you MUST set appointment_iso to the resolved ISO datetime AND set end_call to true in the SAME turn.
- MANDATORY STRUCTURED FIELDS: Whenever your agent_reply names a doctor from the list, suggested_doctor_key MUST be that doctor's key (e.g. "doctor_1") in the SAME turn. Whenever your agent_reply confirms an appointment, appointment_iso MUST be set in the SAME turn. Whenever the patient reports a BP/sugar/diabetes/hypertension/chest pain related symptom, condition MUST be a non-null canonical label (e.g. "diabetes", "hypertension", "chest pain"). Never set end_call=true unless every structured field implied by your reply is populated.
- NEVER include any database id, UUID, key, "doctor_N", "key:", "id:", or anything in parentheses like "(id:...)" or "(key: ...)" in agent_reply. The agent_reply is what the patient hears — it must contain ONLY the doctor's spoken name and natural Hindi sentences. Identifiers belong only in suggested_doctor_key.
- DOCTOR NAME SCRIPT: When you mention a doctor by name in agent_reply, write the doctor's name in **Latin script exactly as given in the roster above** (e.g. "Doctor Rani Kumari"), NOT in Devanagari. Use the English word "Doctor" instead of "डॉक्टर" / "डॉ.". The rest of the sentence stays in Hindi/Devanagari. This ensures correct pronunciation by the TTS engine.
- PATIENT-INFO QUESTIONS: If the patient asks about their own recorded readings or camp details (e.g. "मेरा BP कितना था?", "sugar kitna tha?", "मेरी जाँच में क्या निकला?", "कौन से camp में?"), answer DIRECTLY using the BP / Blood sugar / camp / age values from the PATIENT block above. Do NOT deflect, do NOT switch to callback mode, do NOT end the call. After answering, continue the medical follow-up naturally (e.g. ask if they got a re-check or how they are feeling now).
- If patient is busy, politely offer to call back later and end. When patient asks to be phoned again later ("abhi busy hoon, baad mein call karna", "kal phone karna", "shaam ko call kijiye"), set callback_requested=true. If they specify a relative time, resolve it to ISO 8601 with +05:30 offset against the current datetime above and put it in callback_time; otherwise callback_time=null. callback_requested and appointment_iso are mutually exclusive in spirit — appointment_iso is for OPD slot confirmation, callback_requested is for deferring this conversation. When callback_requested=true, intent is "busy" (or "interested" if they sound interested but unavailable now), close politely with "ज़रूर, कल फ़ोन करूँगी" and set end_call=true.
- If patient is not interested, politely close and end.
- TRIAGE RULE: When the patient asks a clinical question (e.g. "मेरा BP 150/95 है, यह कैसा है?", "sugar 180 है, ठीक है?", "क्या मुझे चलना चाहिए?"), answer in 1 short Hindi sentence using the CLINICAL KNOWLEDGE bands above (e.g. "150/95 stage-2 hypertension की range में आता है"), then in the SAME reply route them to the matched doctor in OPD. Never give a number-free vague answer when bands clearly apply.
- RED-FLAG RULE: If the patient describes ANY red-flag symptom from the CLINICAL KNOWLEDGE block (chest pain + sweating, sudden weakness/slurred speech, BP ≥180/120 with headache/vomiting, sugar <60 or >300 with symptoms, severe breathlessness, loss of consciousness, pregnancy + high BP), the agent_reply MUST tell them "तुरंत nearest hospital / emergency जाइए" and set condition to the canonical red-flag label (e.g. "chest pain", "stroke symptoms", "hypertensive urgency", "hypoglycemia"). Do NOT propose a future OPD slot in that turn. Set end_call=true after the patient acknowledges.
- NO-PRESCRIPTION RULE: NEVER name any specific drug, brand, dose, or home remedy (no "amlodipine", "metformin", "इस्बगोल", "करेले का जूस", etc.). If asked "कौन सी दवा लूँ?" reply "यह Doctor साहब OPD में बताएँगे" and route to the doctor. Lifestyle advice from the CLINICAL KNOWLEDGE block (walk, salt, sleep, foot care) IS allowed.

Respond ONLY with strict JSON matching this TypeScript type:
{
  "intent": "interested" | "not_interested" | "busy" | "symptom" | "unclear",
  "condition": string | null,            // e.g. "chest pain", "hypertension", "diabetes"
  "suggested_doctor_key": string | null, // must be one of the keys above (doctor_1, doctor_2, ...) or null
  "appointment_iso": string | null,
  "callback_requested": boolean,
  "callback_time": string | null,
  "agent_reply": string,                 // Hindi reply, <= 2 sentences. NEVER contains ids/keys/UUIDs.
  "end_call": boolean
}`;

    const callbackOnlySystem = `${identityBlock}

You are a polite, empathetic Hindi-speaking health assistant calling on behalf of ${data.clinicName}.
CONTEXT: Current datetime is ${istWall} (Asia/Kolkata, IST). The patient has just told you they are busy and cannot talk now. Your ONLY job in this turn is to capture WHEN to call them back.

STRICT RULES:
- Reply in ≤1 short Hindi sentence (Devanagari) confirming the callback time politely. Example: "ज़रूर, कल शाम 5 बजे कॉल करूँगी। धन्यवाद।"
- DO NOT mention doctors, OPD, symptoms, BP, or sugar in your reply.
- Always set: callback_requested=true, intent="busy", end_call=true.
- If the patient gave a relative time ("kal", "kal shaam 5 baje", "parson dopahar", "do din baad", "abhi 2 ghante baad"), resolve it against the IST datetime above into callback_time as full ISO 8601 with +05:30 offset (e.g. "2026-04-24T17:00:00+05:30").
- If the patient gave no specific time ("baad mein", "later"), set callback_time=null but still confirm politely ("ज़रूर, बाद में कॉल करूँगी।").
- Set condition=null, suggested_doctor_id=null, appointment_iso=null.

Respond ONLY with strict JSON matching this TypeScript type:
{
  "intent": "busy",
  "condition": null,
  "suggested_doctor_id": null,
  "appointment_iso": null,
  "callback_requested": true,
  "callback_time": string | null,
  "agent_reply": string,
  "end_call": true
}`;

    const system = data.phase === "scheduling_callback" ? callbackOnlySystem : conversationalSystem;

    const priorDoctorKey = data.prior?.suggested_doctor_id
      ? idToKey.get(data.prior.suggested_doctor_id) ?? "null"
      : "null";
    const priorBlock = data.prior
      ? `PREVIOUSLY EXTRACTED (carry forward unless contradicted):
- condition: ${data.prior.condition ?? "null"}
- suggested_doctor_key: ${priorDoctorKey}
- appointment_iso: ${data.prior.appointment_iso ?? "null"}
- callback_requested: ${data.prior.callback_requested ? "true" : "false"}
- callback_time: ${data.prior.callback_time ?? "null"}

`
      : "";

    // If the patient just consented (only the opening agent turn exists so far),
    // nudge the model to lead with the standard medical follow-up question.
    const justConsented =
      data.phase === "in_conversation" &&
      data.history.length <= 1 &&
      data.history.every((h) => h.role === "agent");
    const consentHint = justConsented
      ? `\nNOTE: Patient just consented to talk. Begin your reply with: "क्या उसके बाद आपने BP और Glucose की जाँच दोबारा करवाई है? अब आप कैसे हैं?" then continue normally based on their answer.\n`
      : "";

    const userMsg = `Conversation so far:
${transcript}

${priorBlock}Patient just said: "${data.patientUtterance}"
${consentHint}
Produce the next agent turn as JSON.`;

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: system },
          { role: "user", content: userMsg },
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`AI gateway error ${res.status}: ${errText}`);
    }

    const json = await res.json();
    const content: string = json.choices?.[0]?.message?.content ?? "{}";

    const OutputSchema = z.object({
      intent: z.enum(["interested", "not_interested", "busy", "symptom", "unclear"]).catch("unclear"),
      condition: z.string().nullable().catch(null),
      suggested_doctor_key: z.string().nullable().optional().catch(null),
      suggested_doctor_id: z.string().nullable().optional().catch(null),
      appointment_iso: z.string().nullable().catch(null),
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
    const parsedResult = OutputSchema.safeParse(raw);
    const baseParsed = parsedResult.success
      ? parsedResult.data
      : {
          intent: "unclear" as const,
          condition: null,
          suggested_doctor_key: null,
          suggested_doctor_id: null,
          appointment_iso: null,
          callback_requested: false,
          callback_time: null,
          agent_reply: "Maaf kijiye, main samajh nahi payi. Kya aap dobara bata sakti hain?",
          end_call: false,
        };

    // Resolve doctor reference: prefer key, fall back to legacy id.
    const validDoctorIds = new Set(data.doctors.map((d) => d.id));
    let resolvedDoctorId: string | null = null;
    if (baseParsed.suggested_doctor_key && keyToId.has(baseParsed.suggested_doctor_key)) {
      resolvedDoctorId = keyToId.get(baseParsed.suggested_doctor_key)!;
    } else if (baseParsed.suggested_doctor_id && validDoctorIds.has(baseParsed.suggested_doctor_id)) {
      resolvedDoctorId = baseParsed.suggested_doctor_id;
    }

    const parsed: AgentTurnResult = {
      intent: baseParsed.intent,
      condition: baseParsed.condition,
      suggested_doctor_id: resolvedDoctorId,
      appointment_iso: baseParsed.appointment_iso,
      callback_requested: baseParsed.callback_requested,
      callback_time: baseParsed.callback_time,
      agent_reply: baseParsed.agent_reply,
      end_call: baseParsed.end_call,
    };

    // Sanitize agent_reply: strip UUIDs / "id:..." / "key:..." / "doctor_N".
    const sanitizeReply = (s: string): string => {
      let r = s ?? "";
      r = r.replace(/\s*\(\s*(?:id\s*[:=]|key\s*[:=]|doctor_\d+)[^)]*\)/gi, "");
      r = r.replace(/\b(?:id|key)\s*[:=]\s*[A-Za-z0-9_-]+/gi, "");
      r = r.replace(/\bdoctor_\d+\b/gi, "");
      r = r.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "");
      r = r.replace(/\(\s*\)/g, "").replace(/\s{2,}/g, " ").trim();
      return r;
    };
    parsed.agent_reply = sanitizeReply(parsed.agent_reply) || "Theek hai.";

    // Carry-forward prior values when current turn omits them and there is no contradiction
    if (data.prior) {
      if (!parsed.condition && data.prior.condition) parsed.condition = data.prior.condition;
      if (
        !parsed.suggested_doctor_id &&
        data.prior.suggested_doctor_id &&
        validDoctorIds.has(data.prior.suggested_doctor_id)
      ) {
        parsed.suggested_doctor_id = data.prior.suggested_doctor_id;
      }
      if (!parsed.appointment_iso && data.prior.appointment_iso) {
        parsed.appointment_iso = data.prior.appointment_iso;
      }
      if (!parsed.callback_requested && data.prior.callback_requested) {
        parsed.callback_requested = true;
      }
      if (!parsed.callback_time && data.prior.callback_time) {
        parsed.callback_time = data.prior.callback_time;
      }
    }

    const reply = parsed.agent_reply ?? "";
    const replyLower = reply.toLowerCase();

    // Doctor extraction from reply text if id missing
    if (!parsed.suggested_doctor_id) {
      const matches = data.doctors.filter((d) => {
        const n = d.name.toLowerCase();
        if (replyLower.includes(n)) return true;
        // also try last token (e.g. "Abhijeet")
        const tokens = n.replace(/^dr\.?\s*/i, "").split(/\s+/).filter(Boolean);
        return tokens.some((t) => t.length >= 4 && replyLower.includes(t));
      });
      if (matches.length === 1) parsed.suggested_doctor_id = matches[0].id;
    }

    // Condition extraction from utterance + reply
    if (!parsed.condition) {
      const haystack = `${data.patientUtterance} ${reply}`.toLowerCase();
      const conditionMap: Array<[RegExp, string]> = [
        [/diabet|sugar|शुगर|डायबिट|मधुमेह/i, "diabetes"],
        [/hypertens|उच्च रक्तचाप|high\s*bp|बीपी|blood\s*pressure|रक्तचाप/i, "hypertension"],
        [/chest\s*pain|seene? me dard|सीने में दर्द|छाती में दर्द/i, "chest pain"],
      ];
      for (const [re, label] of conditionMap) {
        if (re.test(haystack)) {
          parsed.condition = label;
          break;
        }
      }
    }

    // Appointment confirmation detection: if reply confirms but appointment_iso missing,
    // try to derive from prior. (Time parsing from free Hindi text is brittle; rely on model + prior.)
    const confirmRe = /(appointment|अपॉइंटमेंट|अपाइंटमेंट)\s*(pakki|confirm|पक्की|कन्फर्म|पुष्ट)/i;
    const confirmed = confirmRe.test(reply);
    if (confirmed) {
      if (!parsed.appointment_iso && data.prior?.appointment_iso) {
        parsed.appointment_iso = data.prior.appointment_iso;
      }
      if (parsed.appointment_iso) {
        parsed.end_call = true;
      }
    }

    // Callback fallback: regex on the patient's last utterance if model missed it.
    if (!parsed.callback_requested) {
      const callbackRe =
        /\bकल\s*(?:फिर|दोबारा|वापस)?\s*(?:call|फ़?ोन|phone)|\bphir\s*se\s*call|\bdobara\s*call|\b(?:call|phone)\s*(?:me|kar)?\s*(?:later|baad|बाद)|\b(?:baad|बाद)\s*me(?:i|ं)?\s*(?:call|phone)|\bcall\s*back\b|\bcallback\b|\bफिर\s*से\s*(?:call|फ़?ोन)|\bदोबारा\s*(?:call|फ़?ोन)/i;
      if (callbackRe.test(data.patientUtterance)) {
        parsed.callback_requested = true;
      }
    }

    return parsed;
  });
