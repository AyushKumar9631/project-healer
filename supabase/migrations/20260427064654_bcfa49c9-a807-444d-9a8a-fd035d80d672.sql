ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS plivo_call_uuid TEXT;
CREATE INDEX IF NOT EXISTS idx_calls_provider ON public.calls(provider);