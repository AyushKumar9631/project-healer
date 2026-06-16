// Shared Knowledge-Base loader + renderer for the inbound reception agent.
//
// Single source of truth used by BOTH:
//   - src/routes/api.public.agent.turn.ts        (non-streaming legacy path)
//   - src/routes/api.public.agent.turn-stream.ts (streaming inbound path)
//
// Without this, the streaming endpoint loaded only patient + clinic and
// `ctx.config.knowledge` was empty, causing the inbound playbook to fall
// into its "no KB loaded" branch and the LLM to hallucinate doctors,
// addresses, and even bracketed UUIDs into the spoken reply.
//
// Cached per clinic_id for 30 minutes (matches per-call TTL in turn.ts).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export type AdminClient = SupabaseClient<Database>;

export type ClinicKnowledge = {
  doctors: Array<{
    id: string;
    name: string;
    specialization: string | null;
    super_specialization: string | null;
    qualifications: string | null;
    experience_years: number | null;
    conditions: string[] | null;
    languages: string[] | null;
    availability: string | null;
    consultation_fee: number | null;
    online_consultation: boolean | null;
  }>;
  profile: {
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
  rendered: string;
  doctorIds: Set<string>;
};

const KB_TTL_MS = 30 * 60_000;
const kbCache = new Map<string, { kb: ClinicKnowledge; expiresAt: number }>();

export function evictClinicKnowledge(clinicId: string) {
  kbCache.delete(clinicId);
}

export async function loadClinicKnowledge(
  supabase: AdminClient,
  clinicId: string,
): Promise<ClinicKnowledge> {
  const now = Date.now();
  const cached = kbCache.get(clinicId);
  if (cached && cached.expiresAt > now) return cached.kb;

  const [docRes, profRes, svcRes, faqRes, polRes] = await Promise.all([
    supabase
      .from("doctors")
      .select(
        "id,name,specialization,super_specialization,qualifications,experience_years,conditions,languages,availability,consultation_fee,online_consultation",
      )
      .eq("clinic_id", clinicId)
      .order("id", { ascending: true }),
    supabase
      .from("clinic_profile")
      .select("about,address,timings,emergency_phone,departments,accreditations,extra_notes")
      .eq("clinic_id", clinicId)
      .maybeSingle(),
    supabase
      .from("kb_services")
      .select("name,category,description,price_min,price_max,currency,duration_minutes,prep_notes")
      .eq("clinic_id", clinicId)
      .eq("is_active", true)
      .limit(50),
    supabase
      .from("kb_faqs")
      .select("question,answer,tags")
      .eq("clinic_id", clinicId)
      .eq("is_active", true)
      .limit(30),
    supabase
      .from("kb_policies")
      .select("title,rule,priority")
      .eq("clinic_id", clinicId)
      .eq("is_active", true)
      .order("priority", { ascending: true })
      .limit(20),
  ]);

  const doctors = (docRes.data ?? []) as ClinicKnowledge["doctors"];
  const profile = (profRes.data ?? null) as ClinicKnowledge["profile"];
  const services = (svcRes.data ?? []) as ClinicKnowledge["services"];
  const faqs = (faqRes.data ?? []) as ClinicKnowledge["faqs"];
  const policies = (polRes.data ?? []) as ClinicKnowledge["policies"];

  const rendered = renderClinicKnowledge({ doctors, profile, services, faqs, policies });
  const doctorIds = new Set<string>(doctors.map((d) => d.id));

  const kb: ClinicKnowledge = {
    doctors,
    profile,
    services,
    faqs,
    policies,
    rendered,
    doctorIds,
  };
  kbCache.set(clinicId, { kb, expiresAt: now + KB_TTL_MS });
  if (kbCache.size > 256) {
    for (const [k, v] of kbCache) if (v.expiresAt <= now) kbCache.delete(k);
  }
  return kb;
}

export function renderClinicKnowledge(args: {
  doctors: ClinicKnowledge["doctors"];
  profile: ClinicKnowledge["profile"];
  services: ClinicKnowledge["services"];
  faqs: ClinicKnowledge["faqs"];
  policies: ClinicKnowledge["policies"];
}): string {
  const { doctors, profile, services, faqs, policies } = args;

  const fmtPrice = (s: ClinicKnowledge["services"][number]) => {
    const cur = s.currency || "INR";
    const sym = cur === "INR" ? "₹" : `${cur} `;
    if (s.price_min == null && s.price_max == null) return "price on request";
    if (s.price_max == null || s.price_min === s.price_max) return `${sym}${s.price_min}`;
    return `${sym}${s.price_min}–${sym}${s.price_max}`;
  };

  const doctorsList = doctors.length
    ? doctors
        .map((d) => {
          const parts: string[] = [];
          const spec = [d.specialization, d.super_specialization].filter(Boolean).join(", ");
          parts.push(`- ${d.name}${spec ? ` — ${spec}` : ""} (id: ${d.id})`);
          if (d.qualifications) parts.push(`  qualifications: ${d.qualifications}`);
          if (d.experience_years) parts.push(`  ${d.experience_years} yrs experience`);
          if (d.conditions?.length) parts.push(`  treats: ${d.conditions.join(", ")}`);
          if (d.languages?.length) parts.push(`  languages: ${d.languages.join(", ")}`);
          if (d.availability) parts.push(`  availability: ${d.availability}`);
          if (d.consultation_fee != null) parts.push(`  consultation fee: ₹${d.consultation_fee}`);
          if (d.online_consultation) parts.push(`  online consultation: available`);
          return parts.join("\n");
        })
        .join("\n")
    : "(NO DOCTORS CONFIGURED — do not invent any doctor; offer callback.)";

  const profileBlock =
    profile &&
    (profile.about ||
      profile.address ||
      profile.timings ||
      profile.emergency_phone ||
      (profile.departments?.length ?? 0) ||
      (profile.accreditations?.length ?? 0) ||
      profile.extra_notes)
      ? `\nCLINIC PROFILE:\n${profile.about ? `About: ${profile.about}\n` : ""}${profile.address ? `Address: ${profile.address}\n` : ""}${profile.timings ? `Timings: ${profile.timings}\n` : ""}${profile.emergency_phone ? `Emergency: ${profile.emergency_phone}\n` : ""}${profile.departments?.length ? `Departments: ${profile.departments.join(", ")}\n` : ""}${profile.accreditations?.length ? `Accreditations: ${profile.accreditations.join(", ")}\n` : ""}${profile.extra_notes ? `Notes: ${profile.extra_notes}\n` : ""}`
      : "\nCLINIC PROFILE: (not configured — do not invent address / timings / departments; offer callback.)\n";

  const servicesBlock = services.length
    ? `\nSERVICES & PRICING (quote ONLY these prices; for anything else say "front desk से confirm करवा दूँगी"):\n${services
        .map((s) => {
          const desc = s.description ? ` — ${s.description.slice(0, 120)}` : "";
          const dur = s.duration_minutes ? `, ~${s.duration_minutes} min` : "";
          const prep = s.prep_notes ? ` (prep: ${s.prep_notes.slice(0, 80)})` : "";
          return `- ${s.name}${s.category ? ` [${s.category}]` : ""} — ${fmtPrice(s)}${dur}${desc}${prep}`;
        })
        .join("\n")}\n`
    : "";

  const faqsBlock = faqs.length
    ? `\nFAQs (use these answers when the patient asks related questions, translate to Hindi):\n${faqs.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join("\n\n")}\n`
    : "";

  const policiesBlock = policies.length
    ? `\nADDITIONAL CLINIC RULES (must follow strictly, in priority order):\n${policies.map((p, i) => `${i + 1}. ${p.title}: ${p.rule}`).join("\n")}\n`
    : "";

  return `DOCTORS (the ONLY ones at this clinic — quote availability verbatim, set suggested_doctor_id to the UUID after "id:"):\n${doctorsList}\n${profileBlock}${servicesBlock}${faqsBlock}${policiesBlock}`;
}

// -------------------------------------------------------------
// Reply sanitization (defense in depth)
// -------------------------------------------------------------
// Even when KB is loaded the model occasionally leaks bracketed metadata
// or the doctor's UUID into the spoken Hindi reply. Strip those before
// TTS / persistence so the patient never hears "(ID: 65c4608…)".

const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ID_PAREN_RE = /\(\s*id\s*:[^)]*\)/gi;
const SQ_BRACKET_RE = /\[[^\]]*\]/g;

export function sanitizeAgentReply(text: string): string {
  if (!text) return text;
  let out = text;
  out = out.replace(ID_PAREN_RE, "");
  out = out.replace(SQ_BRACKET_RE, "");
  out = out.replace(UUID_RE, "");
  // Strip Markdown formatting characters (asterisks, underscores, hashes, tildes)
  out = out.replace(/[*_~`#]+/g, "");
  // Strip Emojis and symbols that cause TTS language glitches
  out = out.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "");
  // Collapse double-spaces and stray punctuation left behind.
  out = out.replace(/\s{2,}/g, " ").replace(/\s+([।.?!,;:])/g, "$1").trim();
  return out;
}

// Returns null if the model emitted a UUID that does not exist in the
// loaded doctors set. Caller should null suggested_doctor_id and log.
export function validateDoctorId(
  id: string | null | undefined,
  doctorIds: Set<string>,
): { valid: boolean; id: string | null } {
  if (!id) return { valid: true, id: null };
  if (doctorIds.has(id)) return { valid: true, id };
  return { valid: false, id: null };
}

// -------------------------------------------------------------
// Address hallucination guard
// -------------------------------------------------------------
// gemini-2.5-flash-lite (with response_format=json_object on long Devanagari
// context) occasionally drifts mid-generation and emits an address in a
// completely different language — observed in production: a Hindi reply
// that suddenly contained "मैत्रीय विहार, बोरज làng, 167, Borj, Hà Nội"
// (Vietnamese). Prompt rules alone don't prevent this — we need a
// post-generation token-allowlist check.
//
// Strategy:
// 1. Build the allowlist from every "address-bearing" string we know:
//    campaign config (cfg.address / cfg.venue), clinic_profile.address,
//    clinic.name, plus a small set of generic Hindi connectors.
// 2. Tokenise the agent reply by splitting on whitespace + comma + danda.
// 3. For every Latin / Devanagari "place-like" token (length ≥ 3,
//    not a tiny stop-word), require it to appear in the allowlist OR be
//    digits-only (street numbers).
// 4. If ANY violation is found, return a rewrite using the safe template.
//
// We deliberately keep this conservative — false positives just trigger a
// rewrite to the canonical address, which is itself correct and on-brand.
// False negatives leave the original reply alone.

const ADDRESS_STOPWORDS = new Set<string>([
  // Hindi connectors / pronouns / verbs that frequently appear next to
  // an address but are not part of it.
  "है", "हैं", "हम", "पर", "में", "और", "क्या", "आप", "हमारे", "हमारी",
  "एक", "को", "का", "की", "के", "से", "तक", "वहाँ", "यहाँ", "ये", "यह",
  "वह", "वो", "जी", "हाँ", "नहीं", "free", "screening", "शिविर",
  "रविवार", "सोमवार", "मंगलवार", "बुधवार", "गुरुवार", "शुक्रवार", "शनिवार",
  "जनवरी", "फरवरी", "मार्च", "अप्रैल", "मई", "जून", "जुलाई", "अगस्त",
  "सितंबर", "अक्टूबर", "नवंबर", "दिसंबर", "करेंगे", "करेगी", "करेगा",
  "जाएगा", "होगा", "होगी", "मेरे", "पास", "अभी", "अभीfront", "front",
  "desk", "callback", "confirm", "करवा", "देती", "हूँ", "हूं", "बात",
  "doctor", "साहब", "BP", "Sugar", "Glucose", "Blood",
  // Common clinic-chat English nouns/verbs the patient or agent uses.
  // These are NOT addresses and must never count as "place-like".
  "consultation", "consult", "consultations", "fee", "fees", "charge",
  "charges", "appointment", "appointments", "online", "offline",
  "hello", "hi", "hey", "ok", "okay", "yes", "no", "sure", "sir",
  "madam", "ma'am", "maam", "sister", "brother", "please", "thanks",
  "thank", "you", "your", "my", "our", "for", "the", "and", "with",
  "from", "today", "tomorrow", "yesterday", "morning", "evening",
  "afternoon", "night", "time", "date", "day", "week", "month",
  "pressure", "diabetes", "diabetic", "checkup", "check", "report",
  "test", "tests", "lab", "scan", "x-ray", "xray", "ecg", "mri",
  "name", "phone", "number", "call", "back", "later", "now", "soon",
  "patient", "doctor", "doctors", "nurse", "clinic", "hospital",
  "health", "ji", "haan", "nahi", "nahin", "kya", "haa",
  // Punctuation residues
  "।", ",", ".",
]);

// Address-question keywords. The guard ONLY rewrites a reply when the
// reply itself looks like it is answering an address/location question.
// This prevents the guard from clobbering doctor-name / fee / consultation
// answers where Latin words ≥4 are completely normal.
const ADDRESS_INTENT_KEYWORDS = [
  "पता", "पते", "address", "कहाँ", "कहां", "location", "रास्ता", "रोड",
  "road", "गली", "lane", "गाँव", "गांव", "शहर", "city", "पर है", "में है",
  "स्थित", "स्थान",
];

function looksLikeAddressAnswer(reply: string): boolean {
  const lc = reply.toLowerCase();
  for (const k of ADDRESS_INTENT_KEYWORDS) {
    if (lc.includes(k.toLowerCase())) return true;
  }
  return false;
}

function tokeniseForAddress(s: string): string[] {
  return s
    .split(/[\s,।.!?()/–—-]+/u)
    .map((t) => t.trim())
    .filter(Boolean);
}

function buildAddressAllowlist(sources: Array<string | null | undefined>): Set<string> {
  const allow = new Set<string>();
  for (const s of sources) {
    if (!s) continue;
    for (const t of tokeniseForAddress(s)) {
      const lc = t.toLowerCase();
      if (lc.length >= 2) allow.add(lc);
    }
  }
  return allow;
}

// Returns { ok } if the reply contains no foreign address-like tokens.
// Returns { ok: false, replacement } with the safe template if drift is
// detected. The caller should also log the original reply.
export function validateAgentAddress(args: {
  reply: string;
  addressSources: Array<string | null | undefined>;
  safeReply: string;
}): { ok: true } | { ok: false; replacement: string } {
  const { reply, addressSources, safeReply } = args;
  if (!reply || !safeReply) return { ok: true };

  // Kill-switch: set ADDRESS_GUARD_DISABLED=true in the env to bypass the
  // guard entirely without redeploying. Useful if it ever misfires again.
  if ((process.env.ADDRESS_GUARD_DISABLED ?? "").toLowerCase() === "true") {
    return { ok: true };
  }

  const allow = buildAddressAllowlist(addressSources);
  if (allow.size === 0) return { ok: true };

  const tokens = tokeniseForAddress(reply);
  let suspicious = 0;
  const offenders: string[] = [];
  for (const t of tokens) {
    if (/^\d+$/.test(t)) continue; // street number
    if (t.length < 3) continue;
    const lc = t.toLowerCase();
    if (ADDRESS_STOPWORDS.has(t) || ADDRESS_STOPWORDS.has(lc)) continue;
    const hasDiacritic = /[\u00C0-\u024F\u1E00-\u1EFF]/.test(t); // Vietnamese etc.
    const hasCJK = /[\u4E00-\u9FFF\u3040-\u30FF]/.test(t);
    const isLatinWord = /^[A-Za-z][A-Za-z'-]*$/.test(t);
    const isDevanagariWord = /^[\u0900-\u097F]+$/.test(t);
    const placeLike = hasDiacritic || hasCJK || isLatinWord || isDevanagariWord;
    if (!placeLike) continue;
    if (allow.has(lc)) continue;
    suspicious++;
    offenders.push(t);
    // Hard-fail immediately on any diacritic/CJK token — those are the
    // unambiguous Vietnamese/Chinese drift signals and never legitimate
    // for an Indian clinic address. This fires regardless of intent.
    if (hasDiacritic || hasCJK) {
      console.warn(
        `[address-guard] rewriting reply (reason=diacritic_or_cjk) offenders=${offenders.slice(0, 8).join(",")} original="${reply.slice(0, 200)}"`,
      );
      return { ok: false, replacement: safeReply };
    }
  }

  // For Latin/Devanagari drift, ONLY rewrite when:
  //   1. The reply actually looks like an address answer (address keyword
  //      present), AND
  //   2. ≥6 unknown place-like tokens are present (was 4, but 4 trips on
  //      normal clinic chat like "doctor consultation online fee").
  // This prevents clobbering doctor-name / fee / appointment replies which
  // legitimately contain several English nouns not in the address allowlist.
  if (suspicious >= 6 && looksLikeAddressAnswer(reply)) {
    console.warn(
      `[address-guard] rewriting reply (reason=latin_threshold suspicious=${suspicious}) offenders=${offenders.slice(0, 8).join(",")} original="${reply.slice(0, 200)}"`,
    );
    return { ok: false, replacement: safeReply };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Reply length enforcement.
//
// Hard cap on agent_reply length. The prompt asks for ≤ 25 Hindi words but
// gemini-2.5-flash-lite regularly overshoots. Long replies → long TTS audio
// → high perceived latency. This trims overflow on the server BEFORE the
// reply is handed to the bridge.
//
// Strategy: split into sentences (Devanagari danda + ASCII terminators),
// keep sentences while running word total stays ≤ maxWords, drop the rest.
// If even the first sentence overflows, hard-truncate it at the word cap
// and append "।".
// ---------------------------------------------------------------------------

export type LengthEnforcementResult = {
  reply: string;
  trimmed: boolean;
  originalWords: number;
  finalWords: number;
};

const SENTENCE_SPLIT_RE = /[।.?!]+\s*/g;

export function enforceReplyLength(
  reply: string,
  opts?: { maxWords?: number; maxSentences?: number },
): LengthEnforcementResult {
  const maxWords = opts?.maxWords ?? 60;
  const maxSentences = opts?.maxSentences ?? 3;
  const trimmed0 = (reply ?? "").trim();
  if (!trimmed0) return { reply: "", trimmed: false, originalWords: 0, finalWords: 0 };

  const countWords = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
  const originalWords = countWords(trimmed0);

  // Tokenise into [sentence, terminator] pairs without losing punctuation.
  const sentences: string[] = [];
  let lastIdx = 0;
  for (const m of trimmed0.matchAll(SENTENCE_SPLIT_RE)) {
    const end = (m.index ?? 0) + m[0].length;
    const seg = trimmed0.slice(lastIdx, end).trim();
    if (seg) sentences.push(seg);
    lastIdx = end;
  }
  if (lastIdx < trimmed0.length) {
    const tail = trimmed0.slice(lastIdx).trim();
    if (tail) sentences.push(tail.endsWith("।") || /[.?!]$/.test(tail) ? tail : tail + "।");
  }
  if (sentences.length === 0) sentences.push(trimmed0);

  // Within budget? Done.
  if (originalWords <= maxWords && sentences.length <= maxSentences) {
    return { reply: trimmed0, trimmed: false, originalWords, finalWords: originalWords };
  }

  // Greedy: keep sentences while running total ≤ maxWords AND ≤ maxSentences.
  const kept: string[] = [];
  let running = 0;
  for (const s of sentences) {
    if (kept.length >= maxSentences) break;
    const w = countWords(s);
    if (kept.length === 0) {
      // First sentence: always include, but truncate if it alone overflows.
      if (w <= maxWords) {
        kept.push(s);
        running += w;
      } else {
        const tokens = s.split(/\s+/).filter(Boolean).slice(0, maxWords);
        let truncated = tokens.join(" ");
        if (!/[।.?!]$/.test(truncated)) truncated += "।";
        kept.push(truncated);
        running += maxWords;
        break;
      }
    } else {
      if (running + w > maxWords) break;
      kept.push(s);
      running += w;
    }
  }

  const finalReply = kept.join(" ").trim();
  return {
    reply: finalReply,
    trimmed: true,
    originalWords,
    finalWords: countWords(finalReply),
  };
}
