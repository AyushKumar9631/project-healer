// Pure helper: extract symptoms and vitals mentioned by the patient from a call transcript.
// No dependencies. Safe to call on the client.

export interface TranscriptTurn {
  role: string;
  text: string;
}

export interface ExtractedContext {
  symptoms: string[];
  vitals: string[];
}

interface SymptomRule {
  label: string;
  patterns: RegExp[];
}

const SYMPTOM_RULES: SymptomRule[] = [
  {
    label: "chest pain",
    patterns: [/seene\s*mein\s*dard/i, /chest\s*pain/i, /सीने\s*में\s*दर्द/i, /छाती\s*में\s*दर्द/i],
  },
  {
    label: "swelling",
    patterns: [/\bsujan\b/i, /\bswelling\b/i, /सूजन/i],
  },
  {
    label: "excessive thirst",
    patterns: [/\bpyaas\b/i, /\bthirst(y)?\b/i, /प्यास/i],
  },
  {
    label: "dizziness",
    patterns: [/\bchakkar\b/i, /\bdizz(y|iness)\b/i, /चक्कर/i],
  },
  {
    label: "headache",
    patterns: [/sir\s*dard/i, /\bheadache\b/i, /सिर\s*दर्द/i],
  },
  {
    label: "breathlessness",
    patterns: [/\bsaans\b/i, /breathless(ness)?/i, /shortness\s*of\s*breath/i, /सांस/i],
  },
  {
    label: "weakness",
    patterns: [/kamzor(i|ee)?/i, /\bweakness\b/i, /कमज़ोरी/i, /कमजोरी/i],
  },
  {
    label: "frequent urination",
    patterns: [/\bpeshab\b/i, /frequent\s*urination/i, /पेशाब/i],
  },
  {
    label: "fatigue",
    patterns: [/thak(aan|an)/i, /\bfatigue\b/i, /\btired(ness)?\b/i, /थकान/i],
  },
  {
    label: "vomiting",
    patterns: [/\bulti\b/i, /\bvomit(ing)?\b/i, /\bnausea\b/i, /उल्टी/i],
  },
  {
    label: "insomnia",
    patterns: [
      /नींद\s*नहीं/i,
      /नींद\s*कम/i,
      /\bneend\s*nahi/i,
      /\bnind\s*nahi/i,
      /\binsomnia\b/i,
      /trouble\s*sleep(ing)?/i,
      /can(?:'|no)t\s*sleep/i,
    ],
  },
  {
    label: "blurred vision",
    patterns: [/\bdhundhla/i, /blurred?\s*vision/i, /धुंधला/i, /नज़र\s*कम/i, /नजर\s*कम/i],
  },
  {
    label: "numbness/tingling",
    patterns: [/\bjhunjhuna(hat)?/i, /\bnumb(ness)?\b/i, /\btingling\b/i, /सुन्न/i, /झुनझुनी/i],
  },
];

function extractVitals(text: string): string[] {
  const out: string[] = [];

  const bpRe = /\bbp\s*[:\-]?\s*(\d{2,3})\s*\/\s*(\d{2,3})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = bpRe.exec(text)) !== null) {
    out.push(`BP ${m[1]}/${m[2]}`);
  }

  const sugarRe = /\bsugar\s*[:\-]?\s*(\d{2,4})\b/gi;
  while ((m = sugarRe.exec(text)) !== null) {
    out.push(`Sugar ${m[1]}`);
  }

  const unitRe = /\b(\d{2,4})\s*(mg\/dl|mg|mmhg)\b/gi;
  while ((m = unitRe.exec(text)) !== null) {
    const unit = m[2].toLowerCase();
    const norm = unit === "mmhg" ? "mmHg" : unit === "mg/dl" ? "mg/dL" : "mg";
    out.push(`${m[1]} ${norm}`);
  }

  return out;
}

const CALLBACK_PATTERNS: RegExp[] = [
  /\bकल\s*(?:फिर|दोबारा|वापस)?\s*(?:call|फ़?ोन|phone)/i,
  /\bphir\s*se\s*call/i,
  /\bdobara\s*call/i,
  /\b(?:call|phone)\s*(?:me|kar)?\s*(?:later|baad|बाद)/i,
  /\b(?:baad|बाद)\s*me(?:i|ं)?\s*(?:call|phone)/i,
  /\bcall\s*back\b/i,
  /\bcallback\b/i,
  /\bफिर\s*से\s*(?:call|फ़?ोन)/i,
  /\bदोबारा\s*(?:call|फ़?ोन)/i,
];

export function extractCallback(
  transcript: TranscriptTurn[] | null | undefined,
): { requested: boolean; hint: string | null } {
  if (!Array.isArray(transcript)) return { requested: false, hint: null };
  for (const t of transcript) {
    if (!t || t.role !== "patient" || typeof t.text !== "string") continue;
    for (const re of CALLBACK_PATTERNS) {
      const m = t.text.match(re);
      if (m) return { requested: true, hint: m[0] };
    }
  }
  return { requested: false, hint: null };
}

export function extractFromTranscript(
  transcript: TranscriptTurn[] | null | undefined,
): ExtractedContext {
  if (!Array.isArray(transcript)) return { symptoms: [], vitals: [] };

  const patientText = transcript
    .filter((t) => t && t.role === "patient" && typeof t.text === "string")
    .map((t) => t.text);

  const symptoms: string[] = [];
  const seenSym = new Set<string>();

  for (const text of patientText) {
    for (const rule of SYMPTOM_RULES) {
      if (seenSym.has(rule.label)) continue;
      if (rule.patterns.some((p) => p.test(text))) {
        seenSym.add(rule.label);
        symptoms.push(rule.label);
      }
    }
  }

  const vitals: string[] = [];
  const seenVit = new Set<string>();
  for (const text of patientText) {
    for (const v of extractVitals(text)) {
      const key = v.toLowerCase();
      if (seenVit.has(key)) continue;
      seenVit.add(key);
      vitals.push(v);
    }
  }

  return {
    symptoms: symptoms.slice(0, 6),
    vitals: vitals.slice(0, 6),
  };
}
