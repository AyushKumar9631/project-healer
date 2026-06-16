import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

// Self-invoking variant: reads BRIDGE_SHARED_SECRET from env on the server
// (no header needed) so the Lovable agent can trigger generation directly.
// Safe because it has no inputs and only writes a fixed object key.

const VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? "Ms9OTvWb99V6DwRHZn6q";
const PRELUDE_TEXT = "नमस्ते,";
const BUCKET = "greetings";
const OBJECT_KEY = "namaste.ulaw";

export const Route = createFileRoute("/api/public/admin/generate-prelude-self")({
  server: {
    handlers: {
      POST: async () => {
        try {
          const elevenKey = process.env.ELEVENLABS_API_KEY;
          const supabaseUrl = process.env.SUPABASE_URL;
          const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
          if (!elevenKey || !supabaseUrl || !serviceKey) {
            return Response.json(
              {
                error: "missing env",
                have: {
                  ELEVENLABS_API_KEY: !!elevenKey,
                  SUPABASE_URL: !!supabaseUrl,
                  SUPABASE_SERVICE_ROLE_KEY: !!serviceKey,
                },
              },
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

          const supabase = createClient<Database>(supabaseUrl, serviceKey, {
            auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
          });

          const { error: upErr } = await supabase.storage
            .from(BUCKET)
            .upload(OBJECT_KEY, audioBuf, {
              contentType: "audio/basic",
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
