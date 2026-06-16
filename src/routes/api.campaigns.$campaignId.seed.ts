import { createFileRoute } from "@tanstack/react-router";
import { authenticateRequest } from "@/lib/calls.server";
import {
  CampaignQueueSeedingService,
  SupabaseCampaignCallQueueService,
} from "@/campaign-automation";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// 100% Correct pattern for modern TanStack Start Vite builds
export const Route = createFileRoute("/api/campaigns/$campaignId/seed")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { campaignId } = params;

        // Parse the risk filter sent from the frontend
        const body = await request.json().catch(() => ({}));
        const riskFilter = body.riskFilter;

        console.log(
          `[api.campaigns.seed] Starting seed for campaignId=${campaignId} with risk=${riskFilter}`,
        );

        let supabase;
        try {
          const auth = await authenticateRequest(request);
          supabase = auth.supabase;
        } catch (e) {
          if (e instanceof Response) return e;
          return json({ error: String(e) }, 500);
        }

        try {
          const { data: campaign, error: cErr } = await supabase
            .from("campaigns")
            .select("id")
            .eq("id", campaignId)
            .maybeSingle();

          if (cErr) return json({ error: cErr.message }, 500);
          if (!campaign) return json({ error: "Campaign not found or access denied" }, 404);

          const queueService = new SupabaseCampaignCallQueueService();
          const seedingService = new CampaignQueueSeedingService(queueService);

          // Pass the riskFilter into the seed method
          const result = await seedingService.seed({ campaignId, riskFilter });

          return json({ ok: true, ...result }, 200);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return json({ error: msg }, 500);
        }
      },
    },
  },
});
