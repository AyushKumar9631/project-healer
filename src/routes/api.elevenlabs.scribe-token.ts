import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/elevenlabs/scribe-token")({
  server: {
    handlers: {
      POST: async () => {
        const apiKey = process.env.ELEVENLABS_API_KEY;
        if (!apiKey) {
          return new Response(JSON.stringify({ error: "ELEVENLABS_API_KEY not configured" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
        const r = await fetch("https://api.elevenlabs.io/v1/single-use-token/realtime_scribe", {
          method: "POST",
          headers: { "xi-api-key": apiKey },
        });
        if (!r.ok) {
          const text = await r.text();
          return new Response(JSON.stringify({ error: text || "Token request failed" }), {
            status: r.status,
            headers: { "Content-Type": "application/json" },
          });
        }
        const data = (await r.json()) as { token: string };
        return Response.json({ token: data.token });
      },
    },
  },
});
