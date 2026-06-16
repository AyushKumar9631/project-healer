import { createFileRoute } from "@tanstack/react-router";

const DEFAULT_VOICE_ID = "Ms9OTvWb99V6DwRHZn6q"; // Matilda — warm female, multilingual works well for Hindi

export const Route = createFileRoute("/api/elevenlabs/tts")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = process.env.ELEVENLABS_API_KEY;
        if (!apiKey) {
          return new Response(JSON.stringify({ error: "ELEVENLABS_API_KEY not configured" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        let body: { text?: string; voiceId?: string };
        try {
          body = await request.json();
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const text = (body.text ?? "").toString().trim();
        if (!text) {
          return new Response(JSON.stringify({ error: "Missing text" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (text.length > 4000) {
          return new Response(JSON.stringify({ error: "Text too long" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const voiceId = body.voiceId || DEFAULT_VOICE_ID;

        const elevenRes = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
          {
            method: "POST",
            headers: {
              "xi-api-key": apiKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              text,
              model_id: "eleven_multilingual_v2",
              voice_settings: {
                stability: 0.55,
                similarity_boost: 0.8,
                style: 0.3,
                use_speaker_boost: true,
                speed: 1.0,
              },
            }),
          },
        );

        if (!elevenRes.ok) {
          const errText = await elevenRes.text();
          return new Response(JSON.stringify({ error: errText || "TTS failed" }), {
            status: elevenRes.status,
            headers: { "Content-Type": "application/json" },
          });
        }

        const audio = await elevenRes.arrayBuffer();
        return new Response(audio, {
          status: 200,
          headers: {
            "Content-Type": "audio/mpeg",
            "Cache-Control": "no-store",
          },
        });
      },
    },
  },
});
