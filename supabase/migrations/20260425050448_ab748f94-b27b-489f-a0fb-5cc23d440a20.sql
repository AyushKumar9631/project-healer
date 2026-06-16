create or replace function public.call_billable_seconds(c public.calls)
returns int
language sql
immutable
set search_path = public
as $$
  select greatest(0, least(3600, case
    when c.status = 'completed' then
      coalesce(c.duration_seconds, 0)
      + least(30, greatest(0, coalesce(extract(epoch from (c.started_at - c.created_at))::int, 0)))
    when c.status = 'voicemail' then
      coalesce(nullif(c.duration_seconds, 0),
               least(60, greatest(0, coalesce(extract(epoch from (c.ended_at - c.created_at))::int, 0))))
    when c.status in ('no_answer', 'busy') then 30
    when c.status = 'declined' then
      greatest(coalesce(c.duration_seconds, 0), 6)
      + least(30, greatest(0, coalesce(extract(epoch from (coalesce(c.started_at, c.ended_at) - c.created_at))::int, 0)))
    when c.status = 'failed' then 0
    else
      least(600, greatest(0, extract(epoch from (now() - c.created_at))::int))
  end));
$$;