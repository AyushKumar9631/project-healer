import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

// Lightweight transcript-append endpoint.
//
// Records patient utterances that the bridge intentionally does NOT reply to
// (e.g. arrived while a previous turn was still in-flight, or within the
// post-playout guard window). These commits are correctly skipped from the
// LLM loop to avoid two-voice overlap, but they ARE real patient speech and
// belong in calls.transcript so reviewers see the full conversation.
//
// Atomic read-modify-write with a one-shot retry. De-dupes if the previous
// entry has the same role+text within DEDUPE_MS (Scribe occasionally
// re-commits on reconnect).

const DEDUPE_MS = 3000;

const InputSchema = z.object({
  callId: z.string().uuid(),
  role: z.literal("patient"),
  text: z.string().min(1).max(2000),
  dropped_reason: z.enum(["turn_in_flight", "post_playout_guard"]),
});

type TranscriptEntry = {
  role: string;
  text: string;
  dropped_reason?: string;
  ts?: string;
};

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

export const Route = createFileRoute("/api/public/agent/transcript-append")({
  server: {
    handlers: {
      POST: async ({ request }) => {
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
            return Response.json({ error: "invalid json" }, { status: 400 });
          }

          const parsed = InputSchema.safeParse(body);
          if (!parsed.success) {
            return Response.json(
              { error: "invalid input", details: parsed.error.flatten() },
              { status: 400 },
            );
          }
          const { callId, role, text, dropped_reason } = parsed.data;
          const cleaned = text.trim();
          if (cleaned.length < 2) {
            return Response.json({ ok: true, skipped: "too_short" });
          }

          const supabase = buildAdminClient();

          for (let attempt = 1; attempt <= 2; attempt++) {
            const { data: row, error: readErr } = await supabase
              .from("calls")
              .select("id, transcript")
              .eq("id", callId)
              .maybeSingle();
            if (readErr) {
              console.error(`[transcript-append] read failed attempt=${attempt}: ${readErr.message}`);
              if (attempt === 2) return Response.json({ error: "read failed" }, { status: 500 });
              await new Promise((r) => setTimeout(r, 100));
              continue;
            }
            if (!row) {
              return Response.json({ error: "call not found" }, { status: 404 });
            }

            const transcript = (Array.isArray(row.transcript) ? row.transcript : []) as TranscriptEntry[];
            const last = transcript[transcript.length - 1];
            if (last && last.role === role && last.text === cleaned) {
              const lastTs = last.ts ? Date.parse(last.ts) : NaN;
              if (!Number.isFinite(lastTs) || Date.now() - lastTs < DEDUPE_MS) {
                console.log(`[transcript-append] dedupe skip callId=${callId} reason=${dropped_reason}`);
                return Response.json({ ok: true, skipped: "duplicate" });
              }
            }

            const newEntry: TranscriptEntry = {
              role,
              text: cleaned,
              dropped_reason,
              ts: new Date().toISOString(),
            };
            const next = [...transcript, newEntry];

            const { data: updated, error: writeErr } = await supabase
              .from("calls")
              .update({ transcript: next as never })
              .eq("id", callId)
              .select("id");
            if (writeErr) {
              console.error(`[transcript-append] write failed attempt=${attempt}: ${writeErr.message}`);
            } else if (updated && updated.length > 0) {
              console.log(`[transcript-append] appended callId=${callId} reason=${dropped_reason} text="${cleaned.slice(0, 60)}"`);
              return Response.json({ ok: true, appended: true });
            } else {
              console.error(`[transcript-append] no-op write attempt=${attempt} callId=${callId}`);
            }
            if (attempt === 1) await new Promise((r) => setTimeout(r, 100));
          }

          return Response.json({ error: "write failed after retry" }, { status: 500 });
        } catch (e) {
          console.error("[transcript-append] unhandled:", e instanceof Error ? e.message : e);
          return Response.json({ error: "internal error" }, { status: 500 });
        }
      },
    },
  },
});
