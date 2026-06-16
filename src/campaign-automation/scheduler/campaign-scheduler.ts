import type { CampaignCallQueueService } from "../services";
import type { CampaignCallQueueRow } from "../types";

export interface CampaignSchedulerLimits {
  callsPerSecond: number;
  maxConcurrentCalls: number;
}

export interface CampaignSchedulerTickInput {
  campaignId?: string;
}

export interface CampaignSchedulerDispatchCandidate {
  queueItemId: string;
  campaignId: string;
  patientId: string;
  phoneNumber: string;
}

export interface CampaignSchedulerTickResult {
  activeCalls: number;
  availableConcurrency: number;
  availableDispatchSlots: number;
  eligiblePendingCount: number;
  selected: CampaignSchedulerDispatchCandidate[];
}

export const DEFAULT_CAMPAIGN_SCHEDULER_LIMITS: CampaignSchedulerLimits = {
  callsPerSecond: 2,
  maxConcurrentCalls: 50,
};

export class CampaignScheduler {
  constructor(
    private readonly queueService: CampaignCallQueueService,
    private readonly limits: CampaignSchedulerLimits = DEFAULT_CAMPAIGN_SCHEDULER_LIMITS,
  ) {}

  async tick(input: CampaignSchedulerTickInput = {}): Promise<CampaignSchedulerTickResult> {
    const activeCalls = await this.queueService.countActive(input.campaignId);
    const pending = await this.queueService.list({
      campaign_id: input.campaignId,
      status: "pending",
    });

    const eligiblePending = this.getEligiblePendingItems(pending);
    const availableConcurrency = Math.max(0, this.limits.maxConcurrentCalls - activeCalls);
    const availableDispatchSlots = Math.max(
      0,
      Math.min(this.limits.callsPerSecond, availableConcurrency),
    );
    const selected = eligiblePending
      .slice(0, availableDispatchSlots)
      .map((item) => this.toDispatchCandidate(item));

    return {
      activeCalls,
      availableConcurrency,
      availableDispatchSlots,
      eligiblePendingCount: eligiblePending.length,
      selected,
    };
  }

  private getEligiblePendingItems(rows: CampaignCallQueueRow[]): CampaignCallQueueRow[] {
    const now = Date.now();

    return rows
      .filter((row) => {
        if (!row.scheduled_at) return true;
        const scheduledAt = new Date(row.scheduled_at).getTime();
        if (Number.isNaN(scheduledAt)) return false;
        return scheduledAt <= now;
      })
      .sort((left, right) => {
        const leftScheduledAt = left.scheduled_at ? new Date(left.scheduled_at).getTime() : 0;
        const rightScheduledAt = right.scheduled_at ? new Date(right.scheduled_at).getTime() : 0;
        return leftScheduledAt - rightScheduledAt;
      });
  }

  private toDispatchCandidate(item: CampaignCallQueueRow): CampaignSchedulerDispatchCandidate {
    return {
      queueItemId: item.id,
      campaignId: item.campaign_id,
      patientId: item.patient_id,
      phoneNumber: item.phone_number,
    };
  }
}
