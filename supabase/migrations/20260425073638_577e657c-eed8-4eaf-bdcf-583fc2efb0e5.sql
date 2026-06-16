
-- 1. Clinic profile (one row per clinic)
CREATE TABLE public.clinic_profile (
  clinic_id UUID PRIMARY KEY,
  about TEXT,
  address TEXT,
  timings TEXT,
  emergency_phone TEXT,
  departments TEXT[] NOT NULL DEFAULT '{}',
  accreditations TEXT[] NOT NULL DEFAULT '{}',
  extra_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.clinic_profile ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Clinic can view own profile" ON public.clinic_profile
  FOR SELECT USING (clinic_id = current_clinic_id());
CREATE POLICY "Clinic can insert own profile" ON public.clinic_profile
  FOR INSERT WITH CHECK (clinic_id = current_clinic_id());
CREATE POLICY "Clinic can update own profile" ON public.clinic_profile
  FOR UPDATE USING (clinic_id = current_clinic_id());
CREATE POLICY "Clinic can delete own profile" ON public.clinic_profile
  FOR DELETE USING (clinic_id = current_clinic_id());

CREATE TRIGGER trg_clinic_profile_updated_at
  BEFORE UPDATE ON public.clinic_profile
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. Services & pricing
CREATE TABLE public.kb_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  description TEXT,
  price_min NUMERIC,
  price_max NUMERIC,
  currency TEXT NOT NULL DEFAULT 'INR',
  duration_minutes INT,
  prep_notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.kb_services ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Clinic can view own services" ON public.kb_services
  FOR SELECT USING (clinic_id = current_clinic_id());
CREATE POLICY "Clinic can insert own services" ON public.kb_services
  FOR INSERT WITH CHECK (clinic_id = current_clinic_id());
CREATE POLICY "Clinic can update own services" ON public.kb_services
  FOR UPDATE USING (clinic_id = current_clinic_id());
CREATE POLICY "Clinic can delete own services" ON public.kb_services
  FOR DELETE USING (clinic_id = current_clinic_id());

CREATE INDEX idx_kb_services_clinic ON public.kb_services(clinic_id) WHERE is_active;

CREATE TRIGGER trg_kb_services_updated_at
  BEFORE UPDATE ON public.kb_services
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3. FAQs
CREATE TABLE public.kb_faqs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.kb_faqs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Clinic can view own faqs" ON public.kb_faqs
  FOR SELECT USING (clinic_id = current_clinic_id());
CREATE POLICY "Clinic can insert own faqs" ON public.kb_faqs
  FOR INSERT WITH CHECK (clinic_id = current_clinic_id());
CREATE POLICY "Clinic can update own faqs" ON public.kb_faqs
  FOR UPDATE USING (clinic_id = current_clinic_id());
CREATE POLICY "Clinic can delete own faqs" ON public.kb_faqs
  FOR DELETE USING (clinic_id = current_clinic_id());

CREATE INDEX idx_kb_faqs_clinic ON public.kb_faqs(clinic_id) WHERE is_active;

CREATE TRIGGER trg_kb_faqs_updated_at
  BEFORE UPDATE ON public.kb_faqs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 4. Policies (agent rules)
CREATE TABLE public.kb_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL,
  title TEXT NOT NULL,
  rule TEXT NOT NULL,
  priority INT NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.kb_policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Clinic can view own policies" ON public.kb_policies
  FOR SELECT USING (clinic_id = current_clinic_id());
CREATE POLICY "Clinic can insert own policies" ON public.kb_policies
  FOR INSERT WITH CHECK (clinic_id = current_clinic_id());
CREATE POLICY "Clinic can update own policies" ON public.kb_policies
  FOR UPDATE USING (clinic_id = current_clinic_id());
CREATE POLICY "Clinic can delete own policies" ON public.kb_policies
  FOR DELETE USING (clinic_id = current_clinic_id());

CREATE INDEX idx_kb_policies_clinic ON public.kb_policies(clinic_id, priority) WHERE is_active;

CREATE TRIGGER trg_kb_policies_updated_at
  BEFORE UPDATE ON public.kb_policies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
