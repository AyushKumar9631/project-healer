import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { resolvePlaybook } from "@/lib/playbooks/registry";
import type { PlaybookContext, PlaybookKey, GreetingSegments } from "@/lib/playbooks/_base";
import { recordCallTiming } from "@/lib/call-timings.server";

// Lightweight first-turn greeting endpoint.
// No LLM. Few DB roundtrips. Target latency < 400ms.
// Resolves the playbook from campaigns.use_case and dispatches.

const InputSchema = z.object({
  callId: z.string().uuid(),
});

function buildAdminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      `Supabase env missing: SUPABASE_URL=${url ? "set" : "MISSING"} SUPABASE_SERVICE_ROLE_KEY=${key ? "set" : "MISSING"}`,
    );
  }
  return createClient<Database>(url, key, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  });
}

function joinGreeting(seg: GreetingSegments): string {
  return [seg.s1, seg.s2, seg.s3].filter((s) => s && s.trim()).join(" ");
}

export const Route = createFileRoute("/api/public/agent/greeting")({
  server: {
    handlers: {
      // Warm-up GET: lets calls.server.ts JIT-compile this handler before
      // Twilio dials, so the first real POST is fast.
      GET: async ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("warm") === "1") {
          return Response.json({ ok: true, warm: true });
        }
        return new Response("method not allowed", { status: 405 });
      },
      POST: async ({ request }) => {
        const t0 = Date.now();
        try {
          const expected = process.env.BRIDGE_SHARED_SECRET;
          if (!expected) {
            return Response.json(
              { error: "BRIDGE_SHARED_SECRET not configured" },
              { status: 500 },
            );
          }
          const provided = request.headers.get("x-bridge-secret");
          if (!provided || provided !== expected) {
            return new Response("unauthorized", { status: 401 });
          }

          let body: unknown;
          try {
            body = await request.json();
          } catch {
            return Response.json({ error: "bad json body" }, { status: 400 });
          }

          const parsed = InputSchema.safeParse(body);
          if (!parsed.success) {
            return Response.json(
              { error: "invalid input", issues: parsed.error.flatten() },
              { status: 400 },
            );
          }
          const { callId } = parsed.data;

          const supabase = buildAdminClient();

          // Single round-trip: fetch the call, then patient + clinic in parallel.
          // (We need call.patient_id / call.clinic_id before the second pair,
          //  so this is the minimum serial chain — 2 RTTs total.)
          // Fetch call + campaign in one chain (need campaign_id to resolve playbook).
          const { data: call, error: callErr } = await supabase
            .from("calls")
            .select("id,clinic_id,patient_id,campaign_id,direction,provider")
            .eq("id", callId)
            .maybeSingle();
          if (callErr) {
            return Response.json({ error: callErr.message }, { status: 500 });
          }
          if (!call) {
            return Response.json({ error: "call not found" }, { status: 404 });
          }

          // Wave 2: ALL secondary lookups parallelised. campaign_playbook_config
          // and (for vaccination) baby were previously serial — now folded in.
          // baby is fetched only when patient_id is known (always true here).
          const [patientRes, clinicRes, campaignRes, cfgRes, babyRes] = await Promise.all([
            supabase
              .from("patients")
              .select("id,name,phone,age,gender,bp,blood_sugar,health_camp,risk")
              .eq("id", call.patient_id)
              .maybeSingle(),
            supabase
              .from("clinics")
              .select("id,name")
              .eq("id", call.clinic_id)
              .maybeSingle(),
            call.campaign_id
              ? supabase.from("campaigns").select("use_case").eq("id", call.campaign_id).maybeSingle()
              : Promise.resolve({ data: null, error: null }),
            call.campaign_id
              ? supabase
                  .from("campaign_playbook_config")
                  .select("config_json")
                  .eq("campaign_id", call.campaign_id)
                  .maybeSingle()
              : Promise.resolve({ data: null, error: null }),
            // Speculatively fetch baby in parallel — only used if useCase
            // resolves to newborn_vaccination. Wasted RTT for non-vacc calls
            // but keeps p50 down for vacc calls (saves 1 serial RTT).
            call.patient_id
              ? supabase
                  .from("babies")
                  .select("id,baby_name,parent_name,dob,gender")
                  .eq("patient_id", call.patient_id)
                  .order("created_at", { ascending: false })
                  .limit(1)
                  .maybeSingle()
              : Promise.resolve({ data: null, error: null }),
          ]);

          const patient = patientRes.data;
          const clinic = clinicRes.data;
          const isInbound = call.direction === "inbound";
          const useCase: PlaybookKey = isInbound
            ? "inbound_reception"
            : ((campaignRes.data?.use_case ?? "screening_to_opd") as PlaybookKey);

          const config: Record<string, unknown> =
            (cfgRes.data?.config_json as Record<string, unknown>) ?? {};
          let baby: PlaybookContext["baby"] = null;
          let dueDoses: PlaybookContext["dueDoses"] = [];
          if (useCase === "newborn_vaccination" && babyRes.data) {
            baby = babyRes.data;
            const dosesRes = await supabase
              .from("vaccination_doses")
              .select("id,age_milestone,vaccine_code,due_date")
              .eq("baby_id", baby.id)
              .eq("status", "due")
              .order("due_date", { ascending: true })
              .limit(10);
            dueDoses = (dosesRes.data ?? []) as PlaybookContext["dueDoses"];
          }

          const playbook = resolvePlaybook(useCase);
          const ctx: PlaybookContext = {
            callId,
            clinic: { id: clinic?.id ?? call.clinic_id, name: clinic?.name ?? "क्लिनिक" },
            patient: {
              id: patient?.id ?? call.patient_id,
              name: patient?.name ?? "",
              phone: patient?.phone ?? null,
              age: patient?.age ?? null,
              gender: patient?.gender ?? null,
              bp: patient?.bp ?? null,
              blood_sugar: patient?.blood_sugar ?? null,
              health_camp: patient?.health_camp ?? null,
              risk: patient?.risk ?? null,
            },
            campaignId: call.campaign_id,
            playbookKey: useCase,
            config,
            direction: (call.direction === "inbound" ? "inbound" : "outbound"),
            baby,
            dueDoses,
          };
          const segments = playbook.buildGreeting(ctx);
          const greeting = joinGreeting(segments);

          // CRITICAL PATH: only the transcript update needs to land before
          // we respond — otherwise the next /agent/turn LLM call will see an
          // empty history and re-introduce itself ("agent repeats greeting"
          // bug). Everything else (call_events, server-side timing row) is
          // diagnostic and runs in the background.
          const tPersistStart = Date.now();
          try {
            await supabase
              .from("calls")
              .update({
                status: "in_progress",
                started_at: new Date().toISOString(),
                transcript: [{ role: "agent", text: greeting }],
              })
              .eq("id", callId);
          } catch (dbErr) {
            console.error(
              `[agent.greeting] transcript persist failed (non-fatal): ${dbErr instanceof Error ? dbErr.message : dbErr}`,
            );
          }
          const persistMs = Date.now() - tPersistStart;

          // Fire-and-forget diagnostics. Errors logged, never block response.
          void (async () => {
            try {
              await Promise.all([
                supabase.from("call_events").insert({
                  call_id: callId,
                  clinic_id: call.clinic_id,
                  event_type: "agent_greeting",
                  payload: { agent_reply: greeting, ms: Date.now() - t0 },
                }),
                recordCallTiming({
                  call_id: callId,
                  clinic_id: call.clinic_id,
                  direction: call.direction === "inbound" ? "inbound" : "outbound",
                  provider: call.provider === "twilio" ? "twilio" : "plivo",
                  phase: "greeting_fetch_server",
                  t_offset_ms: 0,
                  duration_ms: Date.now() - t0,
                  detail: {
                    source: "server",
                    playbook: useCase,
                    reply_len: greeting.length,
                    persist_ms: persistMs,
                  },
                }),
              ]);
            } catch (dbErr) {
              console.error(
                `[agent.greeting] bg diagnostics failed (non-fatal): ${dbErr instanceof Error ? dbErr.message : dbErr}`,
              );
            }
          })();
          console.log(
            `[agent.greeting] callId=${callId} ms=${Date.now() - t0} reply="${greeting.slice(0, 80)}"`,
          );

          // Inbound-only ringback hint: bridges play ~2s of ring before the
          // prelude when this is true, so the caller hears something instead
          // of dead air. Outbound calls (any other playbook) keep the
          // existing prelude → greeting flow unchanged.
          const playRing = useCase === "inbound_reception";

          return Response.json({
            agent_reply: greeting,
            greeting_segments: [segments.s1, segments.s2, segments.s3],
            end_call: false,
            play_ring: playRing,
            // Bridges use this to gate /agent/turn-stream + speculative LLM:
            // those paths only support `screening_to_opd`. For any other
            // playbook the bridge MUST fall back to /agent/turn so the
            // playbook prompt actually runs (otherwise patients hear
            // screening_to_opd audio while transcript shows the right
            // playbook reply — see incident screenshot 2026-05-03).
            use_case: useCase,
          });
        } catch (e) {
          console.error("[agent.greeting] uncaught:", e);
          return Response.json(
            { error: e instanceof Error ? e.message : String(e) },
            { status: 500 },
          );
        }
      },
    },
  },
});
