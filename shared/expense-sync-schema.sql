-- Tables for supabase/functions/expense-email-sync. Idempotent; run once in
-- the SQL Editor. Service-role only (RLS on, no policies), same as the
-- Telegram tables.

-- One row per (Gmail message, mode) the function has decided on. Doubles as
-- the "already processed" set, the shadow-vs-routine comparison source, and
-- the input to the daily report. `mode` keeps shadow-week decisions from
-- blocking live mode from handling the same emails after cutover.
create table if not exists expense_sync_log (
  message_id text not null,
  mode text not null check (mode in ('shadow', 'live')),
  decided_at timestamptz not null default now(),
  action text not null,           -- log | remove | incoming | review | skip
  target text,                    -- expenses | excluded (log/remove only)
  entry jsonb,
  summary text,
  applied boolean not null default false,
  primary key (message_id, mode)
);
create index if not exists expense_sync_log_decided on expense_sync_log (mode, decided_at);
alter table expense_sync_log enable row level security;

-- Telegram prompts awaiting a tap (category check, incoming PayNow offset,
-- alert that needs a human). Resolved by telegram-poll's "xs:" callbacks.
create table if not exists expense_sync_pending (
  id bigserial primary key,
  kind text not null,             -- category | incoming | review
  message_id text,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
alter table expense_sync_pending enable row level security;

create table if not exists expense_sync_state (
  id int primary key default 1 check (id = 1),
  last_report_date text,
  last_error_at timestamptz
);
alter table expense_sync_state enable row level security;

-- Every 15 minutes. Replace <PROJECT_REF> and <DB_WEBHOOK_SECRET> (the same
-- secret budget-alert/telegram-poll use):
--
-- select cron.schedule('expense_email_sync', '*/15 * * * *', $$
--   select net.http_post(
--     url := 'https://<PROJECT_REF>.supabase.co/functions/v1/expense-email-sync',
--     headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', '<DB_WEBHOOK_SECRET>'),
--     body := '{}'::jsonb,
--     timeout_milliseconds := 5000
--   );
-- $$);
