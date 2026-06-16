// Shared consent / callback-time helpers used by both the legacy
// /api/public/agent/turn endpoint and the streaming
// /api/public/agent/turn-stream endpoint. Pure logic — no DB / network.

const POSITIVE_CONSENT_RE =
  /(हाँ|हां|जी\s*हाँ|जी\s*हां|जी|बताइए|बताइये|बोलिए|बोलिये|कहिए|कहिये|ठीक\s*है|ठीक|चलिए|चलिये|ओके|ok|okay|yes|sure|alright|please|हो\s*सकती|बात\s*हो\s*सकती|बात\s*कर|सुन\s*रही|सुन\s*रहा|सुन\s*रहे|haan|haanji|jee|ji|theek|chaliye|boliye|bataiye|acha|achha|accha|अच्छा|बताओ|बताए|bolo|bata|kya\s*hua|क्या\s*हुआ|mhm|mmh|hmm|hm+|umhm|म्म|हम्म|मम्म)/i;

const SHORT_ACK_TOKENS = new Set([
  "mm","mmm","hm","hmm","mhm","mmh","umhm","ji","jee","han","haan","ha","ok","okay","yes","accha","acha","achha",
  "अच्छा","हाँ","हां","जी","हम","म्म","मम्म","हम्म",
]);

const NEGATIVE_CONSENT_RE =
  /(नहीं|नही|nahi|nahin|\bno\b|busy|व्यस्त|मसरूफ|बाद\s*में|baad\s*me|baad|अभी\s*नहीं|abhi\s*nahi|abhi\s*nahin|कल|kal|later|phir|थोड़ी\s*देर|thodi\s*der|काम\s*में|kaam\s*me|meeting|मीटिंग|समय\s*नहीं)/i;

function stripPunct(s: string): string {
  return s.replace(/[.?!,।:;"'`~()\[\]\s]+/g, "").trim();
}

export function isPositiveConsentReply(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  const stripped = stripPunct(t).toLowerCase();
  if (stripped.length <= 6 && SHORT_ACK_TOKENS.has(stripped)) return true;
  if (NEGATIVE_CONSENT_RE.test(t)) return false;
  return POSITIVE_CONSENT_RE.test(t);
}

export function isNegativeConsentReply(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  return NEGATIVE_CONSENT_RE.test(t);
}

// Resolve a Hindi/English relative time phrase to an ISO timestamp in
// Asia/Kolkata. Returns null if nothing parseable.
export function parseCallbackTime(text: string): { iso: string; human: string } | null {
  const t = (text ?? "").toLowerCase().trim();
  if (!t) return null;
  const IST_OFFSET_MIN = 5 * 60 + 30;
  const nowUtc = new Date();
  const nowIst = new Date(nowUtc.getTime() + IST_OFFSET_MIN * 60_000);
  const istDate = (y: number, m: number, d: number, h: number, min: number) => {
    const utc = Date.UTC(y, m, d, h, min) - IST_OFFSET_MIN * 60_000;
    return new Date(utc);
  };
  const today = { y: nowIst.getUTCFullYear(), m: nowIst.getUTCMonth(), d: nowIst.getUTCDate() };
  const addDays = (n: number) => {
    const dt = new Date(Date.UTC(today.y, today.m, today.d + n));
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth(), d: dt.getUTCDate() };
  };

  if (/(एक\s*घंटे\s*बाद|1\s*hour\s*later|one\s*hour\s*later|थोड़ी\s*देर\s*बाद|thodi\s*der\s*baad|in\s*an?\s*hour)/i.test(t)) {
    return { iso: new Date(nowUtc.getTime() + 60 * 60_000).toISOString(), human: "एक घंटे बाद" };
  }
  if (/(दो\s*घंटे\s*बाद|2\s*hours?\s*later|two\s*hours?\s*later)/i.test(t)) {
    return { iso: new Date(nowUtc.getTime() + 2 * 60 * 60_000).toISOString(), human: "दो घंटे बाद" };
  }

  const hourMatch = t.match(/(\d{1,2})\s*(?::\s*(\d{2}))?\s*(बजे|baje|pm|am|p\.m\.|a\.m\.)/i);
  let parsedHour: number | null = null;
  let parsedMin = 0;
  if (hourMatch) {
    let h = parseInt(hourMatch[1], 10);
    parsedMin = hourMatch[2] ? parseInt(hourMatch[2], 10) : 0;
    const suffix = (hourMatch[3] || "").toLowerCase();
    if (h >= 1 && h <= 12) {
      if (/pm|p\.m\./.test(suffix)) h = h === 12 ? 12 : h + 12;
      else if (/am|a\.m\./.test(suffix)) h = h === 12 ? 0 : h;
      else {
        if (/(शाम|shaam|रात|raat|दोपहर|dopahar|evening|night)/i.test(t)) {
          h = h === 12 ? 12 : h + 12;
        } else if (/(सुबह|subah|morning)/i.test(t)) {
          // keep AM
        } else if (h >= 1 && h <= 7) {
          h += 12;
        }
      }
      parsedHour = h;
    }
  }

  let dayOffset = 0;
  let dayLabel = "आज";
  if (/(परसों|day\s*after\s*tomorrow)/i.test(t)) {
    dayOffset = 2;
    dayLabel = "परसों";
  } else if (/(कल|kal|tomorrow)/i.test(t)) {
    dayOffset = 1;
    dayLabel = "कल";
  }

  if (parsedHour === null) {
    if (/(सुबह|subah|morning)/i.test(t)) {
      parsedHour = 9;
      if (dayOffset === 0 && nowIst.getUTCHours() >= 11) {
        dayOffset = 1;
        dayLabel = "कल";
      }
    } else if (/(दोपहर|dopahar|afternoon)/i.test(t)) {
      parsedHour = 14;
    } else if (/(शाम|shaam|evening)/i.test(t)) {
      parsedHour = 18;
    } else if (/(रात|raat|night)/i.test(t)) {
      parsedHour = 20;
    } else if (dayOffset > 0) {
      parsedHour = 11;
    } else {
      return null;
    }
  }

  const target = addDays(dayOffset);
  let dt = istDate(target.y, target.m, target.d, parsedHour, parsedMin);
  if (dt.getTime() <= nowUtc.getTime()) {
    const t2 = addDays(dayOffset + 1);
    dt = istDate(t2.y, t2.m, t2.d, parsedHour, parsedMin);
    if (dayOffset === 0) {
      dayOffset = 1;
      dayLabel = "कल";
    }
  }
  const hourDisplay = parsedHour > 12 ? parsedHour - 12 : parsedHour === 0 ? 12 : parsedHour;
  const minDisplay = parsedMin ? `:${String(parsedMin).padStart(2, "0")}` : "";
  const partLabel =
    parsedHour < 12 ? "सुबह" : parsedHour < 16 ? "दोपहर" : parsedHour < 19 ? "शाम" : "रात";
  return { iso: dt.toISOString(), human: `${dayLabel} ${partLabel} ${hourDisplay}${minDisplay} बजे` };
}
