// Stop a running campaign — DB-driven, replaces the in-memory static stopSignals
// approach which didn't survive Worker isolates. The pg_cron tick skips any
// campaign whose status is not 'running'; in-flight calls drain naturally.

import { createFileRoute } from "@tanstack/react-router";
import { authenticateRequest } from "@/lib/calls.server";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/campaigns/$campaignId/stop")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { campaignId } = params;

        let supabase;
        try {
          ({ supabase } = await authenticateRequest(request));
        } catch (e) {
          if (e instanceof Response) return e;
          return json({ error: String(e) }, 500);
        }

        const { data, error } = await supabase
          .from("campaigns")
          .update({ status: "stopped" })
          .eq("id", campaignId)
          .select("id,status")
          .maybeSingle();

        if (error) {
          console.error(`[api.campaigns.stop] campaign=${campaignId} update failed:`, error.message);
          return json({ error: error.message }, 500);
        }
        if (!data) {
          return json({ error: "Campaign not found or access denied" }, 404);
        }

        console.log(`[api.campaigns.stop] campaign=${campaignId} status=stopped`);
        return json({ ok: true, campaignId, status: data.status });
      },
    },
  },
});
