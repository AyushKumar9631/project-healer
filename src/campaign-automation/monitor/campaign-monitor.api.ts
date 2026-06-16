import type { CampaignAnalyticsService, CampaignAnalyticsSnapshot } from "../analytics";
import type { CampaignCallQueueService } from "../services";
import type { CampaignCallQueueRow, CampaignCallQueueStatus } from "../types";

export interface GetCampaignMonitorSnapshotInput {
  campaignId: string;
}

export interface ListCampaignMonitorQueueItemsInput {
  campaignId: string;
  status?: CampaignCallQueueStatus;
}

export interface GetCampaignMonitorLiveViewInput {
  campaignId: string;
  status?: CampaignCallQueueStatus;
}

export interface CampaignMonitorLiveView {
  analytics: CampaignAnalyticsSnapshot;
  queueItems: CampaignCallQueueRow[];
}

export class CampaignMonitorApi {
  constructor(
    private readonly queueService: CampaignCallQueueService,
    private readonly analyticsService: CampaignAnalyticsService,
  ) {}

  async getSnapshot(
    input: GetCampaignMonitorSnapshotInput,
  ): Promise<CampaignAnalyticsSnapshot> {
    return this.analyticsService.getSnapshot({ campaignId: input.campaignId });
  }

  async listQueueItems(
    input: ListCampaignMonitorQueueItemsInput,
  ): Promise<CampaignCallQueueRow[]> {
    const rows = await this.queueService.list({
      campaign_id: input.campaignId,
      status: input.status,
    });

    return rows.sort((left, right) => {
      const leftTime = new Date(left.updated_at).getTime();
      const rightTime = new Date(right.updated_at).getTime();
      return rightTime - leftTime;
    });
  }

  async getLiveView(
    input: GetCampaignMonitorLiveViewInput,
  ): Promise<CampaignMonitorLiveView> {
    const [analytics, queueItems] = await Promise.all([
      this.getSnapshot({ campaignId: input.campaignId }),
      this.listQueueItems({
        campaignId: input.campaignId,
        status: input.status,
      }),
    ]);

    return {
      analytics,
      queueItems,
    };
  }
}
