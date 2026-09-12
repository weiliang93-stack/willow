-- Run this once in the Supabase SQL editor, in addition to
-- shared/supabase-schema.sql, to support household-sheet-sync.
--
-- Household/combined-expense data itself lives in app_state (app =
-- 'expenses_automation'), owned by the bank-email auto-logger routine —
-- see that Routine's prompt for the exclusionRules/categoryRules engine
-- that classifies a charge as combined household spend and appends it to
-- that row's excludedExpenses array. This schema only adds the sync-state
-- table household-sheet-sync needs to push that array into the
-- "Household Expenses" Google Sheet.
--
-- Tracks which excludedExpenses ids have already been pushed to the
-- sheet, same purpose and shape as expense_sheet_sync_state (see that
-- table's comment for the full reasoning) — lets household-sheet-sync
-- both append new rows and detect/remove rows for expenses that were
-- removed from excludedExpenses since the last run.
create table if not exists public.household_expense_sync_state (
  id smallint primary key,
  synced_ids jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.household_expense_sync_state (id, synced_ids)
values (1, '[]'::jsonb)
on conflict (id) do nothing;

alter table public.household_expense_sync_state enable row level security;

-- No policies added on purpose: this table is only ever read/written by
-- the household-sheet-sync Edge Function using the service_role key,
-- which bypasses RLS entirely. Leaving RLS enabled with zero policies
-- means the anon/authenticated roles get no access to it at all.
