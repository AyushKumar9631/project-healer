ALTER TABLE public.doctors
  ADD COLUMN IF NOT EXISTS consultation_fee numeric,
  ADD COLUMN IF NOT EXISTS patients_treated integer,
  ADD COLUMN IF NOT EXISTS online_consultation boolean NOT NULL DEFAULT false;