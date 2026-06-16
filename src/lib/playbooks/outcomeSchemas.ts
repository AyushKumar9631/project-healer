// Per-use-case outcome column descriptors. Single source of truth for the
// Outcomes dashboard table and detail sheet so each playbook surfaces the
// fields that actually matter for it.

import type { PlaybookKey } from "./_base";

export type OutcomeFormat = "text" | "datetime" | "date" | "bool" | "list" | "badge";

export type OutcomeColumn = {
  key: string;        // path inside call_outcomes.structured
  label: string;
  format?: OutcomeFormat;
};

const CALL_STATUS_COLUMN: OutcomeColumn = {
  key: "call_status",
  label: "Call status",
  format: "badge",
};

export const OUTCOME_SCHEMAS: Record<PlaybookKey, OutcomeColumn[]> = {
  free_screening_invite: [
    CALL_STATUS_COLUMN,
    { key: "rsvp", label: "RSVP", format: "badge" },
    { key: "preferred_slot", label: "Preferred slot" },
    { key: "companion", label: "Companion" },
    { key: "reason_if_no", label: "Reason if no" },
    { key: "symptoms_mentioned", label: "Symptoms", format: "list" },
  ],
  free_screening_invite_existing: [
    CALL_STATUS_COLUMN,
    { key: "rsvp", label: "RSVP", format: "badge" },
    { key: "preferred_slot", label: "Preferred slot" },
    { key: "companion", label: "Companion" },
    { key: "reason_if_no", label: "Reason if no" },
    { key: "symptoms_mentioned", label: "Symptoms", format: "list" },
  ],
  screening_to_opd: [
    CALL_STATUS_COLUMN,
    { key: "intent", label: "Intent", format: "badge" },
    { key: "condition", label: "Condition" },
    { key: "doctor_name", label: "Doctor" },
    { key: "appointment_iso", label: "Appointment", format: "datetime" },
    { key: "symptoms_mentioned", label: "Symptoms", format: "list" },
  ],
  newborn_vaccination: [
    CALL_STATUS_COLUMN,
    { key: "baby_sentiment", label: "Baby sentiment", format: "badge" },
    { key: "intent_to_attend", label: "Will attend", format: "badge" },
    { key: "rescheduled_to", label: "Rescheduled to", format: "date" },
    { key: "baby_health_concern", label: "Concern" },
  ],
  inbound_reception: [
    CALL_STATUS_COLUMN,
    { key: "caller_intent", label: "Caller intent", format: "badge" },
    { key: "topic", label: "Topic" },
    { key: "appointment_iso", label: "Appointment", format: "datetime" },
    { key: "symptoms_mentioned", label: "Symptoms", format: "list" },
    { key: "resolved", label: "Resolved", format: "bool" },
  ],
};

export function getStructured(structured: unknown, key: string): unknown {
  if (!structured || typeof structured !== "object") return null;
  return (structured as Record<string, unknown>)[key];
}

export function formatCellText(value: unknown, format?: OutcomeFormat): string {
  if (value === null || value === undefined || value === "") return "—";
  switch (format) {
    case "datetime": {
      const s = String(value);
      let d = new Date(s);
      if (isNaN(d.getTime())) {
        // Repair Postgres-style `+00` (no colon) offset
        d = new Date(s.replace(/([+-]\d{2})$/, "$1:00"));
      }
      return isNaN(d.getTime()) ? "—" : d.toLocaleString();
    }
    case "date": {
      const s = String(value);
      let d = new Date(s);
      if (isNaN(d.getTime())) d = new Date(s.replace(/([+-]\d{2})$/, "$1:00"));
      return isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
    }
    case "bool":
      return value ? "Yes" : "No";
    case "list":
      return Array.isArray(value) && value.length ? value.join(", ") : "—";
    default:
      return String(value);
  }
}
