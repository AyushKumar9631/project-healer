import Papa from "papaparse";

export interface ParsedPatient {
  name: string;
  phone: string;
  age: number | null;
  gender: string | null;
  health_camp: string | null;
  bp: string | null;
  blood_sugar: string | null;
  risk: string | null;
  _rowIndex: number;
  _errors: string[];
}

const FIELD_MAP: Record<string, keyof ParsedPatient> = {
  name: "name",
  "patient name": "name",
  "patient_name": "name",
  "full name": "name",
  "full_name": "name",
  phone: "phone",
  mobile: "phone",
  "phone number": "phone",
  "phone_number": "phone",
  age: "age",
  gender: "gender",
  sex: "gender",
  camp: "health_camp",
  "health camp": "health_camp",
  "health_camp": "health_camp",
  bp: "bp",
  "blood pressure": "bp",
  "blood sugar": "blood_sugar",
  "blood_sugar": "blood_sugar",
  sugar: "blood_sugar",
  glucose: "blood_sugar",
  risk: "risk",
};

const normalizeHeader = (k: string) =>
  k.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length === 13 && digits.startsWith("+91")) return digits;
  return null;
}

export function parseCsv(file: File): Promise<ParsedPatient[]> {
  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const rows = res.data.map((row, idx) => {
          const out: ParsedPatient = {
            name: "",
            phone: "",
            age: null,
            gender: null,
            health_camp: null,
            bp: null,
            blood_sugar: null,
            risk: null,
            _rowIndex: idx + 2,
            _errors: [],
          };
          for (const [k, v] of Object.entries(row)) {
            if (!v) continue;
            const key = normalizeHeader(k);
            const mapped = FIELD_MAP[key];
            if (mapped === "age") out.age = Number(v) || null;
            else if (mapped) (out as unknown as Record<string, unknown>)[mapped] = String(v).trim();
          }
          if (!out.name) out._errors.push("Missing name");
          const phone = normalizePhone(out.phone);
          if (!phone) out._errors.push("Invalid phone");
          else out.phone = phone;
          return out;
        });
        resolve(rows);
      },
      error: reject,
    });
  });
}
