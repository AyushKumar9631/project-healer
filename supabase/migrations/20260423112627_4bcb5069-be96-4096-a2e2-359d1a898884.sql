ALTER TABLE public.calls
  ADD COLUMN callback_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN callback_time timestamptz NULL;