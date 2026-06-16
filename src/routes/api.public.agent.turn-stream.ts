// /api/public/agent/turn-stream
//
// Playbook-aware streaming variant of /api/public/agent/turn.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { AgentResult } from "@/routes/api.public.agent.turn";
import { resolvePlaybook } from "@/lib/playbooks/registry";
import type { PlaybookContext, PlaybookKey, BaseAgentResult } from "@/lib/playbooks/_base";
import { isPlaceholderName } from "@/lib/playbooks/inboundReception";
import { isPositiveConsentReply, isNegativeConsentReply, parseCallbackTime } from "@/lib/agent-consent";
import { FOLLOWUP_BP_GLUCOSE, CALLBACK_ASK_TIME } from "@/lib/agent-canonical";
import { AgentReplyExtractor, parseSseLine } from "@/lib/agent-stream.server";
import { fetchPatientCallHistoryContext, injectMemoryToSystemPrompt } from "@/lib/call-memory.server";
import { extractNameFromUtterance, findPatientByPhoneAndName } from "@/lib/patient-identification.server";
import {
  loadClinicKnowledge,
  sanitizeAgentReply,
  validateDoctorId,
  validateAgentAddress,
  enforceReplyLength,
  type ClinicKnowledge,
} from "@/lib/agent-kb.server";

type StreamContext = {
  patient: any;
  clinic: any;
  kb: ClinicKnowledge | null;
  useCase: string | null;
  playbookConfig: any;
  effectiveMemory: string | null;
  expiresAt: number;
};
const streamCtxCache = new Map<string, StreamContext>();
const CTX_TTL_MS = 30 * 60_000;

const StreamInputSchema = z.object({
  callId: z.string().uuid(),
  utterance: z.string().max(2000).optional().default(""),
  isFirstTurn: z.boolean().optional().default(false),
  memoryContext: z.string().nullable().optional(), // Fed explicitly by telephony initialization
});

function buildAdminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server env missing");
  return createClient<Database>(url, key, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  });
}

function buildDoctorKeyToId(doctors: Array<{ id: string }>): Map<string, string> {
  const m = new Map<string, string>();
  doctors.forEach((d, i) => m.set(`doctor_${i + 1}`, d.id));
  return m;
}

// Maps caller_intent values (emitted by LLM) to the intent enum used in AgentResult.
// Mirrors CALLER_INTENT_TO_INTENT in inboundReception.ts.
const CALLER_INTENT_TO_INTENT_MAP: Record<string, string> = {
  info_request: "general_enquiry",
  appointment_request: "appointment_request",
  follow_up_request: "follow_up_request",
  complaint: "complaint",
  callback_request: "callback_request",
  report_enquiry: "report_enquiry",
  symptom: "symptom",
  other: "unclear",
  unclear: "unclear",
};

function toAgentResult(
  out: BaseAgentResult & Record<string, unknown>,
  doctorKeyToId?: Map<string, string>,
): AgentResult {
  let resolvedDoctorId: string | null =
    typeof out.suggested_doctor_id === "string" ? out.suggested_doctor_id : null;
  if (!resolvedDoctorId && typeof out.suggested_doctor_key === "string" && doctorKeyToId) {
    resolvedDoctorId = doctorKeyToId.get(out.suggested_doctor_key) ?? null;
  }

  // Derive intent from caller_intent when the LLM omits the raw intent key.
  // The inbound_reception prompt never instructs the LLM to emit "intent" directly —
  // it only emits "caller_intent". Without this derivation, out.intent would always
  // be the Zod .catch() fallback ("unclear"), causing every turn to log incorrectly.
  let derivedIntent = out.intent as string | undefined;
  if (!derivedIntent || derivedIntent === "unclear") {
    const callerIntent = typeof out.caller_intent === "string" ? out.caller_intent : null;
    if (callerIntent) {
      derivedIntent = CALLER_INTENT_TO_INTENT_MAP[callerIntent] ?? "unclear";
    }
  }
  derivedIntent = derivedIntent ?? "unclear";

  const result: AgentResult = {
    intent: derivedIntent as AgentResult["intent"],
    condition: (typeof out.condition === "string" ? out.condition : null),
    suggested_doctor_id: resolvedDoctorId,
    appointment_iso: typeof out.appointment_iso === "string" ? out.appointment_iso : null,
    callback_requested: !!out.callback_requested,
    callback_time: typeof out.callback_time === "string" ? out.callback_time : null,
    agent_reply: out.agent_reply,
    end_call: !!out.end_call,
  };
  const extras = result as unknown as Record<string, unknown>;
  extras.classified_call_type = typeof out.classified_call_type === "string" ? out.classified_call_type : null;
  if (typeof out.topic === "string" || out.topic === null) {
    extras.topic = out.topic ?? null;
  }
  if (Array.isArray(out.symptoms_mentioned)) {
    extras.symptoms_mentioned = out.symptoms_mentioned;
  }
  if (typeof out.red_flag === "boolean") {
    extras.red_flag = out.red_flag;
  }
  if (typeof out.resolved === "boolean") {
    extras.resolved = out.resolved;
  }
  return result;
}

function isConsentTurn(
  isFirstTurn: boolean,
  transcript: Array<{ role: "agent" | "patient"; text: string }>,
): boolean {
  if (isFirstTurn) return false;
  if (transcript.length === 0) return true;
  if (transcript.length === 1 && transcript[0]?.role === "agent") return true;
  return false;
}

export const Route = createFileRoute("/api/public/agent/turn-stream")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.BRIDGE_SHARED_SECRET;
        if (!expected) {
          return Response.json({ error: "BRIDGE_SHARED_SECRET not configured" }, { status: 500 });
        }
        const provided = request.headers.get("x-bridge-secret");
        if (!provided || provided !== expected) {
          return new Response("unauthorized", { status: 401 });
        }

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "bad json" }, { status: 400 });
        }
        const parsed = StreamInputSchema.safeParse(body);
        if (!parsed.success) {
          return Response.json({ error: "invalid input", issues: parsed.error.flatten() }, { status: 400 });
        }
        const { callId, utterance, isFirstTurn, memoryContext: initialMemory } = parsed.data;

        let supabase: ReturnType<typeof buildAdminClient>;
        try {
          supabase = buildAdminClient();
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
        }

        const callRes = await supabase
          .from("calls")
          .select("id,clinic_id,patient_id,direction,campaign_id,transcript,intent,outcome,metadata")
          .eq("id", callId)
          .maybeSingle();
        if (callRes.error || !callRes.data) {
          return Response.json({ error: "call not found" }, { status: 404 });
        }
        const call = callRes.data;
        const isInbound = call.direction === "inbound";

        let useCase: string | null = null;
        let playbookConfig: Record<string, unknown> = {};
        let patient: any;
        let clinic: any;
        let kb: ClinicKnowledge | null = null;
        
        const transcript = (Array.isArray(call.transcript) ? call.transcript : []) as Array<{
          role: "agent" | "patient";
          text: string;
        }>;
        const turnNumber = transcript.length === 0 ? 1 : Math.floor(transcript.length / 2) + 1;
        
        let effectiveMemory: string | null = initialMemory ?? null;
        const callMetadata = (call.metadata || {}) as Record<string, unknown>;
        
        const now = Date.now();
        let cached = streamCtxCache.get(callId);
        if (cached && cached.expiresAt < now) { streamCtxCache.delete(callId); cached = undefined; }

        if (cached) {
          patient = cached.patient;
          clinic = cached.clinic;
          kb = cached.kb;
          useCase = cached.useCase;
          playbookConfig = cached.playbookConfig;
          effectiveMemory = cached.effectiveMemory;
        } else {
          if (call.campaign_id) {
            const [campRes, cfgRes] = await Promise.all([
              supabase.from("campaigns").select("use_case").eq("id", call.campaign_id).maybeSingle(),
              supabase.from("campaign_playbook_config").select("config_json").eq("campaign_id", call.campaign_id).maybeSingle(),
            ]);
            useCase = (campRes.data?.use_case as string | null) ?? null;
            playbookConfig = (cfgRes.data?.config_json as Record<string, unknown> | null) ?? {};
          }
          const [patientRes, clinicRes, kbRes] = await Promise.all([
            supabase.from("patients").select("id,name,bp,blood_sugar,health_camp,age,gender,risk,phone").eq("id", call.patient_id).maybeSingle(),
            supabase.from("clinics").select("id,name").eq("id", call.clinic_id).maybeSingle(),
            loadClinicKnowledge(supabase, call.clinic_id).catch((e) => {
              console.error(`[agent.turn-stream] loadClinicKnowledge failed: ${e instanceof Error ? e.message : e}`);
              return null as ClinicKnowledge | null;
            }),
          ]);
          if (!patientRes.data || !clinicRes.data) {
            return Response.json({ error: "missing patient/clinic" }, { status: 404 });
          }
          patient = patientRes.data;
          clinic = clinicRes.data;
          kb = kbRes ?? null;
          if (kb) {
            playbookConfig = { ...playbookConfig, knowledge: kb.rendered };
          }
          if (isInbound) {
            let identityUnlocked = !isPlaceholderName(patient.name);
            const pastFirstTurn = turnNumber > 1;

            // Try to unlock identity mid-call if still unknown and we have a patient utterance
            if (!identityUnlocked && utterance && turnNumber > 1) {
              const extractedName = await extractNameFromUtterance(utterance);
              if (extractedName) {
                const foundPatientId = await findPatientByPhoneAndName({
                  phone: patient.phone || "",
                  name: extractedName,
                  clinicId: clinic.id,
                });

                if (foundPatientId && foundPatientId !== patient.id) {
                  console.log(`[agent.turn-stream] Patient promoted: ${patient.id} -> ${foundPatientId} (Name: ${extractedName})`);
                  // Update call row in DB
                  await supabase.from("calls").update({ patient_id: foundPatientId }).eq("id", callId);
                  
                  // Re-fetch patient details
                  const newPatientRes = await supabase.from("patients").select("id,name,bp,blood_sugar,health_camp,age,gender,risk,phone").eq("id", foundPatientId).maybeSingle();
                  if (newPatientRes.data) {
                    patient = newPatientRes.data;
                    identityUnlocked = true;
                    // Invalidate cache since patient identity changed
                    streamCtxCache.delete(callId);
                  }
                }
              }
            }

            if (identityUnlocked && (pastFirstTurn || identityUnlocked)) {
              if (!callMetadata.is_memory_injected) {
                console.log(`[agent.turn-stream] Inbound Identity Unlocked ("${patient.name}"). Fetching timeline historical memories...`);
                effectiveMemory = await fetchPatientCallHistoryContext({ patientId: patient.id, supabase });
                await supabase.from("calls").update({ metadata: { ...callMetadata, is_memory_injected: true, injected_timeline_len: effectiveMemory?.length ?? 0 } }).eq("id", callId);
              } else {
                effectiveMemory = await fetchPatientCallHistoryContext({ patientId: patient.id, supabase });
              }
            }
          } else {
            if (!effectiveMemory) {
              effectiveMemory = await fetchPatientCallHistoryContext({ patientId: call.patient_id, supabase });
            }
          }
          streamCtxCache.set(callId, { patient, clinic, kb, useCase, playbookConfig, effectiveMemory, expiresAt: now + CTX_TTL_MS });
          if (streamCtxCache.size > 256) {
            for (const [k, v] of streamCtxCache) {
              if (v.expiresAt <= now) streamCtxCache.delete(k);
            }
          }
        }
        
        // If memory was unlocked on THIS turn, invalidate cache so we re-fetch next turn if needed
        if (isInbound && turnNumber > 1 && !isPlaceholderName(patient.name) && !effectiveMemory) {
           streamCtxCache.delete(callId);
        }

        const outcomeCallType = (() => {
          const o = (call as { outcome?: unknown }).outcome;
          if (o !== null && typeof o === "object" && !Array.isArray(o) && typeof (o as Record<string, unknown>).call_type === "string") {
            return (o as Record<string, unknown>).call_type as string;
          }
          return null;
        })();
        const rowIntent = (call as { intent?: string | null }).intent ?? null;
        const currentIntent = outcomeCallType ?? rowIntent ?? "Unidentified";

        const playbookKey = (useCase ?? (isInbound ? "inbound_reception" : "screening_to_opd")) as PlaybookKey;

        const pbCtx: PlaybookContext = {
          callId,
          clinic: { id: clinic.id, name: clinic.name },
          patient: {
            id: patient.id,
            name: patient.name,
            phone: patient.phone ?? null,
            age: patient.age ?? null,
            gender: patient.gender ?? null,
            bp: patient.bp ?? null,
            blood_sugar: patient.blood_sugar ?? null,
            health_camp: patient.health_camp ?? null,
            risk: patient.risk ?? null,
          },
          campaignId: call.campaign_id,
          playbookKey,
          config: { ...playbookConfig, currentIntent, turnNumber },
          direction: isInbound ? "inbound" : "outbound",
          baby: null,
          dueDoses: [],
        };

        console.log(`[agent.turn-stream] callId=${callId} use_case=${playbookKey} turn=${turnNumber} hasTimeline=${!!effectiveMemory}`);

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const emit = (obj: unknown) => {
              controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
            };

            try {
              const consentEligible = playbookKey === "screening_to_opd" || playbookKey === "free_screening_invite_existing";
              const consent = isConsentTurn(isFirstTurn, transcript);

              if (consentEligible && consent && isPositiveConsentReply(utterance)) {
                const result: AgentResult = {
                  intent: "interested", condition: null, suggested_doctor_id: null, appointment_iso: null,
                  callback_requested: false, callback_time: null, agent_reply: FOLLOWUP_BP_GLUCOSE, end_call: false,
                };
                emit({ type: "chunk", text: FOLLOWUP_BP_GLUCOSE });
                emit({ type: "final", result });
                controller.close();
                return;
              }

              if (consentEligible && consent && isNegativeConsentReply(utterance)) {
                const t = parseCallbackTime(utterance);
                const fastReply = t ? `ठीक है, मैं आपको ${t.human} पर कॉल करूँगी। धन्यवाद, नमस्ते।` : CALLBACK_ASK_TIME;
                const result: AgentResult = {
                  intent: "busy", condition: null, suggested_doctor_id: null, appointment_iso: null,
                  callback_requested: true, callback_time: t?.iso ?? null, agent_reply: fastReply, end_call: !!t,
                };
                emit({ type: "chunk", text: fastReply });
                emit({ type: "final", result });
                controller.close();
                return;
              }

              const apiKey = process.env.LOVABLE_API_KEY;
              if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");

              // Inject the extracted timeline summary securely into systemic prompt scopes
              const rawSystemPrompt = playbook.buildSystemPrompt(pbCtx);
              const system = injectMemoryToSystemPrompt(rawSystemPrompt, effectiveMemory);

              const history = transcript.slice(-12);
              const transcriptText = history.map((t) => `${t.role === "agent" ? "Agent" : "Patient"}: ${t.text}`).join("\n");
              const userMsg = isFirstTurn
                ? `This is the OPENING of the call — the patient has just picked up and has not said anything yet.\nProduce a short, warm Hindi greeting that:\n- introduces yourself on behalf of ${clinic.name}\n- greets ${patient.name} by name\n- asks an open question about how they are feeling or any symptoms\nProduce the next agent turn as JSON. Set intent="unclear", end_call=false.`
                : `Conversation so far:\n${transcriptText}\n\nPatient just said: "${utterance}"\n\nProduce the next agent turn as JSON. Ensure your agent_reply is in Hindi. CRITICAL: Do NOT repeat what the patient just said as an acknowledgement. Be direct.`;

              const requestBody = {
                model: process.env.AGENT_TURN_MODEL ?? "google/gemini-2.5-flash-lite",
                messages: [
                  { role: "system", content: system },
                  { role: "user", content: userMsg },
                ],
                response_format: { type: "json_object" },
                stream: true,
                max_tokens: 2000,
              };

              const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
                method: "POST",
                headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
                body: JSON.stringify(requestBody),
              });
              if (!res.ok || !res.body) {
                const errText = await res.text().catch(() => "");
                throw new Error(`AI gateway error ${res.status}: ${errText.slice(0, 300)}`);
              }

              const extractor = new AgentReplyExtractor();
              const reader = res.body.getReader();
              const decoder = new TextDecoder();
              let textBuffer = "";
              let fullContent = "";
              let pendingDelta = "";

              const emitSentencesFromPending = () => {
                const re = /[।.?!,;:]\s|[।.?!,;:]$/;
                let m: RegExpExecArray | null;
                while ((m = re.exec(pendingDelta)) !== null) {
                  const end = (m.index ?? 0) + 1;
                  const sentence = pendingDelta.slice(0, end).trim();
                  pendingDelta = pendingDelta.slice(end).replace(/^\s+/, "");
                  if (!sentence) continue;
                  emit({ type: "chunk", text: sentence });
                }
              };

              const handleDelta = (deltaText: string) => {
                if (!deltaText) return;
                fullContent += deltaText;
                const { newText, closed } = extractor.push(deltaText);
                if (newText) {
                  pendingDelta += newText;
                  emitSentencesFromPending();
                }
                if (closed && pendingDelta.trim()) {
                  emit({ type: "chunk", text: pendingDelta.trim() });
                  pendingDelta = "";
                }
              };

              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                textBuffer += decoder.decode(value, { stream: true });
                let nlIdx: number;
                while ((nlIdx = textBuffer.indexOf("\n")) !== -1) {
                  let line = textBuffer.slice(0, nlIdx);
                  textBuffer = textBuffer.slice(nlIdx + 1);
                  if (line.endsWith("\r")) line = line.slice(0, -1);
                  const delta = parseSseLine(line);
                  if (delta != null) handleDelta(delta);
                }
              }
              if (textBuffer.trim()) {
                const delta = parseSseLine(textBuffer);
                if (delta != null) handleDelta(delta);
              }
              if (pendingDelta.trim()) {
                emit({ type: "chunk", text: pendingDelta.trim() });
                pendingDelta = "";
              }

              let raw: unknown;
              try { raw = JSON.parse(fullContent || "{}"); } catch { raw = {}; }
              let parsedOut: BaseAgentResult & Record<string, unknown>;
              try {
                parsedOut = playbook.outputSchema.parse(raw) as BaseAgentResult & Record<string, unknown>;
              } catch (zerr) {
                console.error(`[agent.turn-stream] schema parse failed: ${zerr instanceof Error ? zerr.message : zerr}`);
                parsedOut = {
                  intent: "unclear",
                  agent_reply: typeof (raw as { agent_reply?: unknown }).agent_reply === "string" ? ((raw as { agent_reply: string }).agent_reply) : "ठीक है।",
                  end_call: false, callback_requested: false, callback_time: null,
                } as BaseAgentResult & Record<string, unknown>;
              }

              if (typeof parsedOut.agent_reply === "string") {
                const before = parsedOut.agent_reply;
                const after = sanitizeAgentReply(before);
                if (after !== before) parsedOut.agent_reply = after;
              }
              if (kb && typeof parsedOut.suggested_doctor_id === "string") {
                const v = validateDoctorId(parsedOut.suggested_doctor_id, kb.doctorIds);
                if (!v.valid) parsedOut.suggested_doctor_id = null;
              }
              if (typeof parsedOut.agent_reply === "string") {
                const cfg = (playbookConfig ?? {}) as { address?: string; venue?: string };
                const cfgAddress = cfg.address || cfg.venue || "";
                const profileAddress = kb?.profile?.address ?? "";
                const safeAddress = cfgAddress || profileAddress;
                if (safeAddress) {
                  const safeReply = `यह ${clinic.name}, ${safeAddress} पर है।`;
                  const verdict = validateAgentAddress({
                    reply: parsedOut.agent_reply,
                    addressSources: [cfgAddress, profileAddress, cfg.venue, clinic.name],
                    safeReply,
                  });
                  if (!verdict.ok && playbookKey === "inbound_reception") {
                    parsedOut.agent_reply = verdict.replacement;
                  }
                }
              }
              if (typeof parsedOut.agent_reply === "string" && !parsedOut.end_call) {
                const lenCheck = enforceReplyLength(parsedOut.agent_reply);
                if (lenCheck.trimmed) parsedOut.agent_reply = lenCheck.reply;
              }

              const doctorKeyToId = kb ? buildDoctorKeyToId(kb.doctors) : undefined;
              const result = toAgentResult(parsedOut, doctorKeyToId);
              emit({ type: "final", result });
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              console.error(`[agent.turn-stream] error: ${msg}`);
              emit({ type: "error", message: msg });
            } {
              controller.close();
            }
          },
        });

        return new Response(stream, {
          status: 200,
          headers: {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      },
    },
  },
});