export const CAMPAIGN_CALL_QUEUE_STATUSES = [
  "pending",
  "dialing",
  "in_progress",
  "completed",
  "failed",
  "retry_scheduled",
] as const;

export type CampaignCallQueueStatus = (typeof CAMPAIGN_CALL_QUEUE_STATUSES)[number];

export const CAMPAIGN_CALL_QUEUE_OUTCOMES = [
  "interested",
  "not_interested",
  "busy",
  "no_answer",
  "appointment_booked",
  "callback_requested",
  "failed",
] as const;

export type CampaignCallQueueOutcome = (typeof CAMPAIGN_CALL_QUEUE_OUTCOMES)[number];

export interface CampaignCallQueueRow {
  id: string;
  campaign_id: string;
  patient_id: string;
  phone_number: string;
  clinic_id: string;
  status: CampaignCallQueueStatus;
  outcome: CampaignCallQueueOutcome | null;
  retry_count: number;
  call_id: string | null;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateCampaignCallQueueItemInput {
  campaign_id: string;
  patient_id: string;
  phone_number: string;
  clinic_id: string;
  scheduled_at?: string | null;
}

export interface UpdateCampaignCallQueueItemInput {
  status?: CampaignCallQueueStatus;
  outcome?: CampaignCallQueueOutcome | null;
  retry_count?: number;
  call_id?: string | null;
  scheduled_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  last_error?: string | null;
}

export interface CampaignCallQueueListFilters {
  campaign_id?: string;
  status?: CampaignCallQueueStatus;
}
