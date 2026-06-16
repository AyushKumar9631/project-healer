import type { CampaignCallQueueOutcome, CampaignCallQueueRow } from "../types";

export interface CampaignRetryPolicyConfig {
  maxRetries: number;
  retryDelaySeconds: number;
  retryableOutcomes: CampaignCallQueueOutcome[];
}

export interface CampaignRetryDecision {
  shouldRetry: boolean;
  reason: string;
  nextRetryCount: number;
}

export const DEFAULT_CAMPAIGN_RETRY_POLICY: CampaignRetryPolicyConfig = {
  maxRetries: 3,
  retryDelaySeconds: 300,
  retryableOutcomes: ["failed", "busy", "no_answer"],
};

export class CampaignRetryPolicy {
  constructor(
    private readonly config: CampaignRetryPolicyConfig = DEFAULT_CAMPAIGN_RETRY_POLICY,
  ) {}

  evaluate(row: CampaignCallQueueRow): CampaignRetryDecision {
    if (!row.outcome) {
      return {
        shouldRetry: false,
        reason: "queue item has no outcome",
        nextRetryCount: row.retry_count,
      };
    }

    if (!this.config.retryableOutcomes.includes(row.outcome)) {
      return {
        shouldRetry: false,
        reason: "outcome is not retryable",
        nextRetryCount: row.retry_count,
      };
    }

    if (row.retry_count >= this.config.maxRetries) {
      return {
        shouldRetry: false,
        reason: "max retries reached",
        nextRetryCount: row.retry_count,
      };
    }

    return {
      shouldRetry: true,
      reason: "eligible for retry",
      nextRetryCount: row.retry_count + 1,
    };
  }

  getRetryDelaySeconds(): number {
    return this.config.retryDelaySeconds;
  }
}
