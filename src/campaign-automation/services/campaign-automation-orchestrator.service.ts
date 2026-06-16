// Production orchestrator — `request` is now optional because the dispatcher
// no longer needs it (it calls the telephony provider in-process via the
// admin client).

import { CampaignAnalyticsService } from "../analytics";
import { CampaignRetryService } from "../retry";
import { CampaignScheduler, DEFAULT_CAMPAIGN_SCHEDULER_LIMITS } from "../scheduler";
import type { CampaignAutomationRuntimeConfig, CampaignDispatchResult } from "../types";
import type { CampaignCallQueueService } from "./campaign-call-queue.service";
import { CampaignCallDispatcherService } from "./campaign-call-dispatcher.service";
import { CampaignCallReconciliationService } from "./campaign-call-reconciliation.service";

export const DEFAULT_CAMPAIGN_AUTOMATION_RUNTIME_CONFIG: CampaignAutomationRuntimeConfig = {
  callsPerSecond: DEFAULT_CAMPAIGN_SCHEDULER_LIMITS.callsPerSecond,
  maxConcurrentCalls: DEFAULT_CAMPAIGN_SCHEDULER_LIMITS.maxConcurrentCalls,
  retryDelaySeconds: 300,
  maxRetries: 3,
};

export interface RunCampaignAutomationTickInput {
  request?: Request;
  campaignId: string;
}

export interface RunCampaignAutomationTickResult {
  reconciliationUpdated: number;
  retriesReleased: number;
  retriesScheduled: number;
  selectedCount: number;
  dispatchedCount: number;
  analytics: Awaited<ReturnType<CampaignAnalyticsService["getSnapshot"]>>;
  dispatchResults: CampaignDispatchResult[];
}

export class CampaignAutomationOrchestratorService {
  private readonly scheduler: CampaignScheduler;
  private readonly retryService: CampaignRetryService;
  private readonly analyticsService: CampaignAnalyticsService;
  private readonly dispatcher: CampaignCallDispatcherService;
  private readonly reconciliationService: CampaignCallReconciliationService;

  constructor(
    queueService: CampaignCallQueueService,
    config: CampaignAutomationRuntimeConfig = DEFAULT_CAMPAIGN_AUTOMATION_RUNTIME_CONFIG,
  ) {
    this.scheduler = new CampaignScheduler(queueService, {
      callsPerSecond: config.callsPerSecond,
      maxConcurrentCalls: config.maxConcurrentCalls,
    });
    this.retryService = new CampaignRetryService(queueService);
    this.analyticsService = new CampaignAnalyticsService(queueService);
    this.dispatcher = new CampaignCallDispatcherService(queueService);
    this.reconciliationService = new CampaignCallReconciliationService(queueService);
  }

  async runTick(input: RunCampaignAutomationTickInput): Promise<RunCampaignAutomationTickResult> {
    const reconciliation = await this.reconciliationService.reconcile({ campaignId: input.campaignId });
    const released = await this.retryService.releaseDueRetries({ campaignId: input.campaignId });
    const scheduled = await this.retryService.scheduleRetries();
    const tick = await this.scheduler.tick({ campaignId: input.campaignId });

    const dispatchResults: CampaignDispatchResult[] = [];
    for (const candidate of tick.selected) {
      dispatchResults.push(
        await this.dispatcher.dispatch({
          request: input.request,
          queueItemId: candidate.queueItemId,
          patientId: candidate.patientId,
          campaignId: candidate.campaignId,
        }),
      );
    }

    const analytics = await this.analyticsService.getSnapshot({ campaignId: input.campaignId });

    return {
      reconciliationUpdated: reconciliation.updatedCount,
      retriesReleased: released.releasedCount,
      retriesScheduled: scheduled.scheduledCount,
      selectedCount: tick.selected.length,
      dispatchedCount: dispatchResults.filter((item) => item.ok).length,
      analytics,
      dispatchResults,
    };
  }
}
