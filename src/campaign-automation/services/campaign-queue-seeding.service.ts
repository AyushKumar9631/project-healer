import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { CampaignCallQueueRow } from "../types";
import type { CampaignCallQueueService } from "./campaign-call-queue.service";

type PatientRow = {
  id: string;
  phone: string;
  clinic_id?: string;
  risk?: string | null;
};

type CampaignRow = {
  id: string;
  patient_list_id: string | null;
  clinic_id?: string;
};

export interface SeedCampaignQueueInput {
  campaignId: string;
  scheduledAt?: string | null;
  riskFilter?: string;
}

export interface SeedCampaignQueueResult {
  campaignId: string;
  patientCount: number;
  queuedCount: number;
  skippedCount: number;
  queueRows: CampaignCallQueueRow[];
}

export class CampaignQueueSeedingService {
  constructor(private readonly queueService: CampaignCallQueueService) {}

  async seed(input: SeedCampaignQueueInput): Promise<SeedCampaignQueueResult> {
    const { data: campaign, error: campaignError } = await supabaseAdmin
      .from("campaigns")
      .select("id,patient_list_id,clinic_id")
      .eq("id", input.campaignId)
      .maybeSingle();
    if (campaignError) throw campaignError;
    if (!campaign) throw new Error("Campaign not found");

    const patients = await this.loadPatientsForCampaign(campaign as CampaignRow);

    const existing = await this.queueService.list({ campaign_id: input.campaignId });
    const existingPatientIds = new Set(existing.map((row) => row.patient_id));

    // Create a map to easily look up a patient's risk level later
    const patientRiskMap = new Map(patients.map((p) => [p.id, p.risk?.toLowerCase()]));

    // --- STEP 1: QUEUE BRAND NEW PATIENTS ---
    let patientsToQueue = patients.filter(
      (patient) => patient.phone && !existingPatientIds.has(patient.id),
    );

    // Apply filter to NEW patients
    if (input.riskFilter && input.riskFilter !== "all") {
      patientsToQueue = patientsToQueue.filter(
        (p) => p.risk?.toLowerCase() === input.riskFilter?.toLowerCase(),
      );
    }

    const queueRows = await this.queueService.enqueueMany(
      patientsToQueue.map((patient) => ({
        campaign_id: input.campaignId,
        patient_id: patient.id,
        clinic_id: patient.clinic_id || (campaign as CampaignRow).clinic_id!,
        phone_number: patient.phone,
        scheduled_at: input.scheduledAt ?? null,
      })),
    );

    // --- STEP 2: REACTIVATE FAILED/MISSED PATIENTS ---
    let rowsToReactivate = existing.filter(
      (row) => row.status === "failed" || row.status === "retry_scheduled",
    );

    // Apply filter to REACTIVATED patients
    if (input.riskFilter && input.riskFilter !== "all") {
      rowsToReactivate = rowsToReactivate.filter((row) => {
        const risk = patientRiskMap.get(row.patient_id);
        return risk === input.riskFilter?.toLowerCase();
      });
    }

    for (const row of rowsToReactivate) {
      await this.queueService.update(row.id, {
        status: "pending",
        call_id: null,
        started_at: null,
        completed_at: null,
        last_error: null,
        scheduled_at: input.scheduledAt ?? null,
      });
    }

    return {
      campaignId: input.campaignId,
      patientCount: patients.length,
      queuedCount: queueRows.length + rowsToReactivate.length,
      skippedCount: existingPatientIds.size - rowsToReactivate.length,
      queueRows,
    };
  }

  private async loadPatientsForCampaign(campaign: CampaignRow): Promise<PatientRow[]> {
    if (campaign.patient_list_id) {
      const direct = await supabaseAdmin
        .from("patients")
        .select("id,phone,clinic_id,risk")
        .eq("patient_list_id", campaign.patient_list_id)
        .order("created_at", { ascending: true });

      if (!direct.error) return (direct.data ?? []) as PatientRow[];

      const missingPatientListColumn =
        typeof direct.error.message === "string" &&
        direct.error.message.toLowerCase().includes("patient_list_id");
      if (!missingPatientListColumn) throw direct.error;
    }

    const clinicId =
      campaign.clinic_id ?? (await this.resolveClinicIdFromPatientList(campaign.patient_list_id));
    if (!clinicId) throw new Error("Unable to resolve clinic for campaign patients");

    const fallback = await supabaseAdmin
      .from("patients")
      .select("id,phone,clinic_id,risk")
      .eq("clinic_id", clinicId)
      .order("created_at", { ascending: true });
    if (fallback.error) throw fallback.error;
    return (fallback.data ?? []) as PatientRow[];
  }

  private async resolveClinicIdFromPatientList(
    patientListId: string | null,
  ): Promise<string | null> {
    if (!patientListId) return null;
    const { data, error } = await supabaseAdmin
      .from("patient_lists")
      .select("clinic_id")
      .eq("id", patientListId)
      .maybeSingle();
    if (error) throw error;
    return (data as { clinic_id?: string } | null)?.clinic_id ?? null;
  }
}
