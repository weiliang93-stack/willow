-- Run this once in the Supabase SQL editor, in addition to
-- shared/supabase-schema.sql, to support the Telegram bot integration.
--
-- Tracks the last budget-alert tier ("none" / "warn" / "over") that was
-- sent, so the budget-alert Edge Function only messages you when you
-- cross a threshold rather than on every expense change. Kept in its own
-- table (not inside app_state's JSON blob) so it's never touched or wiped
-- by the apps' own save() calls, which always overwrite app_state with
-- only the fields they know about.
create table if not exists public.budget_alert_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  tier text not null default 'none',
  updated_at timestamptz not null default now()
);

alter table public.budget_alert_state enable row level security;

-- No policies added on purpose: this table is only ever read/written by
-- the budget-alert Edge Function using the service_role key, which
-- bypasses RLS entirely. Leaving RLS enabled with zero policies means
-- the anon/authenticated roles (i.e. the apps themselves) get no access
-- to it at all.

-- Tracks the last Telegram update id the telegram-poll function has
-- already processed, so a message doesn't get logged twice across
-- separate cron-triggered invocations. Single row (id is always 1).
create table if not exists public.telegram_poll_state (
  id smallint primary key,
  last_update_id bigint not null default 0,
  updated_at timestamptz not null default now()
);

insert into public.telegram_poll_state (id, last_update_id)
values (1, 0)
on conflict (id) do nothing;

alter table public.telegram_poll_state enable row level security;

-- Same reasoning as budget_alert_state above: no policies, only the
-- service-role-authenticated Edge Function ever touches this table.
