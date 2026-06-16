// src/lib/hmis-integration/types.ts

export interface StandardizedPatient {
  name: string;
  phone: string;
  age?: number | null;
  gender?: string | null;
  health_camp?: string | null;
  bp?: string | null;
  blood_sugar?: string | null;
  risk?: string | null;
}

export interface HMISConfig {
  clinicId: string;
  adapterType: "mysql" | "postgres" | "supabase";
  connectionString?: string;
  listName?: string;
  tableName?: string;
}
