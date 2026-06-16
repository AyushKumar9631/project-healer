CREATE TABLE public.appointment_whatsapp_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  call_id UUID,
  phone TEXT,
  message_sid TEXT,
  status TEXT,
  error TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
GRANT ALL ON public.appointment_whatsapp_logs TO service_role;
ALTER TABLE public.appointment_whatsapp_logs ENABLE ROW LEVEL SECURITY;