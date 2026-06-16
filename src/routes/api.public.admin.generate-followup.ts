import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { FOLLOWUP_BP_GLUCOSE } from "@/lib/agent-canonical";

// One-shot generator: synthesizes the canonical post-consent follow-up
// ("क्या उसके बाद आपने BP और Glucose की जाँच दोबारा करवाई है? अब आप कैसे हैं?")
// in μ-law 8kHz with the same ElevenLabs voice and settings as the bridge,
// then uploads it to the public `greetings` Supabase Storage bucket.
//
// The bridge fetches the resulting URL once at boot (FOLLOWUP_PRELUDE_URL)
// and plays the cached bytes whenever the agent endpoint returns this exact
// reply — eliminating the TTS round-trip on the most latency-sensitive turn.
//
//   curl -X POST -H "x-bridge-secret: $BRIDGE_SHARED_SECRET" \
//        https://hospitalker-ai.lovable.app/api/public/admin/generate-followup
//
// Voice settings MUST match lovable-twilio-bridge/plivo.ts PLIVO_VOICE_SETTINGS
// so the cached clip blends seamlessly with live TTS.

const VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? "Ms9OTvWb99V6DwRHZn6q";
const TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL ?? "eleven_turbo_v2_5";
const BUCKET = "greetings";
const OBJECT_KEY = "followup_bp_glucose.ulaw";

export const Route = createFileRoute("/api/public/admin/generate-followup")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const expected = process.env.BRIDGE_SHARED_SECRET;
          if (!expected) {
            return Response.json({ error: "BRIDGE_SHARED_SECRET not set" }, { status: 500 });
          }
          if (request.headers.get("x-bridge-secret") !== expected) {
            return new Response("unauthorized", { status: 401 });
          }

          const elevenKey = process.env.ELEVENLABS_API_KEY;
          const supabaseUrl = process.env.SUPABASE_URL;
          const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
          if (!elevenKey || !supabaseUrl || !serviceKey) {
            return Response.json(
              { error: "ELEVENLABS_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing" },
              { status: 500 },
            );
          }

          const ttsRes = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=ulaw_8000`,
            {
              method: "POST",
              headers: {
                "xi-api-key": elevenKey,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                text: FOLLOWUP_BP_GLUCOSE,
                model_id: TTS_MODEL,
                // MUST stay in sync with PLIVO_VOICE_SETTINGS in plivo.ts
                voice_settings: {
                  stability: 0.45,
                  similarity_boost: 0.8,
                  style: 0.3,
                  use_speaker_boost: true,
                },
              }),
            },
          );
          if (!ttsRes.ok) {
            const body = await ttsRes.text();
            return Response.json(
              { error: `TTS failed: ${ttsRes.status}`, body: body.slice(0, 400) },
              { status: 500 },
            );
          }
          const audioBuf = new Uint8Array(await ttsRes.arrayBuffer());

          const supabase = createClient<Database>(supabaseUrl, serviceKey, {
            auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
          });

          const { error: upErr } = await supabase.storage
            .from(BUCKET)
            .upload(OBJECT_KEY, audioBuf, {
              contentType: "audio/basic", // μ-law
              upsert: true,
              cacheControl: "31536000",
            });
          if (upErr) {
            return Response.json({ error: `upload failed: ${upErr.message}` }, { status: 500 });
          }

          const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(OBJECT_KEY);

          return Response.json({
            ok: true,
            text: FOLLOWUP_BP_GLUCOSE,
            bytes: audioBuf.byteLength,
            duration_seconds_approx: audioBuf.byteLength / 8000,
            public_url: pub.publicUrl,
            next_step:
              "Set FOLLOWUP_PRELUDE_URL on the bridge to this public_url and restart the bridge process.",
          });
        } catch (e) {
          return Response.json(
            { error: e instanceof Error ? e.message : String(e) },
            { status: 500 },
          );
        }
      },
    },
  },
});
