INSERT INTO public.call_outcomes (call_id, clinic_id, playbook_key, structured, success, red_flag)
SELECT
  c.id,
  c.clinic_id,
  COALESCE(camp.use_case, 'screening_to_opd') AS playbook_key,
  jsonb_strip_nulls(jsonb_build_object(
    'intent', COALESCE(c.intent, c.status),
    'condition', CASE
      WHEN lower(coalesce(c.condition_mentioned,'')) IN ('no_symptoms','no symptoms','none','no','n/a','-','') THEN NULL
      ELSE c.condition_mentioned
    END,
    'appointment_iso', CASE
      WHEN c.appointment_time IS NOT NULL
      THEN to_char((c.appointment_time AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      ELSE NULL END,
    'doctor_name', d.name,
    'doctor_id', c.suggested_doctor_id,
    'callback_requested', NULLIF(c.callback_requested, false),
    'callback_time', c.callback_time
  )) AS structured,
  COALESCE(c.intent = 'interested' OR c.appointment_time IS NOT NULL, false) AS success,
  false AS red_flag
FROM public.calls c
LEFT JOIN public.campaigns camp ON camp.id = c.campaign_id
LEFT JOIN public.doctors d ON d.id = c.suggested_doctor_id
LEFT JOIN public.call_outcomes co ON co.call_id = c.id
WHERE co.call_id IS NULL
  AND c.status IN ('completed','busy','no_answer','failed','declined','voicemail');