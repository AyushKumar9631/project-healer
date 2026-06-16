ALTER TABLE public.calls
  ADD COLUMN IF NOT EXISTS twilio_call_sid TEXT,
  ADD COLUMN IF NOT EXISTS phone_number TEXT,
  ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'outbound';

CREATE INDEX IF NOT EXISTS idx_calls_twilio_sid ON public.calls(twilio_call_sid);