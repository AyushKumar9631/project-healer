## Root cause

Inbound appointments ARE being upserted on the published deployment — verified in worker logs:

```
[2026-06-04T12:06:53Z] [upsertAppointment] OK callId=c34059d3… doctor=4cb6eb56…
[2026-06-04T12:04:01Z] [upsertAppointment] OK callId=ab770ae7… doctor=6236e686…
```

But **zero rows** in `appointment_whatsapp_logs` and **zero `[appointment-whatsapp]` log lines** for the same window, even though:
- `TWILIO_WHATSAPP_FROM` is set (confirmed in secrets).
- The call sites in `src/routes/api.public.agent.turn.ts` (~lines 704 and 1068) already invoke `sendAppointmentWhatsappAsync(...)` immediately after each `upsertAppointment(...)`.

The reason it never executes: it is invoked as **`void sendAppointmentWhatsappAsync(...)`** (fire-and-forget). The agent.turn handler then returns its JSON response, and on Cloudflare Workers / workerd **any Promise that is not awaited by the request handler is cancelled the moment the response is sent**. The helper never reaches the Twilio fetch or the log insert — which is exactly the pattern we observe (no `sent`, no `FAILED`, no `skipped` log line, no log row).

This is a Worker runtime behavior, not a Twilio / template / phone-number / playbook bug. The same code would work on a long-lived Node server, which is why the verification described in the original plan looked fine in isolation.

## Fix (minimal, surgical)

Switch the two invocations from fire-and-forget to **awaited** calls. The helper is already wrapped in a top-level `try/catch` and never rethrows, so awaiting it is safe — a Twilio outage / missing secret / bad phone still cannot break the call flow. The added latency is one Twilio REST POST + one Supabase insert (~300–600 ms) added to the turn that confirms an appointment, which is also the turn where `end_call=true` is being set, so the user already hears the goodbye line via TTS while this completes.

### Edits

1. **`src/routes/api.public.agent.turn.ts`** — two one-line changes:
   - Line ~704: `void sendAppointmentWhatsappAsync({...})` → `await sendAppointmentWhatsappAsync({...})`
   - Line ~1068: same change.
   No other logic touched. No new imports, no signature changes.

2. **`src/lib/appointment-whatsapp.server.ts`** — no behavioural change, only one log-line addition at the very top of the function to make future debugging trivial:
   ```ts
   console.log(`[appointment-whatsapp] invoked callId=${callId} patient=${patientId} doctor=${doctorId}`);
   ```
   This guarantees that even if the helper exits early (missing secret, missing phone, invalid ISO), we see *something* in the worker logs and can distinguish "never called" from "called and skipped".

### Not changing

- `src/lib/appointment-whatsapp.server.ts` body, schema, content SID, template variables, IST formatter, E.164 normaliser.
- `src/lib/twilio.ts` connector helper.
- `appointment_whatsapp_logs` table / RLS / grants.
- Any playbook (`inboundReception`, `screeningToOpd`, etc.).
- Bridge code (`lovable-twilio-bridge/`, `lovable-plivo-bridge/`) — it already routes through `/agent/turn`.
- Voice / SMS / recording paths — completely untouched.

## Why this can't regress the live system

- The helper's top-level `try/catch` swallows every error (Twilio HTTP failure, Supabase insert failure, missing field) and only `console.error`s. `await` therefore cannot throw into the `agent.turn` handler.
- The two call sites are the only places `upsertAppointment(...)` runs from agent code; both are reached only when `appointment_iso` + `suggested_doctor_id` are both present, so we never send WhatsApp without a real booking.
- If `TWILIO_WHATSAPP_FROM` is later cleared, the helper still returns immediately with `[appointment-whatsapp] skipped: no TWILIO_WHATSAPP_FROM` — call flow unaffected.

## Deploy / verification

1. After the edit lands, **publish** the project (the worker logs above are from the published deployment — preview-only changes will not affect real inbound calls).
2. Place an inbound test call, confirm an appointment (any doctor, any time).
3. Worker logs (published) should now show, in order, for the same `callId`:
   ```
   [upsertAppointment] OK callId=…
   [appointment-whatsapp] invoked callId=… patient=… doctor=…
   [appointment-whatsapp] sent sid=SM… status=queued to=whatsapp:+91…
   ```
4. `select * from appointment_whatsapp_logs order by created_at desc limit 5;` → new row with `status=queued|sent`, `message_sid=SM…`, `error=null`.
5. WhatsApp template `HX291620d3999f4b4a4dd271264de3bfb2` arrives on the patient's phone with the 5 variables (Patient, Doctor, Date, Time, Clinic).
6. Negative path: if Twilio rejects the number (e.g. patient not opted-in to template), log row appears with `status=error` and the call still completes normally.

## Out of scope (unchanged from previous plan)

- Retries / queueing of failed sends.
- Twilio `StatusCallback` webhook for delivery receipts.
- Patient opt-out UI.
- Dashboard surface for WhatsApp delivery status.
