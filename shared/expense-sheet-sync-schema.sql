-- Run this once in the Supabase SQL editor, in addition to
-- shared/supabase-schema.sql, to support sheet-expense-sync.
--
-- Tracks which expenses-app log entries (by their `id`) have already been
-- pushed to the Google Sheet, so re-running the sync only appends rows for
-- expenses logged since the last run instead of re-appending everything and
-- duplicating rows. Kept in its own table (not inside app_state's JSON
-- blob) so it's never touched or wiped by the app's own save() calls,
-- which always overwrite app_state with only the fields it knows about.
-- Single row (id is always 1).
create table if not exists public.expense_sheet_sync_state (
  id smallint primary key,
  synced_ids jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.expense_sheet_sync_state (id, synced_ids)
values (1, '[]'::jsonb)
on conflict (id) do nothing;

alter table public.expense_sheet_sync_state enable row level security;

-- No policies added on purpose: this table is only ever read/written by
-- the sheet-expense-sync Edge Function using the service_role key, which
-- bypasses RLS entirely. Leaving RLS enabled with zero policies means the
-- anon/authenticated roles (i.e. the app itself) get no access to it at all.
