import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import type {
  CampaignCallQueueListFilters,
  CampaignCallQueueRow,
  CreateCampaignCallQueueItemInput,
  UpdateCampaignCallQueueItemInput,
} from "../types";
import type { CampaignCallQueueService } from "./campaign-call-queue.service";

type QueueInsert = Database["public"]["Tables"]["campaign_call_queue"]["Insert"];
type QueueUpdate = Database["public"]["Tables"]["campaign_call_queue"]["Update"];

export class SupabaseCampaignCallQueueService implements CampaignCallQueueService {
  async enqueueMany(items: CreateCampaignCallQueueItemInput[]): Promise<CampaignCallQueueRow[]> {
    if (!items.length) return [];

    const payload: QueueInsert[] = items.map((item) => ({
      campaign_id: item.campaign_id,
      patient_id: item.patient_id,
      clinic_id: item.clinic_id,
      phone_number: item.phone_number,
      status: "pending",
      scheduled_at: item.scheduled_at ?? null,
    }));

    const { data, error } = await supabaseAdmin
      .from("campaign_call_queue")
      .insert(payload)
      .select("*");
    if (error) throw error;
    return (data ?? []) as CampaignCallQueueRow[];
  }

  async list(filters: CampaignCallQueueListFilters = {}): Promise<CampaignCallQueueRow[]> {
    let query = supabaseAdmin.from("campaign_call_queue").select("*");
    if (filters.campaign_id) query = query.eq("campaign_id", filters.campaign_id);
    if (filters.status) query = query.eq("status", filters.status);
    const { data, error } = await query.order("created_at", { ascending: true });
    if (error) throw error;
    return (data ?? []) as CampaignCallQueueRow[];
  }

  async getById(id: string): Promise<CampaignCallQueueRow | null> {
    const { data, error } = await supabaseAdmin
      .from("campaign_call_queue")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return (data as CampaignCallQueueRow | null) ?? null;
  }

  async update(
    id: string,
    input: UpdateCampaignCallQueueItemInput,
  ): Promise<CampaignCallQueueRow | null> {
    const payload: QueueUpdate = {
      ...input,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabaseAdmin
      .from("campaign_call_queue")
      .update(payload)
      .eq("id", id)
      .select("*")
      .maybeSingle();
    if (error) throw error;
    return (data as CampaignCallQueueRow | null) ?? null;
  }

  async countActive(campaignId?: string): Promise<number> {
    let query = supabaseAdmin
      .from("campaign_call_queue")
      .select("id", { count: "exact", head: true })
      .in("status", ["dialing", "in_progress"]);
    if (campaignId) query = query.eq("campaign_id", campaignId);
    const { count, error } = await query;
    if (error) throw error;
    return count ?? 0;
  }
}
