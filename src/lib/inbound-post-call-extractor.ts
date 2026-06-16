// Post-call structured extraction for inbound_reception calls.
//
// After end_call=true is received, the full call transcript is sent here.
// A second LLM call extracts all the heavy structured fields (appointment,
// doctor, topic, complaint, callback, etc.) that the live turn model no
// longer outputs. postProcess logic (appointments upsert, WhatsApp, etc.)
// is then run with the extracted data.

export type TranscriptTurn = { role: "agent" | "caller"; text: string };

export type InboundExtractedData = {
  caller_name: string | null;
  caller_phone_confirmed: string | null;
  appointment_iso: string | null;        // ISO-8601 +05:30 if appointment was booked
  suggested_doctor_id: string | null;    // UUID from KB if mentioned
  topic: string | null;                  // chief complaint / reason for visit
  callback_time: string | null;          // ISO-8601 if callback was requested
  complaint_text: string | null;         // verbatim complaint if complaint call
  call_outcome:
    | "appointment_booked"
    | "callback_scheduled"
    | "enquiry_handled"
    | "complaint_logged"
    | "emergency_escalated"
    | "no_outcome";
  report_requested: boolean;
};

const VALID_OUTCOMES = new Set([
  "appointment_booked",
  "callback_scheduled",
  "enquiry_handled",
  "complaint_logged",
  "emergency_escalated",
  "no_outcome",
]);

function buildExtractionPrompt(args: {
  transcript: TranscriptTurn[];
  callerIntent: string | null;
  clinicKB: string | null;
  callId: string;
}): string {
  const { transcript, callerIntent, clinicKB } = args;

  const nowUtc = new Date();
  const ist = new Date(nowUtc.getTime() + 5.5 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const istWall = `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}T${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}+05:30`;

  const transcriptText = transcript
    .map((t) => `${t.role === "agent" ? "Agent" : "Caller"}: ${t.text}`)
    .join("\n");

  const kbSection = clinicKB
    ? `\nCLINIC KNOWLEDGE BASE (use doctor UUIDs from here only):\n${clinicKB}\n`
    : "";

  return `You are a medical transcription extraction system. You will be given a completed phone call transcript between a clinic receptionist agent and a caller. Extract structured data from it.

CURRENT IST DATETIME: ${istWall}
CALLER INTENT (pre-classified): ${callerIntent ?? "unknown"}
${kbSection}
TRANSCRIPT:
${transcriptText}

EXTRACTION RULES:
1. Extract ONLY what was explicitly confirmed in the conversation — do NOT infer or guess.
2. For appointment_iso: if the agent said the booking confirmation phrase ("appointment book ho gaya" or similar) AND a specific date/time was agreed upon in the conversation, resolve that date/time to ISO-8601 with +05:30 offset using the current IST datetime above as anchor for relative times ("kal", "Monday", etc.). If no appointment was confirmed by the agent, use null.
3. For suggested_doctor_id: look at which doctor was discussed or confirmed in the conversation. Match the doctor's name (spoken in Hindi/Latin script) against the DOCTORS list in the CLINIC KNOWLEDGE BASE above — each entry has "(id: UUID)". Return the UUID of the matched doctor. If no doctor was identified or confirmed, use null. IMPORTANT: the UUID must come from the "(id: ...)" entry in the knowledge base — do NOT invent UUIDs.
4. For call_outcome: pick exactly one from ["appointment_booked", "callback_scheduled", "enquiry_handled", "complaint_logged", "emergency_escalated", "no_outcome"].
   - "appointment_booked" = agent said something like "appointment book ho gaya" AND a specific time was confirmed
   - "callback_scheduled" = agent promised to call back, caller gave a preferred time
   - "enquiry_handled" = general question was answered
   - "complaint_logged" = caller made a complaint that was acknowledged
   - "emergency_escalated" = red-flag emergency situation handled
   - "no_outcome" = call ended without resolution
5. For callback_time: ISO-8601 with +05:30 if a callback time was explicitly agreed upon, else null. Never use Hindi words like "kal" — resolve to a full timestamp.
6. For caller_name: the name the caller gave during the call, if any. Null if never stated.
7. For topic: REQUIRED — a brief 3-5 word summary of the chief complaint or reason for the call (e.g. "fever and cough enquiry", "appointment booking with Dr. Sharma", "report collection follow-up"). This field must always be filled with a concise summary of what the call was about; do not return null unless the transcript is completely empty.
8. For complaint_text: if the call was a complaint (call_outcome = "complaint_logged"), the caller's verbatim complaint in their own words. Otherwise null.
9. For report_requested: true only if the caller explicitly asked about a lab report, test result, X-ray, ECG, or similar.
10. For caller_phone_confirmed: if the caller confirmed or stated their own phone number during the call, capture it. Otherwise null.

Output ONLY a single valid JSON object with no preamble, no explanation, no markdown fences:
{
  "caller_name": string | null,
  "caller_phone_confirmed": string | null,
  "appointment_iso": string | null,
  "suggested_doctor_id": string | null,
  "topic": string | null,
  "callback_time": string | null,
  "complaint_text": string | null,
  "call_outcome": "appointment_booked" | "callback_scheduled" | "enquiry_handled" | "complaint_logged" | "emergency_escalated" | "no_outcome",
  "report_requested": boolean
}`;
}

export async function extractInboundCallData(args: {
  transcript: TranscriptTurn[];
  callerIntent: string | null;
  clinicKB: string | null;
  callId: string;
}): Promise<InboundExtractedData> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) {
    console.error("[inbound-extractor] LOVABLE_API_KEY not configured");
    return fallbackExtraction(args.callerIntent);
  }

  const prompt = buildExtractionPrompt(args);

  let content = "{}";
  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // Use flash (not flash-lite) for post-call extraction — it needs to
        // match doctor names spoken in Hindi/Latin against KB UUIDs accurately.
        // This runs once per call, so cost is negligible.
        model: process.env.AGENT_EXTRACTION_MODEL ?? "google/gemini-2.5-flash",
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        response_format: { type: "json_object" },
        max_tokens: 1000,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(
        `[inbound-extractor] AI gateway error ${res.status}: ${errText.slice(0, 300)} callId=${args.callId}`,
      );
      return fallbackExtraction(args.callerIntent);
    }

    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    content = json.choices?.[0]?.message?.content ?? "{}";
  } catch (e) {
    console.error(
      `[inbound-extractor] fetch failed callId=${args.callId}: ${e instanceof Error ? e.message : e}`,
    );
    return fallbackExtraction(args.callerIntent);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    console.error(
      `[inbound-extractor] JSON.parse failed callId=${args.callId} tail="${content.slice(-200)}"`,
    );
    return fallbackExtraction(args.callerIntent);
  }

  return parseExtractedData(raw, args.callerIntent);
}

function parseExtractedData(raw: unknown, callerIntent: string | null): InboundExtractedData {
  if (typeof raw !== "object" || raw === null) return fallbackExtraction(callerIntent);

  const r = raw as Record<string, unknown>;

  const callOutcomeRaw = typeof r.call_outcome === "string" ? r.call_outcome : null;
  const callOutcome: InboundExtractedData["call_outcome"] = VALID_OUTCOMES.has(callOutcomeRaw ?? "")
    ? (callOutcomeRaw as InboundExtractedData["call_outcome"])
    : inferCallOutcome(callerIntent);

  const appointment_iso = (() => {
    const v = typeof r.appointment_iso === "string" ? r.appointment_iso.trim() : null;
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : v;
  })();

  const callback_time = (() => {
    const v = typeof r.callback_time === "string" ? r.callback_time.trim() : null;
    if (!v) return null;
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
      const d = new Date(v);
      return isNaN(d.getTime()) ? null : v;
    }
    return null;
  })();

  return {
    caller_name: typeof r.caller_name === "string" ? r.caller_name.trim() || null : null,
    caller_phone_confirmed:
      typeof r.caller_phone_confirmed === "string" ? r.caller_phone_confirmed.trim() || null : null,
    appointment_iso,
    suggested_doctor_id:
      typeof r.suggested_doctor_id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.suggested_doctor_id)
        ? r.suggested_doctor_id
        : null,
    topic: typeof r.topic === "string" ? r.topic.trim() || null : null,
    callback_time,
    complaint_text: typeof r.complaint_text === "string" ? r.complaint_text.trim() || null : null,
    call_outcome: callOutcome,
    report_requested: typeof r.report_requested === "boolean" ? r.report_requested : false,
  };
}

function inferCallOutcome(
  callerIntent: string | null,
): InboundExtractedData["call_outcome"] {
  switch (callerIntent) {
    case "appointment_request":
    case "follow_up_request":
      return "appointment_booked";
    case "callback_request":
      return "callback_scheduled";
    case "info_request":
    case "report_enquiry":
      return "enquiry_handled";
    case "complaint":
      return "complaint_logged";
    default:
      return "no_outcome";
  }
}

function fallbackExtraction(callerIntent: string | null): InboundExtractedData {
  return {
    caller_name: null,
    caller_phone_confirmed: null,
    appointment_iso: null,
    suggested_doctor_id: null,
    topic: null,
    callback_time: null,
    complaint_text: null,
    call_outcome: inferCallOutcome(callerIntent),
    report_requested: false,
  };
}
