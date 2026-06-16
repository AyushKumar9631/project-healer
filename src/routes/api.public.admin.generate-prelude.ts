import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

// One-shot generator: synthesizes a short "नमस्ते," in μ-law 8kHz with the
// same ElevenLabs voice used by the bridge, then uploads it to the public
// `greetings` Supabase storage bucket as `namaste.ulaw`.
//
// Auth: protected by the existing BRIDGE_SHARED_SECRET header so it can be
// triggered manually with curl without exposing keys. Safe to leave deployed.
//
//   curl -X POST -H "x-bridge-secret: $BRIDGE_SHARED_SECRET" \
//        https://hospitalker-ai.lovable.app/api/public/admin/generate-prelude
//
// On success returns the public URL to set as HELLO_PRELUDE_URL on the bridge.

const VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? "Ms9OTvWb99V6DwRHZn6q";
const PRELUDE_TEXT = "नमस्ते,";
const BUCKET = "greetings";
const OBJECT_KEY = "namaste.ulaw";

export const Route = createFileRoute("/api/public/admin/generate-prelude")({
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

          // 1) Synthesize μ-law 8kHz audio.
          const ttsRes = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=ulaw_8000`,
            {
              method: "POST",
              headers: {
                "xi-api-key": elevenKey,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                text: PRELUDE_TEXT,
                model_id: "eleven_turbo_v2_5",
                voice_settings: {
                  stability: 0.55,
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

          // 2) Upload (upsert) to the `greetings` bucket.
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
            bytes: audioBuf.byteLength,
            duration_seconds_approx: audioBuf.byteLength / 8000,
            public_url: pub.publicUrl,
            next_step:
              "Set HELLO_PRELUDE_URL on the bridge to this public_url and restart the bridge process.",
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
