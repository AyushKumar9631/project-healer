
-- 1. campaign_playbook_config
create table public.campaign_playbook_config (
  campaign_id  uuid primary key references public.campaigns(id) on delete cascade,
  clinic_id    uuid not null,
  playbook_key text not null,
  config_json  jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.campaign_playbook_config enable row level security;
create policy "Clinic can view own playbook config" on public.campaign_playbook_config
  for select using (clinic_id = current_clinic_id());
create policy "Clinic can insert own playbook config" on public.campaign_playbook_config
  for insert with check (clinic_id = current_clinic_id());
create policy "Clinic can update own playbook config" on public.campaign_playbook_config
  for update using (clinic_id = current_clinic_id());
create policy "Clinic can delete own playbook config" on public.campaign_playbook_config
  for delete using (clinic_id = current_clinic_id());
create trigger trg_cpc_updated_at before update on public.campaign_playbook_config
  for each row execute function public.update_updated_at_column();

-- 2. call_outcomes
create table public.call_outcomes (
  call_id          uuid primary key references public.calls(id) on delete cascade,
  clinic_id        uuid not null,
  playbook_key     text not null,
  structured       jsonb not null default '{}'::jsonb,
  config_snapshot  jsonb,
  red_flag         boolean not null default false,
  success          boolean not null default false,
  created_at       timestamptz not null default now()
);
alter table public.call_outcomes enable row level security;
create policy "Clinic can view own call outcomes" on public.call_outcomes
  for select using (clinic_id = current_clinic_id());
create policy "Clinic can insert own call outcomes" on public.call_outcomes
  for insert with check (clinic_id = current_clinic_id());
create policy "Clinic can update own call outcomes" on public.call_outcomes
  for update using (clinic_id = current_clinic_id());
create policy "Clinic can delete own call outcomes" on public.call_outcomes
  for delete using (clinic_id = current_clinic_id());

-- 3. babies
create table public.babies (
  id            uuid primary key default gen_random_uuid(),
  clinic_id     uuid not null,
  patient_id    uuid not null references public.patients(id) on delete cascade,
  parent_name   text not null,
  baby_name     text not null,
  dob           date not null,
  gender        text,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table public.babies enable row level security;
create policy "Clinic can view own babies" on public.babies
  for select using (clinic_id = current_clinic_id());
create policy "Clinic can insert own babies" on public.babies
  for insert with check (clinic_id = current_clinic_id());
create policy "Clinic can update own babies" on public.babies
  for update using (clinic_id = current_clinic_id());
create policy "Clinic can delete own babies" on public.babies
  for delete using (clinic_id = current_clinic_id());
create trigger trg_babies_updated_at before update on public.babies
  for each row execute function public.update_updated_at_column();
create index idx_babies_clinic on public.babies(clinic_id);
create index idx_babies_patient on public.babies(patient_id);

-- 4. vaccination_doses
create table public.vaccination_doses (
  id              uuid primary key default gen_random_uuid(),
  clinic_id       uuid not null,
  baby_id         uuid not null references public.babies(id) on delete cascade,
  age_milestone   text not null,
  vaccine_code    text not null,
  due_date        date not null,
  status          text not null default 'due',
  reminded_count  int not null default 0,
  last_call_id    uuid,
  done_at         timestamptz,
  rescheduled_to  date,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (baby_id, vaccine_code)
);
alter table public.vaccination_doses enable row level security;
create policy "Clinic can view own doses" on public.vaccination_doses
  for select using (clinic_id = current_clinic_id());
create policy "Clinic can insert own doses" on public.vaccination_doses
  for insert with check (clinic_id = current_clinic_id());
create policy "Clinic can update own doses" on public.vaccination_doses
  for update using (clinic_id = current_clinic_id());
create policy "Clinic can delete own doses" on public.vaccination_doses
  for delete using (clinic_id = current_clinic_id());
create trigger trg_doses_updated_at before update on public.vaccination_doses
  for each row execute function public.update_updated_at_column();
create index idx_doses_clinic_due on public.vaccination_doses(clinic_id, status, due_date);
create index idx_doses_baby on public.vaccination_doses(baby_id);
