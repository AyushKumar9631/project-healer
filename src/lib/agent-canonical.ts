// Canonical agent reply strings that must be byte-identical between the
// agent endpoint (which returns them) and any pre-rendered TTS audio cached
// by the bridge. Keep this file dependency-free so it can be imported from
// both the turn endpoint and the prelude generator routes.

export const FOLLOWUP_BP_GLUCOSE =
  "क्या उसके बाद आपने BP और Glucose की जाँच दोबारा करवाई है? अब आप कैसे हैं?";

// Asked when the patient declines the consent question ("बाद में", "busy",
// "abhi nahi", etc.). Pre-rendered & cached on the bridge so it plays with
// zero TTS round-trip, just like FOLLOWUP_BP_GLUCOSE.
export const CALLBACK_ASK_TIME =
  "कोई बात नहीं। क्या मैं आपको बाद में कॉल कर सकती हूँ — कब का समय आपके लिए ठीक रहेगा?";
