// Server-only helper: send a WhatsApp confirmation after an appointment is
// upserted. Fire-and-forget — wrapped in try/catch and never rethrows, so a
// Twilio outage / bad config can never affect the live call flow.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { twilioPost } from "./twilio";

const CONTENT_SID = "HX291620d3999f4b4a4dd271264de3bfb2";
// Denial template SID — must be a real approved Twilio Content Template SID.
// To create one: Twilio Console → Messaging → Content Template Builder.
// Suggested template body: "नमस्ते {{1}}, आपने जो समय चुना वह उपलब्ध नहीं है।
// कृपया {{2}} में दोबारा कॉल करके नया समय तय करें। धन्यवाद।"
// Once approved, paste the HX... SID below and remove the env-var fallback.
const DENIAL_CONTENT_SID = process.env.TWILIO_DENIAL_CONTENT_SID ?? "";

type AdminClient = SupabaseClient<Database>;

function fmtIST(iso: string): { date: string; time: string } | null {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const date = `${ist.getUTCDate()} ${months[ist.getUTCMonth()]} ${ist.getUTCFullYear()}`;
  let h = ist.getUTCHours();
  const m = ist.getUTCMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  const time = `${h}:${String(m).padStart(2, "0")} ${ampm}`;
  return { date, time };
}

function toE164India(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.startsWith("91") && digits.length === 12) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  return `+${digits}`;
}

export async function sendAppointmentWhatsappAsync(args: {
  supabase: AdminClient;
  callId: string;
  clinicId: string;
  patientId: string;
  doctorId: string;
  appointmentIso: string;
}): Promise<void> {
  const { supabase, callId, clinicId, patientId, doctorId, appointmentIso } = args;
  console.log(`[appointment-whatsapp] invoked callId=${callId} patient=${patientId} doctor=${doctorId}`);
  try {
    const fromRaw = process.env.TWILIO_WHATSAPP_FROM;
    if (!fromRaw) {
      console.log("[appointment-whatsapp] skipped: no TWILIO_WHATSAPP_FROM");
      return;
    }

    const dt = fmtIST(appointmentIso);
    if (!dt) {
      console.warn(`[appointment-whatsapp] skipped: invalid appointmentIso="${appointmentIso}"`);
      return;
    }

    const [patientRes, doctorRes, clinicRes] = await Promise.all([
      supabase.from("patients").select("name, phone").eq("id", patientId).maybeSingle(),
      supabase.from("doctors").select("name").eq("id", doctorId).maybeSingle(),
      supabase.from("clinics").select("name").eq("id", clinicId).maybeSingle(),
    ]);

    const patient = patientRes.data;
    const doctor = doctorRes.data;
    const clinic = clinicRes.data;

    if (!patient?.phone) {
      console.log(`[appointment-whatsapp] skipped: no phone for patient=${patientId}`);
      return;
    }

    const toE164 = toE164India(patient.phone);
    const from = `whatsapp:${toE164India(fromRaw)}`;
    const to = `whatsapp:${toE164}`;
    const contentVariables = {
      "1": patient.name || "Patient",
      "2": doctor?.name ? `Dr. ${doctor.name}` : "Doctor",
      "3": dt.date,
      "4": dt.time,
      "5": clinic?.name || "Clinic",
    };

    let messageSid: string | null = null;
    let status: string | null = null;
    let errorMsg: string | null = null;
    try {
      const resp = (await twilioPost("/Messages.json", {
        From: from,
        To: to,
        ContentSid: CONTENT_SID,
        ContentVariables: JSON.stringify(contentVariables),
      })) as { sid?: string; status?: string };
      messageSid = resp.sid ?? null;
      status = resp.status ?? null;
      console.log(`[appointment-whatsapp] sent sid=${messageSid} status=${status} to=${to}`);
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
      console.error(`[appointment-whatsapp] send FAILED to=${to}: ${errorMsg}`);
    }

    try {
      await supabase.from("appointment_whatsapp_logs").insert({
        call_id: callId,
        phone: toE164,
        message_sid: messageSid,
        status: status ?? (errorMsg ? "error" : null),
        error: errorMsg,
      });
    } catch (e) {
      console.error(`[appointment-whatsapp] log insert failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  } catch (e) {
    console.error(`[appointment-whatsapp] unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// sendDenialWhatsappAsync — sent when a booked appointment_iso is rejected
// server-side (past time or invalid slot). Informs the patient the time they
// requested is not available and they should call again to reschedule.
// Fire-and-forget — same pattern as sendAppointmentWhatsappAsync.
export async function sendDenialWhatsappAsync(args: {
  supabase: AdminClient;
  callId: string;
  clinicId: string;
  patientId: string;
}): Promise<void> {
  const { supabase, callId, clinicId, patientId } = args;
  console.log(`[appointment-whatsapp] denial invoked callId=${callId} patient=${patientId}`);
  try {
    const fromRaw = process.env.TWILIO_WHATSAPP_FROM;
    if (!fromRaw) {
      console.log("[appointment-whatsapp] denial skipped: no TWILIO_WHATSAPP_FROM");
      return;
    }

    const [patientRes, clinicRes] = await Promise.all([
      supabase.from("patients").select("name, phone").eq("id", patientId).maybeSingle(),
      supabase.from("clinics").select("name").eq("id", clinicId).maybeSingle(),
    ]);

    const patient = patientRes.data;
    const clinic = clinicRes.data;

    if (!patient?.phone) {
      console.log(`[appointment-whatsapp] denial skipped: no phone for patient=${patientId}`);
      return;
    }

    const toE164 = toE164India(patient.phone);
    const from = `whatsapp:${toE164India(fromRaw)}`;
    const to = `whatsapp:${toE164}`;

    if (!DENIAL_CONTENT_SID) {
      console.error(
        "[appointment-whatsapp] denial skipped: TWILIO_DENIAL_CONTENT_SID env var is not set. " +
        "Create a WhatsApp Content Template in Twilio Console and set this env var to its HX... SID.",
      );
      return;
    }

    const patientName = patient.name || "Patient";
    const clinicName = clinic?.name || "Clinic";
    const contentVariables = {
      "1": patientName,
      "2": clinicName,
    };

    let messageSid: string | null = null;
    let status: string | null = null;
    let errorMsg: string | null = null;
    try {
      const resp = (await twilioPost("/Messages.json", {
        From: from,
        To: to,
        ContentSid: DENIAL_CONTENT_SID,
        ContentVariables: JSON.stringify(contentVariables),
      })) as { sid?: string; status?: string };
      messageSid = resp.sid ?? null;
      status = resp.status ?? null;
      console.log(`[appointment-whatsapp] denial sent sid=${messageSid} status=${status} to=${to}`);
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
      console.error(`[appointment-whatsapp] denial send FAILED to=${to}: ${errorMsg}`);
    }

    try {
      await supabase.from("appointment_whatsapp_logs").insert({
        call_id: callId,
        phone: toE164,
        message_sid: messageSid,
        status: status ?? (errorMsg ? "error" : null),
        error: errorMsg,
      });
    } catch (e) {
      console.error(`[appointment-whatsapp] denial log insert failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  } catch (e) {
    console.error(`[appointment-whatsapp] denial unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
