// Server functions for campaign lifecycle, callable from the React app via
// useServerFn() if you'd prefer that over the /api/campaigns/$campaignId/*
// routes. The existing UI uses the routes — this file is provided for parity
// and future call sites that want typed RPC.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  CampaignQueueSeedingService,
  CampaignRetryService,
  SupabaseCampaignCallQueueService,
} from "@/campaign-automation";

const StartInput = z.object({
  campaignId: z.string().uuid(),
  riskFilter: z.string().optional().default("all"),
});

export const startCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => StartInput.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    const { data: campaign, error: cErr } = await supabase
      .from("campaigns")
      .select("id")
      .eq("id", data.campaignId)
      .maybeSingle();
    if (cErr) throw new Error(cErr.message);
    if (!campaign) throw new Error("Campaign not found or access denied");

    const queueService = new SupabaseCampaignCallQueueService();
    const seeding = new CampaignQueueSeedingService(queueService);
    const retry = new CampaignRetryService(queueService);

    const seedResult = await seeding.seed({
      campaignId: data.campaignId,
      riskFilter: data.riskFilter,
    });
    await retry.releaseDueRetries({ campaignId: data.campaignId });

    const { error: upErr } = await supabase
      .from("campaigns")
      .update({
        status: "running",
        started_at: new Date().toISOString(),
        total_patients: seedResult.patientCount,
      })
      .eq("id", data.campaignId);
    if (upErr) throw new Error(upErr.message);

    return {
      ok: true,
      seeded: seedResult.queuedCount,
      totalPatients: seedResult.patientCount,
      skipped: seedResult.skippedCount,
    };
  });

const StopInput = z.object({ campaignId: z.string().uuid() });

export const stopCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => StopInput.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { error } = await supabase
      .from("campaigns")
      .update({ status: "stopped" })
      .eq("id", data.campaignId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
