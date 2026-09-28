-- GP MediList Telegram locum-group outreach.
--
-- locum_posts       raw capture of every message the bot sees in the group
--                   chats it's a member of (written by telegram-poll). This is
--                   the only place the poster's real Telegram user id and the
--                   real message id live — Beeper doesn't expose either.
-- outreach_contacts one row per poster (keyed by Telegram user id), the dedup
--                   + status source of truth for the daily digest.
-- outreach_digest_runs  one row per daily digest (the summary header message).
--
-- Flow: the daily Claude task reads locum_posts, classifies, and writes
-- outreach_contacts rows with status 'pending_send' (+ draft, order) and one
-- outreach_digest_runs row with status 'pending'. The outreach-digest edge
-- function (pg_cron, every 5 min) delivers anything pending to the bot chat and
-- flips it to 'digested'. The ✅ Sent / Skip buttons (handled by telegram-poll)
-- flip contacts to 'sent' / 'skipped'.

create table if not exists public.locum_posts (
  id bigserial primary key,
  chat_id bigint not null,
  chat_title text,
  message_id bigint not null,
  tg_user_id bigint,
  username text,
  sender_name text,
  sender_chat_id bigint,          -- set when posted "as" a channel/group instead of a user
  text text,
  has_media boolean not null default false,
  posted_at timestamptz not null,
  link text,
  captured_at timestamptz not null default now(),
  unique (chat_id, message_id)
);
create index if not exists locum_posts_posted_at_idx on public.locum_posts (posted_at desc);
create index if not exists locum_posts_user_idx on public.locum_posts (tg_user_id);
alter table public.locum_posts enable row level security;

create table if not exists public.outreach_contacts (
  tg_user_id bigint primary key,
  sender_name text,
  username text,
  clinic text,
  org text,                       -- chain/network name, so one contact per chain can be chosen
  clinic_type text check (clinic_type in ('independent', 'chain')),
  status text not null default 'queued'
    check (status in ('queued', 'pending_send', 'sending', 'digested', 'sent', 'skipped', 'excluded', 'failed')),
  source_chat_id bigint,
  source_message_id bigint,
  source_chat_title text,
  draft text,
  digest_order int,
  note text,
  attempts int not null default 0,  -- delivery attempts; 'failed' after 3
  first_seen_at timestamptz not null default now(),
  digested_at timestamptz,
  sent_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists outreach_contacts_status_idx on public.outreach_contacts (status);
alter table public.outreach_contacts enable row level security;

create table if not exists public.outreach_digest_runs (
  id bigserial primary key,
  run_date date not null default (now() at time zone 'Asia/Singapore')::date,
  summary text not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent')),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
alter table public.outreach_digest_runs enable row level security;

-- Upgrades for databases created before these columns/statuses existed.
alter table public.outreach_contacts add column if not exists attempts int not null default 0;
alter table public.outreach_contacts drop constraint if exists outreach_contacts_status_check;
alter table public.outreach_contacts add constraint outreach_contacts_status_check
  check (status in ('queued', 'pending_send', 'sending', 'digested', 'sent', 'skipped', 'excluded', 'failed'));

-- Delivery cron (run once, in the SQL Editor; substitute your DB_WEBHOOK_SECRET):
-- select cron.schedule('outreach_digest_every_5_min', '*/5 * * * *', $$
--   select net.http_post(
--     url := 'https://fozipnpmmjmmlthkdplf.supabase.co/functions/v1/outreach-digest',
--     headers := jsonb_build_object('x-webhook-secret', '<DB_WEBHOOK_SECRET>'),
--     body := '{}'::jsonb,
--     timeout_milliseconds := 5000
--   );
-- $$);
