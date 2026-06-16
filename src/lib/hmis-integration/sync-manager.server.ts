import { createClient } from "@supabase/supabase-js";
import { SupabaseAdapter } from "./adapters/supabase-adapter";
import { HMISConfig, StandardizedPatient } from "./types";
import { IHMISAdapter } from "./adapters/base-adapter";

// 1. Initialize the Admin client securely inside the server environment.
// This completely bypasses RLS to allow backend insertions.
const supabaseUrl =
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  import.meta.env?.VITE_SUPABASE_URL ||
  "";
const supabaseServiceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || import.meta.env?.SUPABASE_SERVICE_ROLE_KEY || "";

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// 2. The Registry
const adapterRegistry: Record<string, IHMISAdapter> = {
  supabase: new SupabaseAdapter(),
};

export class HMISSyncManager {
  async runSync(config: HMISConfig) {
    console.log(
      `[SyncManager] Starting sync for clinic ${config.clinicId} via ${config.adapterType}`,
    );

    const adapter = adapterRegistry[config.adapterType];
    if (!adapter) throw new Error(`Unsupported adapter type: ${config.adapterType}`);

    const patients = await adapter.fetchPatients(config);
    console.log(`[SyncManager] Extracted ${patients.length} patients.`);

    if (patients.length === 0) {
      return { success: true, message: "No patients found.", count: 0 };
    }

    const listName = config.listName || `HMIS Sync - ${new Date().toLocaleDateString()}`;

    const { data: listData, error: listError } = await supabaseAdmin
      .from("patient_lists")
      .insert({
        clinic_id: config.clinicId,
        name: listName,
        source: config.adapterType,
        patient_count: patients.length,
      })
      .select("id")
      .single();

    if (listError || !listData) {
      throw new Error(`Failed to create patient list: ${listError?.message}`);
    }

    const patientListId = listData.id;
    console.log(`[SyncManager] Created Patient List ID: ${patientListId}`);

    const rowsToInsert = patients.map((p) => ({
      clinic_id: config.clinicId,
      patient_list_id: patientListId,
      name: p.name,
      phone: p.phone,
      age: p.age || null,
      gender: p.gender || null,
      health_camp: p.health_camp || null,
      bp: p.bp || null,
      blood_sugar: p.blood_sugar || null,
      risk: p.risk || null,
    }));

    const BATCH_SIZE = 500;
    let totalInserted = 0;

    for (let i = 0; i < rowsToInsert.length; i += BATCH_SIZE) {
      const batch = rowsToInsert.slice(i, i + BATCH_SIZE);

      const { error: patientsError } = await supabaseAdmin.from("patients").insert(batch);

      if (patientsError) {
        // Rolls back the patient list creation if a batch fails to prevent orphaned records
        await supabaseAdmin.from("patient_lists").delete().eq("id", patientListId);
        throw new Error(`Failed to insert batch starting at index ${i}: ${patientsError.message}`);
      }

      totalInserted += batch.length;
      console.log(`[SyncManager] Synced ${totalInserted} / ${rowsToInsert.length} patients...`);
    }

    console.log(`[SyncManager] ✅ Successfully inserted all ${totalInserted} patients.`);

    return {
      success: true,
      patientListId: patientListId,
      count: totalInserted,
    };
  }
}
