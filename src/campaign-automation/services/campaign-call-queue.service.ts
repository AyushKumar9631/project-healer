import type {
  CampaignCallQueueListFilters,
  CampaignCallQueueRow,
  CreateCampaignCallQueueItemInput,
  UpdateCampaignCallQueueItemInput,
} from "../types";
import { nowIso } from "../utils";

export interface CampaignCallQueueService {
  enqueueMany(items: CreateCampaignCallQueueItemInput[]): Promise<CampaignCallQueueRow[]>;
  list(filters?: CampaignCallQueueListFilters): Promise<CampaignCallQueueRow[]>;
  getById(id: string): Promise<CampaignCallQueueRow | null>;
  update(id: string, input: UpdateCampaignCallQueueItemInput): Promise<CampaignCallQueueRow | null>;
  countActive(campaignId?: string): Promise<number>;
}

export class InMemoryCampaignCallQueueService implements CampaignCallQueueService {
  private readonly rows = new Map<string, CampaignCallQueueRow>();

  async enqueueMany(items: CreateCampaignCallQueueItemInput[]): Promise<CampaignCallQueueRow[]> {
    const createdAt = nowIso();
    const rows = items.map((item, index) => {
      const row: CampaignCallQueueRow = {
        id: this.buildId(item, index),
        campaign_id: item.campaign_id,
        patient_id: item.patient_id,
        clinic_id: item.clinic_id,
        phone_number: item.phone_number,
        status: "pending",
        outcome: null,
        retry_count: 0,
        call_id: null,
        scheduled_at: item.scheduled_at ?? null,
        started_at: null,
        completed_at: null,
        last_error: null,
        created_at: createdAt,
        updated_at: createdAt,
      };
      this.rows.set(row.id, row);
      return row;
    });

    return rows;
  }

  async list(filters: CampaignCallQueueListFilters = {}): Promise<CampaignCallQueueRow[]> {
    const rows = Array.from(this.rows.values());

    return rows.filter((row) => {
      if (filters.campaign_id && row.campaign_id !== filters.campaign_id) return false;
      if (filters.status && row.status !== filters.status) return false;
      return true;
    });
  }

  async getById(id: string): Promise<CampaignCallQueueRow | null> {
    return this.rows.get(id) ?? null;
  }

  async update(
    id: string,
    input: UpdateCampaignCallQueueItemInput,
  ): Promise<CampaignCallQueueRow | null> {
    const existing = this.rows.get(id);
    if (!existing) return null;

    const updated: CampaignCallQueueRow = {
      ...existing,
      ...input,
      updated_at: nowIso(),
    };

    this.rows.set(id, updated);
    return updated;
  }

  async countActive(campaignId?: string): Promise<number> {
    const activeStatuses = new Set(["dialing", "in_progress"]);
    const rows = await this.list(campaignId ? { campaign_id: campaignId } : {});

    return rows.filter((row) => activeStatuses.has(row.status)).length;
  }

  private buildId(item: CreateCampaignCallQueueItemInput, index: number): string {
    return [
      "queue",
      item.campaign_id,
      item.patient_id,
      Date.now().toString(36),
      index.toString(36),
    ].join("_");
  }
}
