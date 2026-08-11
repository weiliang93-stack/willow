-- Run this once in the Supabase SQL editor for your project
-- (Project > SQL Editor > New query).
--
-- One row per (user, app), storing that app's whole state as a JSON blob —
-- mirrors what training-app and expense-tracker already keep in
-- localStorage, so no relational schema to design or migrate.

create table if not exists public.app_state (
  user_id uuid not null references auth.users (id) on delete cascade,
  app text not null,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, app)
);

alter table public.app_state enable row level security;

create policy "select own state" on public.app_state
  for select using (auth.uid() = user_id);

create policy "insert own state" on public.app_state
  for insert with check (auth.uid() = user_id);

create policy "update own state" on public.app_state
  for update using (auth.uid() = user_id);
