-- Campaign Call Queue — production-safe schema.
-- Replaces the branch's 20260526093000_add_campaign_call_queue.sql which referenced
-- a non-existent public.profiles table for RLS and omitted clinic_id + GRANTs.

create table if not exists public.campaign_call_queue (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  patient_id uuid not null references public.patients(id) on delete cascade,
  clinic_id uuid not null,
  phone_number text not null,
  status text not null default 'pending'
    check (status in ('pending','dialing','in_progress','completed','failed','retry_scheduled')),
  outcome text null
    check (outcome in ('interested','not_interested','busy','no_answer','appointment_booked','callback_requested','failed')),
  retry_count integer not null default 0,
  call_id uuid null references public.calls(id) on delete set null,
  scheduled_at timestamptz null,
  started_at timestamptz null,
  completed_at timestamptz null,
  last_error text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists campaign_call_queue_campaign_id_idx
  on public.campaign_call_queue (campaign_id);
create index if not exists campaign_call_queue_status_idx
  on public.campaign_call_queue (status);
create index if not exists campaign_call_queue_scheduled_at_idx
  on public.campaign_call_queue (scheduled_at);
create index if not exists campaign_call_queue_campaign_status_idx
  on public.campaign_call_queue (campaign_id, status);
create index if not exists campaign_call_queue_clinic_id_idx
  on public.campaign_call_queue (clinic_id);

-- Data API access. campaign_call_queue is auth-only (no anon grant).
grant select, insert, update, delete on public.campaign_call_queue to authenticated;
grant all on public.campaign_call_queue to service_role;

alter table public.campaign_call_queue enable row level security;

-- RLS — matches every other table in this schema by scoping to current_clinic_id().
create policy "Clinic can view own campaign queue"
  on public.campaign_call_queue
  for select
  using (clinic_id = public.current_clinic_id());

create policy "Clinic can insert own campaign queue"
  on public.campaign_call_queue
  for insert
  with check (clinic_id = public.current_clinic_id());

create policy "Clinic can update own campaign queue"
  on public.campaign_call_queue
  for update
  using (clinic_id = public.current_clinic_id());

create policy "Clinic can delete own campaign queue"
  on public.campaign_call_queue
  for delete
  using (clinic_id = public.current_clinic_id());

-- updated_at trigger reuses the project's existing function.
drop trigger if exists update_campaign_call_queue_updated_at on public.campaign_call_queue;
create trigger update_campaign_call_queue_updated_at
  before update on public.campaign_call_queue
  for each row execute function public.update_updated_at_column();
