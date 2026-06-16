import type { CampaignCallQueueService } from "../services";

export class CampaignRetryService {
  constructor(private readonly queueService: CampaignCallQueueService) {}

  async scheduleRetries() {
    return { checkedCount: 0, scheduledCount: 0, scheduledQueueItemIds: [] };
  }

  async releaseDueRetries(input: { campaignId?: string } = {}) {
    // DISABLED AUTOMATIC RETRIES.
    // Calls will sit safely as "failed" or "retry_scheduled".
    // They will only be dialed again when you manually click "Start Campaign".
    return {
      checkedCount: 0,
      releasedCount: 0,
      releasedQueueItemIds: [],
    };
  }
}
