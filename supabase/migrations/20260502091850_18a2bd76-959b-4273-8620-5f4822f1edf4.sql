CREATE TABLE public.call_timings (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  call_id uuid NOT NULL,
  clinic_id uuid NOT NULL,
  direction text NOT NULL,
  provider text NOT NULL,
  phase text NOT NULL,
  t_offset_ms integer NOT NULL,
  duration_ms integer,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_call_timings_call_id ON public.call_timings (call_id, t_offset_ms);
CREATE INDEX idx_call_timings_clinic_recent ON public.call_timings (clinic_id, occurred_at DESC);
CREATE INDEX idx_call_timings_phase ON public.call_timings (phase);

ALTER TABLE public.call_timings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Clinic can view own call timings"
  ON public.call_timings FOR SELECT
  USING (clinic_id = current_clinic_id());

CREATE POLICY "Clinic can insert own call timings"
  ON public.call_timings FOR INSERT
  WITH CHECK (clinic_id = current_clinic_id());

CREATE POLICY "Clinic can update own call timings"
  ON public.call_timings FOR UPDATE
  USING (clinic_id = current_clinic_id());

CREATE POLICY "Clinic can delete own call timings"
  ON public.call_timings FOR DELETE
  USING (clinic_id = current_clinic_id());