ALTER TABLE public.calls
  ADD COLUMN IF NOT EXISTS recording_url text,
  ADD COLUMN IF NOT EXISTS recording_id text,
  ADD COLUMN IF NOT EXISTS recording_duration_seconds integer,
  ADD COLUMN IF NOT EXISTS recording_ready_at timestamptz;