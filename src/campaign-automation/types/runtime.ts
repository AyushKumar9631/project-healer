import type { CampaignCallQueueOutcome } from "./queue";

export interface CampaignAutomationRuntimeConfig {
  callsPerSecond: number;
  maxConcurrentCalls: number;
  retryDelaySeconds: number;
  maxRetries: number;
}

export interface CampaignDispatchResult {
  queueItemId: string;
  callId: string | null;
  provider: string | null;
  ok: boolean;
  phone: string | null;
  error?: string;
}

export interface CampaignCallTerminalState {
  status: "completed" | "failed" | "retry_scheduled";
  outcome: CampaignCallQueueOutcome | null;
  lastError: string | null;
  completedAt: string | null;
}
