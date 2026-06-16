// src/lib/hmis-integration/adapters/supabase-adapter.ts
import { createClient } from "@supabase/supabase-js";
import { IHMISAdapter } from "./base-adapter";
import { StandardizedPatient, HMISConfig } from "../types";

export class SupabaseAdapter implements IHMISAdapter {
  async fetchPatients(config: HMISConfig): Promise<StandardizedPatient[]> {
    if (!config.connectionString) {
      throw new Error("Supabase connection string is required (Format: 'URL|ANON_KEY')");
    }

    // We split the single connection string into the URL and Key
    const parts = config.connectionString.split("|");
    if (parts.length !== 2) {
      throw new Error("Invalid Supabase connection string. Must be 'URL|ANON_KEY'");
    }

    const [hospitalUrl, hospitalAnonKey] = parts;

    console.log(`[SupabaseAdapter] Connecting to external HMIS at ${hospitalUrl}`);

    // Create a fresh client pointing specifically to the HOSPITAL'S database
    const externalSupabase = createClient(hospitalUrl, hospitalAnonKey);

    try {
      // Query the hospital's patient table.
      const targetTable = config.tableName || "patients";

      let allRawData: any[] = [];
      let keepFetching = true;
      let page = 0;
      const PAGE_SIZE = 1000;

      while (keepFetching) {
        const from = page * PAGE_SIZE;
        const to = from + PAGE_SIZE - 1;

        console.log(`[SupabaseAdapter] Fetching rows ${from} to ${to}...`);

        const { data: rawData, error } = await externalSupabase
          .from(targetTable)
          .select("*")
          .range(from, to);

        if (error) {
          throw new Error(`External Supabase query failed: ${error.message}`);
        }

        if (!rawData || rawData.length === 0) {
          keepFetching = false;
        } else {
          allRawData = [...allRawData, ...rawData];

          // If we received fewer records than the limit, we've hit the end of the table
          if (rawData.length < PAGE_SIZE) {
            keepFetching = false;
          } else {
            page++;
          }
        }
      }

      if (allRawData.length === 0) {
        console.log(`[SupabaseAdapter] No patients found in external database.`);
        return [];
      }

      console.log(`[SupabaseAdapter] Extracted a total of ${allRawData.length} rows from HMIS.`);

      // Map their chaotic columns to your strict standard schema
      return allRawData.map((row: any) => ({
        // Map names (handle various ways hospitals might name this column)
        name: row.full_name || row.patient_name || row.name || "Unknown",

        // Map phone and strip non-numeric characters (ensure +91 is present if Indian)
        phone:
          row.contact_number || row.phone || row.mobile
            ? `+91${String(row.contact_number || row.phone || row.mobile)
                .replace(/\D/g, "")
                .slice(-10)}`
            : "No Phone",

        // Map remaining optional fields if they exist
        age: parseInt(row.age) || null,
        gender: row.gender || row.sex || null,
        bp: row.blood_pressure || row.bp || null,
        blood_sugar: row.blood_sugar || row.sugar_level || null,
        health_camp: row.health_camp || row.camp_name || null,
        risk: row.risk_level || row.risk || null,
      }));
    } catch (err: any) {
      console.error("[SupabaseAdapter] Extraction Error:", err.message);
      throw err;
    }
  }
}
