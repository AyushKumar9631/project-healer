
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin = createClient<Database>(supabaseUrl!, supabaseServiceKey!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/**
 * Direct Gemini API caller helper.
 */
async function callGemini(args: {
  prompt: string;
  systemInstruction?: string;
  model?: string;
  responseMimeType?: "application/json" | "text/plain";
}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

  const model = args.model || "gemini-2.5-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body: any = {
    contents: [{ role: "user", parts: [{ text: args.prompt }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 800,
    },
  };

  if (args.systemInstruction) {
    body.system_instruction = { parts: [{ text: args.systemInstruction }] };
  }

  if (args.responseMimeType === "application/json") {
    body.generationConfig.responseMimeType = "application/json";
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText}`);
  }

  const json = await res.json() as any;
  return json.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

/**
 * Extracts a name from an utterance using direct Gemini API.
 */
export async function extractNameFromUtterance(utterance: string): Promise<string | null> {
  if (!utterance || utterance.trim().length < 2) return null;

  const prompt = `Extract the person's name from this Hindi/English utterance. 
If no name is mentioned, return "NONE". 
If they say "my name is Rohit", return "Rohit".
Utterance: "${utterance}"
Output only the name or "NONE".`;

  try {
    const name = await callGemini({
      prompt,
      systemInstruction: "You are a name extraction utility. Output only the name or NONE.",
    });
    
    const trimmed = name.trim();
    if (!trimmed || trimmed === "NONE") return null;
    return trimmed;
  } catch (e) {
    console.error("[patient-identification] Name extraction failed:", e);
    return null;
  }
}

/**
 * Searches for a patient by phone and name.
 */
export async function findPatientByPhoneAndName(args: {
  phone: string;
  name: string;
  clinicId: string;
}): Promise<string | null> {
  const { phone, name, clinicId } = args;
  const last10 = phone.replace(/\D/g, "").slice(-10);
  
  const { data: matches, error } = await supabaseAdmin
    .from("patients")
    .select("id, name")
    .eq("clinic_id", clinicId)
    .ilike("phone", `%${last10}%`);

  if (error || !matches) return null;

  const searchName = name.toLowerCase().trim();
  for (const p of matches) {
    const pName = p.name.toLowerCase().trim();
    if (pName.includes(searchName) || searchName.includes(pName)) {
      return p.id;
    }
  }
  return null;
}
