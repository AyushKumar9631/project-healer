INSERT INTO public.call_outcomes (call_id, clinic_id, playbook_key, structured, success, red_flag, created_at)
SELECT
  c.id,
  c.clinic_id,
  COALESCE(ca.use_case, 'screening_to_opd') AS playbook_key,
  jsonb_strip_nulls(jsonb_build_object(
    'intent', c.intent,
    'condition', c.condition_mentioned,
    'appointment_iso', to_char(c.appointment_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SSOF'),
    'symptoms_mentioned', CASE
      WHEN c.condition_mentioned IS NULL OR c.condition_mentioned = '' THEN '[]'::jsonb
      ELSE to_jsonb(string_to_array(c.condition_mentioned, ', '))
    END,
    'callback_requested', c.callback_requested,
    'callback_time', c.callback_time
  )) AS structured,
  COALESCE(c.intent = 'interested', false) OR (c.appointment_time IS NOT NULL) AS success,
  false AS red_flag,
  COALESCE(c.ended_at, c.updated_at, c.created_at) AS created_at
FROM public.calls c
LEFT JOIN public.campaigns ca ON ca.id = c.campaign_id
WHERE c.status IN ('completed', 'voicemail', 'no_answer', 'busy', 'declined')
  AND NOT EXISTS (SELECT 1 FROM public.call_outcomes o WHERE o.call_id = c.id);