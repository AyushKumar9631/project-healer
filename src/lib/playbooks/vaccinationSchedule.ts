// IAP National Immunization Schedule (0–9 months) for v1.
// Editable via DB later; constant for now keeps the system prompt deterministic.

import type { AdminClient } from "./_base";

export type VaccineMilestone = {
  key: string;            // "birth" | "6w" | "10w" | "14w" | "9m"
  labelHindi: string;     // spoken label
  ageDays: number;        // days after DOB
  vaccines: string[];     // canonical codes
};

export const IAP_SCHEDULE: VaccineMilestone[] = [
  { key: "birth", labelHindi: "जन्म के समय",   ageDays: 0,   vaccines: ["BCG", "OPV-0", "Hep-B-birth"] },
  { key: "6w",    labelHindi: "छह हफ्ते",       ageDays: 42,  vaccines: ["OPV-1", "Penta-1", "Rotavirus-1", "fIPV-1", "PCV-1"] },
  { key: "10w",   labelHindi: "दस हफ्ते",       ageDays: 70,  vaccines: ["OPV-2", "Penta-2", "Rotavirus-2", "PCV-2"] },
  { key: "14w",   labelHindi: "चौदह हफ्ते",     ageDays: 98,  vaccines: ["OPV-3", "Penta-3", "Rotavirus-3", "fIPV-2", "PCV-3"] },
  { key: "9m",    labelHindi: "नौ महीने",       ageDays: 270, vaccines: ["MR-1", "JE-1", "PCV-Booster", "Vit-A"] },
];

export function milestoneLabel(key: string): string {
  return IAP_SCHEDULE.find((m) => m.key === key)?.labelHindi ?? key;
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type SeedRow = {
  age_milestone: string;
  vaccine_code: string;
  due_date: string;
};

export function computeDueDates(dob: string): SeedRow[] {
  const out: SeedRow[] = [];
  for (const m of IAP_SCHEDULE) {
    const due = addDays(dob, m.ageDays);
    for (const v of m.vaccines) {
      out.push({ age_milestone: m.key, vaccine_code: v, due_date: due });
    }
  }
  return out;
}

export async function seedDosesForBaby(
  supabase: AdminClient,
  args: { clinicId: string; babyId: string; dob: string },
): Promise<{ inserted: number }> {
  const rows = computeDueDates(args.dob).map((r) => ({
    clinic_id: args.clinicId,
    baby_id: args.babyId,
    ...r,
    status: "due" as const,
  }));
  // Use upsert on (baby_id, vaccine_code) so re-seeding is idempotent.
  const { error, count } = await supabase
    .from("vaccination_doses")
    .upsert(rows, { onConflict: "baby_id,vaccine_code", ignoreDuplicates: true, count: "exact" });
  if (error) throw new Error(`seedDosesForBaby: ${error.message}`);
  return { inserted: count ?? 0 };
}

// Hindi-friendly date like "मंगलवार 5 मई"
const HI_DAYS = ["रविवार","सोमवार","मंगलवार","बुधवार","गुरुवार","शुक्रवार","शनिवार"];
const HI_MONTHS = ["जनवरी","फरवरी","मार्च","अप्रैल","मई","जून","जुलाई","अगस्त","सितंबर","अक्टूबर","नवंबर","दिसंबर"];

export function formatDueDateHindi(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00+05:30");
  return `${HI_DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${HI_MONTHS[d.getUTCMonth()]}`;
}

export function formatDobHindi(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00+05:30");
  return `${d.getUTCDate()} ${HI_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
