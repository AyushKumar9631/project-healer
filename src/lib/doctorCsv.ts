import Papa from "papaparse";

export interface ParsedDoctor {
  name: string;
  specialization: string | null;
  super_specialization: string | null;
  qualifications: string | null;
  experience_years: number;
  conditions: string[];
  languages: string[];
  availability: string | null;
  consultation_fee: number | null;
  patients_treated: number | null;
  online_consultation: boolean;
  _rowIndex: number;
  _errors: string[];
}

const HEADER_MAP: Record<string, keyof ParsedDoctor> = {
  name: "name",
  "doctor name": "name",
  specialization: "specialization",
  speciality: "specialization",
  specialty: "specialization",
  "super specialization": "super_specialization",
  "super_specialization": "super_specialization",
  qualifications: "qualifications",
  qualification: "qualifications",
  "experience years": "experience_years",
  "experience_years": "experience_years",
  experience: "experience_years",
  conditions: "conditions",
  "conditions treated": "conditions",
  languages: "languages",
  availability: "availability",
  timings: "availability",
  "consultation fee": "consultation_fee",
  "consultation_fee": "consultation_fee",
  fee: "consultation_fee",
  "patients treated": "patients_treated",
  "patients_treated": "patients_treated",
  "online consultation": "online_consultation",
  "online_consultation": "online_consultation",
  online: "online_consultation",
};

const normHeader = (k: string) =>
  k.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");

const splitList = (raw: string): string[] => {
  if (!raw) return [];
  const sep = raw.includes("|") ? "|" : raw.includes(";") ? ";" : ",";
  return raw.split(sep).map((s) => s.trim()).filter(Boolean);
};

const parseBool = (raw: string): boolean => {
  const v = raw.trim().toLowerCase();
  return v === "yes" || v === "y" || v === "true" || v === "1";
};

const parseNum = (raw: string): number | null => {
  if (!raw || !raw.trim()) return null;
  const n = Number(raw.replace(/[,₹\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

export function parseDoctorCsv(file: File): Promise<ParsedDoctor[]> {
  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const rows = res.data.map((row, idx) => {
          const out: ParsedDoctor = {
            name: "",
            specialization: null,
            super_specialization: null,
            qualifications: null,
            experience_years: 0,
            conditions: [],
            languages: [],
            availability: null,
            consultation_fee: null,
            patients_treated: null,
            online_consultation: false,
            _rowIndex: idx + 2,
            _errors: [],
          };
          for (const [k, v] of Object.entries(row)) {
            if (v == null) continue;
            const mapped = HEADER_MAP[normHeader(k)];
            if (!mapped) continue;
            const val = String(v).trim();
            if (!val) continue;
            switch (mapped) {
              case "name":
              case "specialization":
              case "super_specialization":
              case "qualifications":
              case "availability":
                (out as unknown as Record<string, unknown>)[mapped] = val;
                break;
              case "experience_years": {
                const n = parseNum(val);
                if (n == null) out._errors.push("Invalid experience_years");
                else out.experience_years = Math.floor(n);
                break;
              }
              case "consultation_fee":
                out.consultation_fee = parseNum(val);
                break;
              case "patients_treated": {
                const n = parseNum(val);
                out.patients_treated = n == null ? null : Math.floor(n);
                break;
              }
              case "conditions":
                out.conditions = splitList(val);
                break;
              case "languages":
                out.languages = splitList(val);
                break;
              case "online_consultation":
                out.online_consultation = parseBool(val);
                break;
            }
          }
          if (!out.name) out._errors.push("Missing name");
          return out;
        });
        resolve(rows);
      },
      error: reject,
    });
  });
}
