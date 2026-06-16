// Browser-safe helpers for the Babies UI. Mirrors playbooks/vaccinationSchedule.ts
// but does not import server-only types.

export const IAP_SCHEDULE_PUBLIC = [
  { key: "birth", ageDays: 0,   vaccines: ["BCG", "OPV-0", "Hep-B-birth"] },
  { key: "6w",    ageDays: 42,  vaccines: ["OPV-1", "Penta-1", "Rotavirus-1", "fIPV-1", "PCV-1"] },
  { key: "10w",   ageDays: 70,  vaccines: ["OPV-2", "Penta-2", "Rotavirus-2", "PCV-2"] },
  { key: "14w",   ageDays: 98,  vaccines: ["OPV-3", "Penta-3", "Rotavirus-3", "fIPV-2", "PCV-3"] },
  { key: "9m",    ageDays: 270, vaccines: ["MR-1", "JE-1", "PCV-Booster", "Vit-A"] },
] as const;

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type SeedRowPublic = {
  age_milestone: string;
  vaccine_code: string;
  due_date: string;
  status: "due";
};

export function computeSeedRows(args: { clinicId: string; babyId: string; dob: string }) {
  const rows: Array<SeedRowPublic & { clinic_id: string; baby_id: string }> = [];
  for (const m of IAP_SCHEDULE_PUBLIC) {
    const due = addDays(args.dob, m.ageDays);
    for (const v of m.vaccines) {
      rows.push({
        clinic_id: args.clinicId,
        baby_id: args.babyId,
        age_milestone: m.key,
        vaccine_code: v,
        due_date: due,
        status: "due",
      });
    }
  }
  return rows;
}
