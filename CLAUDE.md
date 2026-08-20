# willow

Personal multi-app repo, deployed as static sites via GitHub Pages. Owner
uses these mainly from their phone. This file exists so a fresh Claude
Code session (e.g. after a subscription lapse/renewal) has full context
without the user needing to re-explain anything — read this first.

## Apps in this repo

- **root (`index.html`/`script.js`/`style.css`)** — FitBot, a rule-based
  (no AI/API) fitness chatbot. Keyword-matches messages against a rules
  list. Not connected to Supabase or the Telegram bot.
- **training-app/** — workout tracker. Weekly schedule of templates (one
  per day-of-week slot, reorderable), exercises with planned
  weight/reps/sets, logging actual weight/reps/RPE per set, custom
  exercises, exercise overrides/deletions, a training log, a progress
  chart. Synced to Supabase. Drives the Telegram bot's `/set` flow.
- **expense-tracker/** — expense logging with categories, credit
  cards/payment methods (each with its own spending cap and billing
  cycle — calendar month or a statement day), a monthly budget, a
  category breakdown chart. Synced to Supabase. Drives the Telegram
  bot's `/exp` flow and both budget-alert paths (overall budget + per-card
  caps).
- **diary-app/** — journal entries with title/body/date, Day One import,
  media/thumbnail handling. Synced to Supabase using its own smarter
  per-entry merge (`mergeEntries`, keyed by each entry's own
  `updatedAt`/`createdAt`) rather than the whole-state last-write-wins
  approach the other two apps use.
- **investment-planner/** — synced to Supabase; not connected to the
  Telegram bot, but `sheet-investment-sync` (see below) writes account
  balances into it from a household net-worth Google Sheet.
- **taxi-compare/** — standalone, not connected to Supabase or the bot.

## Sync architecture (shared/)

- `shared/supabase-config.js` — Supabase client init.
- `shared/supabase-schema.sql` — creates `app_state` (one JSONB blob per
  `(user_id, app)`, RLS-scoped to the owning user) plus Supabase Auth.
- `shared/supabase-sync.js` — `mountAuthGate`, `pullState`/`pushState`
  (return/accept `{state, updatedAt}`), graceful no-op fallback if
  `window.supabase` fails to load (CDN failure shouldn't crash the app),
  retries failed pushes on the `online` event.
- Each app's boot function compares `remote.updatedAt` against a local
  `updatedAt` in localStorage before deciding to adopt remote state or
  keep-and-repush local — this is what prevents an offline edit from
  being silently clobbered by a stale pull on reconnect.
- **diary-app is the one exception**: it does its own per-entry merge
  instead of whole-state timestamp comparison. If you touch the
  `pullState`/`pushState` contract, diary-app's boot function needs
  updating too (`remote.state.entries`, not `remote.entries`) — this
  broke once already (see git history, PR #61 fix).
- training-app's `saveState()` includes `templates: TEMPLATES` in its
  synced payload specifically so the Telegram bot can resolve "today's
  planned workout" server-side without needing its own copy of the
  schedule logic to drift out of sync.

## Telegram bot (supabase/functions/telegram-poll, budget-alert)

Single-user personal bot, not multi-tenant. Talks to Supabase's
`app_state` table directly using the service-role key, so it reads/writes
the exact same data the apps themselves use.

**Polling, not webhook.** Telegram webhook push was tried first and
never worked on this specific Supabase project — Telegram's servers
could not reach the function's public URL even though identical requests
from a browser/dashboard/webhook.site all succeeded. Root cause was
never identified (suspected network/WAF layer specific to this
project's edge). Pivoted permanently to polling `getUpdates`.

**Polling cadence**: a `pg_cron` job (`telegram_poll_fast`, currently
scheduled via `cron.schedule('telegram_poll_fast', '2 seconds', ...)`)
calls the `telegram-poll` function on an interval. This has to be set up
via raw SQL in the SQL Editor, not the dashboard's cron UI, which only
exposes 5-field cron expressions (1-minute minimum) — interval literals
like `'2 seconds'` require calling `cron.schedule` directly.

**Why each invocation is a single quick poll-and-exit**, not a loop:
`pg_net` (which the cron job uses to call the function) hard-caps its
own HTTP response wait at 5000ms regardless of what `timeout_milliseconds`
is requested — confirmed by direct testing. An earlier design that
looped inside the function for ~100s to reduce cron overhead never
actually worked because of this; it was reverted. Responsiveness now
comes entirely from polling frequently via cron, not from any single
invocation waiting longer.

**Overlap lock**: at a 2-second interval, invocations can overlap. Since
Telegram's `getUpdates` doesn't "consume" an update until you ack it
with a higher offset, two overlapping invocations reading the same
not-yet-advanced offset would both receive (and both reply to) the same
message — this actually happened (duplicate bot replies) before the fix.
`telegram_poll_state.locked_at` + `claimPollLock`/`releasePollLock` in
`telegram-poll/index.ts` now serialize invocations, with a 20s staleness
timeout so a crashed run self-heals instead of deadlocking.

**Timezone**: Edge Functions run in UTC. Every "what day is it"
computation (expense dates, workout day-of-week resolution, card billing
cycles) uses `Intl.DateTimeFormat` with an explicit `Asia/Singapore`
timeZone — without this, anything near midnight SGT lands on the wrong
day. Same fix was applied client-side in expense-tracker's `todayStr()`.

### Commands

Power-user (single message, logs instantly):
- `/exp <amount> [category] [payment] [note]` — `$` prefix on the amount
  is accepted. Everything after the amount is greedily matched against
  actual category and payment-method names (longest-prefix match, so
  multi-word names like "Chase Sapphire" work as one unit); leftover
  words become the note. Category defaults to the last one in the list,
  payment defaults to cash, if not recognized — see `matchLongestPrefix`.
- `/set <exercise> <weight> <reps>`
- `/diary <text>`

Guided (button-driven, multi-step, state kept in
`telegram_session_state` with a 15-minute staleness timeout):
- `/exp` — asks for amount (optionally with a note after it, e.g.
  "12.50 lunch with team") → category buttons (pulled live from actual
  expense-tracker categories) → payment method buttons (cards + Cash),
  then logs immediately — no separate note-prompt step (that was tried
  and reverted; the note is captured with the amount instead)
- `/set` — resolves *today's actual planned workout* from
  training-app's own schedule/override/deletion logic (mirrored
  server-side in `resolveTodayExercises`, matching
  `training-app/script.js`'s `contentFor`/`exercisesFor`/etc.) → exercise
  buttons → set buttons → weight/reps (with "same as planned" and "same
  as last time [weight×reps, incl. last RPE]" quick-fill shortcuts, each
  on its own keyboard row — cramming two onto one row got them truncated
  on-screen) → RPE (shows last RPE as reference). On a rest day, offers
  ad-hoc exercise logging instead, which routes through a dedicated
  `finishAdhocSet` path (not the templated `finishSet`, which would
  otherwise write garbage keys like `done['-1--1-0']`).

Job-posting watcher (any group/channel the bot is added to — **never**
scans the owner's own DM with the bot):
- `/addkeyword <text>`, `/removekeyword <text>`, `/keywords`
- Case-insensitive substring match on every group/channel message,
  alerts via DM with chat name, matched keyword(s), message text, and a
  deep link (`t.me/<username>/<id>` or `t.me/c/<internal_id>/<id>`,
  where linkable).
- **Requires group privacy mode disabled** via @BotFather (`/setprivacy`)
  — otherwise the bot only sees messages that @-mention it or are
  commands. Also, **privacy mode changes aren't retroactive**: a bot
  already in a group keeps the old behavior until it's removed and
  re-added (or promoted to admin) — this bit us once on a group the bot
  had joined before privacy mode was disabled; fixed by calling
  `leaveChat` via the bot API directly (works regardless of who added
  the bot — no group-admin permission needed) and rejoining.

### Budget alerts (budget-alert function, cron `* * * * *`)

Self-queries `app_state` on every run rather than relying on a Database
Webhook — Database Webhooks are broken on this project
(`schema "supabase_functions" does not exist`, even with `pg_net`
enabled), so this polls state directly instead. Two independent alert
paths, each tracked with its own tier (`none`/`warn`/`over`) in
`budget_alert_state` so it only messages on a genuine threshold
crossing, not every run:
- **Overall monthly budget**: 70% / 100% of `monthlyBudget`.
- **Per credit card**: 90% / 100% of that card's `cap`, computed against
  *that card's own billing cycle* (calendar month, or a statement-day
  cycle — mirrors `getCardCycleRange` from expense-tracker/script.js
  exactly, just with UTC arithmetic since Edge Functions run in UTC).
  Tiers tracked per-card in `budget_alert_state.card_tiers` (jsonb map).

## Google Sheets sync (sheet-budget-sync, sheet-training-sync, sheet-investment-sync)

Three more self-querying, cron-triggered Edge Functions (same pattern as
`budget-alert` — no Database Webhooks on this project) that sync
`app_state` against separate personal Google Sheets, each authenticated
via one shared Google service account (JWT, not the owner's own Google
login) so they run unattended on a schedule.

- **sheet-budget-sync** — two-way with the expenses budget sheet: pulls
  `monthlyBudget` from cell R15 of the sheet's leftmost tab (a new tab is
  added each month with no fixed name, so "leftmost" is always used
  instead of guessing a tab name from the date), pushes the computed
  current-month spend back into R16.
- **sheet-training-sync** — two-way with a separate training sheet: pulls
  exercise plan edits from a "Plan" tab (Focus/Exercise/Sets/Reps/Weight/
  Equipment columns), matched against `state.templates` by exact focus
  text then by effective exercise name (checking deleted exercises too,
  so a sheet row can't resurrect something soft-deleted in the app) —
  add-or-update only, sheet edits never delete anything app-side. Also
  pushes newly logged sets to the leftmost tab, append-only, tracked by
  log-entry `id` in `training_sheet_sync_state` (idempotent re-runs).
- **sheet-investment-sync** — one-way, sheet → app: pulls Wei Liang's and
  Zhen Ling's latest investment balances out of a wide "Balances" tab
  (one column per month, always reads whichever column in the date row
  is the last non-empty one) into investment-planner's matching accounts
  by exact name match; creates the account if missing, never touches
  `monthlyContribution`/`annualReturnPct`.

**Known caveat shared by all three** (and by `budget-alert`): `app_state`
is a single JSON blob synced whole-state last-write-wins. If the app is
open in a browser tab when one of these runs, its write can be silently
overwritten the next time that tab's own `save()` fires. Not fixed —
just something to know if a sheet-driven change seems to "disappear."

Extra required secrets beyond the Telegram bot's:
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` —
  from the service account's downloaded JSON key, shared across all
  three functions
- `GOOGLE_SHEET_ID` (budget), `GOOGLE_TRAINING_SHEET_ID` (training),
  `GOOGLE_BALANCES_SHEET_ID` (investment) — three separate sheets, each
  shared with the service account's email (Editor for budget/training
  since they write back, Viewer is enough for the balances sheet since
  it's read-only)

## Required secrets (Edge Functions)

- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `TELEGRAM_CHAT_ID` — owner's personal chat id; messages from any other
  chat are ignored for command/flow handling (group/channel messages
  still get scanned for job keywords, separately)
- `WILLOW_USER_ID` — the Supabase auth user id all `app_state` rows
  belong to (single-user bot)
- `DB_WEBHOOK_SECRET` — shared secret checked via the `x-webhook-secret`
  header, used by both `budget-alert` and `telegram-poll` to reject calls
  that didn't come from their own cron jobs
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — auto-injected by
  Supabase, never set manually (the dashboard rejects the `SUPABASE_`
  prefix on manual secrets)

No MCP tool manages Edge Function secrets — even with Supabase MCP
connected, secrets still have to be set via the dashboard.

## Schema files

Run once each, in order, via the SQL Editor:
1. `shared/supabase-schema.sql` — `app_state` + Auth
2. `shared/telegram-schema.sql` — `budget_alert_state` (+ `card_tiers`
   column), `telegram_poll_state` (+ `locked_at` column),
   `telegram_session_state`, `telegram_job_watch`. All idempotent
   (`create table if not exists`, `add column if not exists`), safe to
   re-run.
3. `shared/training-sheet-sync-schema.sql` — `training_sheet_sync_state`
   (tracks which logged-set ids have already been pushed to the training
   sheet, for `sheet-training-sync`'s append-only idempotency). Also
   idempotent, safe to re-run.

## Working conventions established in this repo

- Keep power-user one-line bot commands working alongside any guided
  flow — never remove the fast path when adding a guided one.
- Prefer fewer/cheaper cron invocations when a little latency is fine;
  the 2-second `telegram_poll_fast` interval was a deliberate
  responsiveness tradeoff the user asked for explicitly, not a default
  to assume elsewhere.
- Job-posting monitoring is scoped to public groups/channels the owner
  can add their own bot to — never private DMs or groups they don't
  control.
- Diary photo-upload-via-bot is explicitly out of scope (user said
  "leave it").
- Regular Telegram reply keyboard is fine; no custom numeric keypad
  needed.
- This is a single-user personal project — RLS-enabled-with-zero-policies
  (service-role-only access) on the Telegram-related tables is
  intentional, not an oversight.
