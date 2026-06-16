-- =========================================
-- Helper: timestamp updater
-- =========================================
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- =========================================
-- Clinics
-- =========================================
CREATE TABLE public.clinics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL UNIQUE,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.clinics ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_clinics_updated_at
BEFORE UPDATE ON public.clinics
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =========================================
-- Helper: get current user's clinic id (security definer to avoid recursion)
-- =========================================
CREATE OR REPLACE FUNCTION public.current_clinic_id()
RETURNS UUID
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM public.clinics WHERE owner_id = auth.uid() LIMIT 1;
$$;

-- Clinics policies
CREATE POLICY "Owners can view their clinic"
  ON public.clinics FOR SELECT
  USING (owner_id = auth.uid());

CREATE POLICY "Owners can update their clinic"
  ON public.clinics FOR UPDATE
  USING (owner_id = auth.uid());

CREATE POLICY "Owners can insert their clinic"
  ON public.clinics FOR INSERT
  WITH CHECK (owner_id = auth.uid());

-- =========================================
-- Auto-create clinic on signup
-- =========================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.clinics (owner_id, name, email, phone)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'clinic_name', 'My Clinic'),
    NEW.email,
    NEW.raw_user_meta_data->>'phone'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- =========================================
-- Doctors
-- =========================================
CREATE TABLE public.doctors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  specialization TEXT,
  super_specialization TEXT,
  qualifications TEXT,
  experience_years INTEGER DEFAULT 0,
  conditions TEXT[] NOT NULL DEFAULT '{}',
  languages TEXT[] NOT NULL DEFAULT '{}',
  availability TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_doctors_clinic ON public.doctors(clinic_id);
CREATE INDEX idx_doctors_conditions ON public.doctors USING GIN(conditions);

ALTER TABLE public.doctors ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_doctors_updated_at
BEFORE UPDATE ON public.doctors
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE POLICY "Clinic can view own doctors"
  ON public.doctors FOR SELECT
  USING (clinic_id = public.current_clinic_id());
CREATE POLICY "Clinic can insert own doctors"
  ON public.doctors FOR INSERT
  WITH CHECK (clinic_id = public.current_clinic_id());
CREATE POLICY "Clinic can update own doctors"
  ON public.doctors FOR UPDATE
  USING (clinic_id = public.current_clinic_id());
CREATE POLICY "Clinic can delete own doctors"
  ON public.doctors FOR DELETE
  USING (clinic_id = public.current_clinic_id());

-- =========================================
-- Patient lists
-- =========================================
CREATE TABLE public.patient_lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source TEXT,
  patient_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_patient_lists_clinic ON public.patient_lists(clinic_id);

ALTER TABLE public.patient_lists ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_patient_lists_updated_at
BEFORE UPDATE ON public.patient_lists
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE POLICY "Clinic can view own lists"
  ON public.patient_lists FOR SELECT USING (clinic_id = public.current_clinic_id());
CREATE POLICY "Clinic can insert own lists"
  ON public.patient_lists FOR INSERT WITH CHECK (clinic_id = public.current_clinic_id());
CREATE POLICY "Clinic can update own lists"
  ON public.patient_lists FOR UPDATE USING (clinic_id = public.current_clinic_id());
CREATE POLICY "Clinic can delete own lists"
  ON public.patient_lists FOR DELETE USING (clinic_id = public.current_clinic_id());

-- =========================================
-- Patients
-- =========================================
CREATE TABLE public.patients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  patient_list_id UUID REFERENCES public.patient_lists(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  age INTEGER,
  gender TEXT,
  health_camp TEXT,
  bp TEXT,
  blood_sugar TEXT,
  subjective_answers JSONB,
  risk TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_patients_clinic ON public.patients(clinic_id);
CREATE INDEX idx_patients_list ON public.patients(patient_list_id);

ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_patients_updated_at
BEFORE UPDATE ON public.patients
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE POLICY "Clinic can view own patients"
  ON public.patients FOR SELECT USING (clinic_id = public.current_clinic_id());
CREATE POLICY "Clinic can insert own patients"
  ON public.patients FOR INSERT WITH CHECK (clinic_id = public.current_clinic_id());
CREATE POLICY "Clinic can update own patients"
  ON public.patients FOR UPDATE USING (clinic_id = public.current_clinic_id());
CREATE POLICY "Clinic can delete own patients"
  ON public.patients FOR DELETE USING (clinic_id = public.current_clinic_id());

-- =========================================
-- Campaigns
-- =========================================
CREATE TABLE public.campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  patient_list_id UUID REFERENCES public.patient_lists(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  use_case TEXT NOT NULL DEFAULT 'screening_to_opd',
  status TEXT NOT NULL DEFAULT 'draft',
  total_patients INTEGER NOT NULL DEFAULT 0,
  completed_calls INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_campaigns_clinic ON public.campaigns(clinic_id);

ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_campaigns_updated_at
BEFORE UPDATE ON public.campaigns
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE POLICY "Clinic can view own campaigns"
  ON public.campaigns FOR SELECT USING (clinic_id = public.current_clinic_id());
CREATE POLICY "Clinic can insert own campaigns"
  ON public.campaigns FOR INSERT WITH CHECK (clinic_id = public.current_clinic_id());
CREATE POLICY "Clinic can update own campaigns"
  ON public.campaigns FOR UPDATE USING (clinic_id = public.current_clinic_id());
CREATE POLICY "Clinic can delete own campaigns"
  ON public.campaigns FOR DELETE USING (clinic_id = public.current_clinic_id());

-- =========================================
-- Calls
-- =========================================
CREATE TABLE public.calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES public.campaigns(id) ON DELETE SET NULL,
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  intent TEXT,
  condition_mentioned TEXT,
  suggested_doctor_id UUID REFERENCES public.doctors(id) ON DELETE SET NULL,
  appointment_time TIMESTAMPTZ,
  notes TEXT,
  transcript JSONB NOT NULL DEFAULT '[]',
  outcome JSONB,
  duration_seconds INTEGER DEFAULT 0,
  simulated BOOLEAN NOT NULL DEFAULT true,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_calls_clinic ON public.calls(clinic_id);
CREATE INDEX idx_calls_campaign ON public.calls(campaign_id);
CREATE INDEX idx_calls_patient ON public.calls(patient_id);

ALTER TABLE public.calls ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_calls_updated_at
BEFORE UPDATE ON public.calls
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE POLICY "Clinic can view own calls"
  ON public.calls FOR SELECT USING (clinic_id = public.current_clinic_id());
CREATE POLICY "Clinic can insert own calls"
  ON public.calls FOR INSERT WITH CHECK (clinic_id = public.current_clinic_id());
CREATE POLICY "Clinic can update own calls"
  ON public.calls FOR UPDATE USING (clinic_id = public.current_clinic_id());
CREATE POLICY "Clinic can delete own calls"
  ON public.calls FOR DELETE USING (clinic_id = public.current_clinic_id());

-- =========================================
-- Call events
-- =========================================
CREATE TABLE public.call_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id UUID NOT NULL REFERENCES public.calls(id) ON DELETE CASCADE,
  clinic_id UUID NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_call_events_call ON public.call_events(call_id);

ALTER TABLE public.call_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Clinic can view own call events"
  ON public.call_events FOR SELECT USING (clinic_id = public.current_clinic_id());
CREATE POLICY "Clinic can insert own call events"
  ON public.call_events FOR INSERT WITH CHECK (clinic_id = public.current_clinic_id());