-- One-time helper for supabase/functions/sync-fixed-costs.
-- Run in the SQL editor before the first sync. Safe to re-run.
--
-- Updates only app_state.state.fixedCosts for app = 'familyhub'.
-- Does not schedule a cron job and contains no secrets.
-- The daily job (0 21 * * * UTC, about 05:00 Asia/Singapore) is added
-- by hand, the same way as the other sheet syncs, posting to
-- /functions/v1/sync-fixed-costs. See family-hub/HANDOVER.md.

create or replace function public.set_familyhub_fixed_costs(target_user uuid, costs jsonb)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  ts timestamptz;
begin
  if costs is null or jsonb_typeof(costs) <> 'object' then
    raise exception 'fixed costs payload must be an object';
  end if;
  update public.app_state
     set state = jsonb_set(coalesce(state, '{}'::jsonb), '{fixedCosts}', costs, true),
         updated_at = now()
   where user_id = target_user
     and app = 'familyhub'
  returning updated_at into ts;
  if ts is null then
    raise exception 'familyhub row not found';
  end if;
  return ts;
end;
$$;

revoke all on function public.set_familyhub_fixed_costs(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.set_familyhub_fixed_costs(uuid, jsonb) to service_role;
