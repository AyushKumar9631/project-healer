// Authenticated proxy for Plivo recording playback. Plivo recording URLs
// (https://api.plivo.com/v1/Account/<id>/Recording/<rid>/) require Basic
// auth, so the browser cannot play them directly. We look up the recording
// URL on the call (RLS-scoped to the user's clinic), fetch it server-side
// with PLIVO_AUTH_ID:PLIVO_AUTH_TOKEN, and stream the bytes back as
// audio/mpeg.
import { createFileRoute } from "@tanstack/react-router";
import { authenticateRequest } from "@/lib/calls.server";

export const Route = createFileRoute("/api/calls/recording")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        let supabase;
        try {
          ({ supabase } = await authenticateRequest(request));
        } catch (e) {
          if (e instanceof Response) return e;
          return new Response("auth failed", { status: 500 });
        }

        const url = new URL(request.url);
        const callId = url.searchParams.get("callId");
        if (!callId) return new Response("missing callId", { status: 400 });

        const { data: call, error } = await supabase
          .from("calls")
          .select("id,recording_url")
          .eq("id", callId)
          .maybeSingle();
        if (error) return new Response(error.message, { status: 500 });
        if (!call?.recording_url) return new Response("no recording", { status: 404 });

        const id = process.env.PLIVO_AUTH_ID;
        const token = process.env.PLIVO_AUTH_TOKEN;
        if (!id || !token) return new Response("plivo not configured", { status: 500 });

        const auth = "Basic " + Buffer.from(`${id}:${token}`).toString("base64");
        const upstream = await fetch(call.recording_url, {
          headers: { Authorization: auth },
        });
        if (!upstream.ok || !upstream.body) {
          return new Response(`upstream ${upstream.status}`, { status: 502 });
        }

        const headers = new Headers();
        headers.set(
          "Content-Type",
          upstream.headers.get("content-type") ?? "audio/mpeg",
        );
        const len = upstream.headers.get("content-length");
        if (len) headers.set("Content-Length", len);
        headers.set("Content-Disposition", `inline; filename="call-${callId}.mp3"`);
        headers.set("Cache-Control", "private, max-age=300");

        return new Response(upstream.body, { status: 200, headers });
      },
    },
  },
});
