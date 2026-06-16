import type { CampaignCallQueueService } from "../services";
import type {
  CampaignCallQueueOutcome,
  CampaignCallQueueRow,
  CampaignCallQueueStatus,
} from "../types";

export interface GetCampaignAnalyticsInput {
  campaignId?: string;
}

export interface CampaignAnalyticsSummary {
  total: number;
  pending: number;
  active: number;
  completed: number;
  failed: number;
  retryScheduled: number;
  processed: number;
  completionRate: number;
  retryCountTotal: number;
  retriedItemsCount: number;
}

export interface CampaignAnalyticsSnapshot {
  summary: CampaignAnalyticsSummary;
  byStatus: Record<CampaignCallQueueStatus, number>;
  byOutcome: Record<CampaignCallQueueOutcome, number>;
}

export class CampaignAnalyticsService {
  constructor(private readonly queueService: CampaignCallQueueService) {}

  async getSnapshot(
    input: GetCampaignAnalyticsInput = {},
  ): Promise<CampaignAnalyticsSnapshot> {
    const rows = await this.queueService.list(
      input.campaignId ? { campaign_id: input.campaignId } : {},
    );

    const byStatus = this.buildStatusBreakdown(rows);
    const byOutcome = this.buildOutcomeBreakdown(rows);
    const total = rows.length;
    const pending = byStatus.pending;
    const active = byStatus.dialing + byStatus.in_progress;
    const completed = byStatus.completed;
    const failed = byStatus.failed;
    const retryScheduled = byStatus.retry_scheduled;
    const processed = completed + failed;
    const retryCountTotal = rows.reduce((sum, row) => sum + row.retry_count, 0);
    const retriedItemsCount = rows.filter((row) => row.retry_count > 0).length;

    return {
      summary: {
        total,
        pending,
        active,
        completed,
        failed,
        retryScheduled,
        processed,
        completionRate: total > 0 ? Math.round((processed / total) * 100) : 0,
        retryCountTotal,
        retriedItemsCount,
      },
      byStatus,
      byOutcome,
    };
  }

  private buildStatusBreakdown(
    rows: CampaignCallQueueRow[],
  ): Record<CampaignCallQueueStatus, number> {
    const counts: Record<CampaignCallQueueStatus, number> = {
      pending: 0,
      dialing: 0,
      in_progress: 0,
      completed: 0,
      failed: 0,
      retry_scheduled: 0,
    };

    for (const row of rows) {
      counts[row.status] += 1;
    }

    return counts;
  }

  private buildOutcomeBreakdown(
    rows: CampaignCallQueueRow[],
  ): Record<CampaignCallQueueOutcome, number> {
    const counts: Record<CampaignCallQueueOutcome, number> = {
      interested: 0,
      not_interested: 0,
      busy: 0,
      no_answer: 0,
      appointment_booked: 0,
      callback_requested: 0,
      failed: 0,
    };

    for (const row of rows) {
      if (!row.outcome) continue;
      counts[row.outcome] += 1;
    }

    return counts;
  }
}
