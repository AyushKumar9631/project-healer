-- Fix screening_to_opd outcomes: repair appointment_iso ISO format and add doctor_name
-- 1. Reformat appointment_iso to proper ISO with Z suffix (UTC) where it's a string
UPDATE public.call_outcomes co
SET structured = jsonb_set(
  co.structured,
  '{appointment_iso}',
  to_jsonb(to_char((c.appointment_time AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
)
FROM public.calls c
WHERE co.call_id = c.id
  AND co.playbook_key = 'screening_to_opd'
  AND c.appointment_time IS NOT NULL;

-- 2. Backfill doctor_name from calls.suggested_doctor_id -> doctors.name
UPDATE public.call_outcomes co
SET structured = jsonb_set(
  co.structured,
  '{doctor_name}',
  to_jsonb(d.name)
)
FROM public.calls c
JOIN public.doctors d ON d.id = c.suggested_doctor_id
WHERE co.call_id = c.id
  AND co.playbook_key = 'screening_to_opd'
  AND c.suggested_doctor_id IS NOT NULL;

-- 3. Also store doctor_id for traceability
UPDATE public.call_outcomes co
SET structured = jsonb_set(
  co.structured,
  '{doctor_id}',
  to_jsonb(c.suggested_doctor_id::text)
)
FROM public.calls c
WHERE co.call_id = c.id
  AND co.playbook_key = 'screening_to_opd'
  AND c.suggested_doctor_id IS NOT NULL;