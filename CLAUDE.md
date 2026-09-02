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
- **templates-app/** — search/browse/copy UI for consult-note templates,
  used at the point of care to find and copy the right template into the
  owner's clinic management system. A mode toggle (In-Clinic /
  Teleconsult) switches between two completely separate template sets,
  each with its own Google Doc source, sync function, `app_state` app
  key, categories, and starred list:
  - **In-Clinic** (~185 templates, 12 categories) — from the WILLOW doc,
    synced by `sheet-templates-sync` into app `"templates"`.
  - **Teleconsult** (~74 templates, 9 categories incl. a "Standard
    Blocks" category for reusable opening/closing/referral/MC-disclaimer
    snippets) — from the WILLOW TM doc, synced by
    `sheet-teletemplates-sync` into app `"teletemplates"`.
  Templates themselves are one-way, doc → app, for both — each sync
  function is its data's only writer, the app just `pullState`s them —
  with two exceptions, both for either mode: an edit button on the
  detail view lets the owner fix a template's body in-app, which writes
  straight back into the live source doc via the `template-edit` Edge
  Function (see its own section below for the safety design) rather
  than just updating the local copy; and an "Add template" button lets
  the owner create a brand-new template in-app, appended into the live
  source doc via the `template-add` Edge Function (see its own section
  below — it needs a different insertion strategy per doc, since
  In-Clinic's categories aren't headings the way Teleconsult's are).
  Starring is the one thing the app itself owns, scoped per mode: it
  `pushState`s `{templates, starred}` (starred = array of template ids)
  under that mode's app key, and each sync function preserves its own
  `starred` across its own periodic overwrite of `templates` rather than
  clobbering it. Starred templates surface in their own section above
  the category list on the home screen. Caches both modes'
  templates/starred/updatedAt in localStorage (namespaced per mode) so
  it still works if opened offline in clinic, and remembers the last
  selected mode. Not connected to the Telegram bot. Light/dark follows
  the OS via `prefers-color-scheme` rather than a fixed palette, unlike
  the other apps — this one gets opened at all hours.
- **teleconsult-tracker/** — live per-patient earnings clicker for running two
  simultaneous teleconsult jobs, Whitecoat TM and Fullerton TM. Not connected
  to the Telegram bot. Session state lives in `localStorage` only, keyed to
  the current calendar date (a new day resets patient counts/history but
  keeps the target-$ and shift-length settings) — it is *not* synced to
  `app_state` like the other apps. It does sit behind the same Supabase
  Auth gate as templates-app/training-app/expense-tracker (`#authGate` +
  `SupaSync.mountAuthGate`, whole app hidden until signed in), added
  specifically so **"End shift"** can call the `teleconsult-end-shift` Edge
  Function as the signed-in user — see its own bullet below. If Supabase is
  unreachable (offline, CDN blocked), `mountAuthGate`'s existing no-op
  fallback boots the app straight into local-only mode same as before; only
  "End shift" itself needs a working, signed-in session — everything else
  (tallying, copy-for-sheet, float tracker) works without one.
  Pay logic, validated against the real Accounts Google Sheet before
  building:
  - **Whitecoat TM** — $13/patient with meds, $10/patient without, tallied
    against an editable $ target (not a fixed patient count, since the
    with-meds/no-meds mix varies). Pays $0 for the whole session whenever
    the "Rostered" toggle is off, even if the owner logs on and sees
    patients — this card's tap buttons disable entirely in that state.
  - **Fullerton TM** — when rostered: base pay is `hours × $70`, paid in
    full regardless of pace (this mirrors the real monthly locum-claim
    formula in the `telemed-locum-claims` skill: `E24 = B24*C24`, i.e.
    hours × rate with no per-hour forfeiture — not the "only if you hit
    5/hr" rule the owner first described it as). A $10/patient bonus starts
    once patient count exceeds `hours × 5`. A shift timer/pace pill is
    informational only (on-pace/behind-pace vs elapsed time), it doesn't
    change the math. When not rostered: flat $10/patient, no base, no
    threshold — the owner can still log on ad hoc.
  - Because the real FHG TM claim nets hours and patients across the whole
    month (see `telemed-locum-claims`), this app's per-session bonus figure
    is only an estimate for that one session — the monthly claim is what
    actually reconciles pay.
  - **"Copy for sheet"** buttons build a row matching the owner's Accounts
    sheet's daily transaction log exactly (columns A–J: Date, Day, blank
    Start/End, Company, Venue, blank Pay/h, Hours, Pay, Comment), written
    to the clipboard as real HTML (not just tab-separated plain text) so
    pasting into Sheets carries the sheet's own real formatting — read
    directly off the Aug 2026 tab rather than guessed: Whitecoat rows fill
    E:I with `#f4cccc`, Fullerton rows with `#9900ff`, columns A–D and J
    stay white; Date/Day are center-aligned, Start/End/Company/Venue left,
    Pay-h/Hours/Pay right, and Comment left-aligned with a black box
    border (the only column with an explicit border). The Whitecoat
    comment is `{no-meds count}/{meds count}` — confirmed against 8+ of
    the owner's real logged rows (e.g. `694` ⇄ comment `7/48` = 7×$10 +
    48×$13). The Fullerton comment/pay is bonus-only when rostered
    (`{n} over` / `n×$10`) since the owner still enters that session's
    base-pay row into the sheet themselves, the same way the existing
    `-650`-style rows already work; it's the full `patients×$10` with an
    "`{n} adhoc`" comment when not rostered, since there's no separate
    base row for that case.
  - **"Float tracker"** opens both jobs' live totals and tap buttons in a
    single combined always-on-top window via Chrome's Document
    Picture-in-Picture API (`documentPictureInPicture.requestWindow`) —
    deliberately one combined window rather than one per job, because
    Chrome only allows a single Document PiP window per page at a time.
    The existing `#floatPanel` DOM node is moved wholesale into the PiP
    window (carrying its live event listeners/state with it, not a copy)
    and moved back to the main page on close. Falls back to an in-page
    draggable panel (pinned via `position:fixed`, dragged by its header)
    on browsers without the API — the owner uses Chrome exclusively so
    this is a safety net, not the primary path. Chrome's Document PiP
    windows don't inherit the page's stylesheet, so `copyStylesInto` clones
    matching `<link rel="stylesheet">` tags into the new window's
    `<head>`.
  - Light/dark follows the OS via `prefers-color-scheme`, same reasoning
    as templates-app — this gets opened at whatever hour the owner is
    doing teleconsults.
  - **"End shift"** writes the same rows "Copy for sheet"/"Copy both rows"
    build straight into the real Accounts sheet via the
    `teleconsult-end-shift` Edge Function (see its own section below),
    instead of the owner pasting them by hand — the copy buttons remain as
    a fallback. The button disables itself after a successful write
    (label flips to "Shift added ✓") so a second accidental click can't
    double-log the same numbers; any further count/target/hours/rostered
    change re-enables it (`markShiftDirty`, called from both render
    functions so every state-changing action is covered in one place
    rather than needing to be wired at each call site individually).
  - **"Check calendar"** auto-detects whether the owner is rostered for WC
    TM / FHG TM on the "Logging for" date by reading their real Google
    Calendar via the `teleconsult-check-roster` Edge Function (see its own
    section below), instead of tapping the "Rostered" toggles by hand.
    Auto-runs once on a genuinely fresh day (no same-day localStorage
    state yet) right after boot; never re-runs automatically after that,
    so a manual toggle change made mid-session is never silently
    overridden — the button itself is always available for an on-demand
    re-check (e.g. a roster added after the session was already open),
    and a manual re-check's result does overwrite whatever's currently
    set, same as the first auto-run would have.

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
scheduled at `'* * * * *'`, i.e. once a minute, via `cron.alter_job`)
calls the `telegram-poll` function on an interval. Sub-minute cadences
have to be set up via raw SQL in the SQL Editor as an interval literal
(e.g. `'2 seconds'`, `'15 seconds'` — max 59) rather than the dashboard's
cron UI, which only exposes 5-field cron expressions (1-minute minimum,
`pg_cron` rejects an interval literal above 59 seconds so 60s+ has to be
the standard 5-field form instead). Originally ran at `'2 seconds'` for
max responsiveness, then briefly `'15 seconds'`, both burning enough
Edge Function invocations/day (43k at 2s) to push the Supabase project
over its Fair Use Policy invocation quota (Sept 2026). Dialed back to
once a minute (~1,440 invocations/day) since Sept 2026 usage is
job-posting-keyword-watch only — `/exp`, `/set`, and `/diary` still work
at this cadence but now lag up to ~60s, which matters if that usage
picks back up. Speed it back up (`select cron.alter_job(job_id :=
(select jobid from cron.job where jobname = 'telegram_poll_fast'),
schedule := '15 seconds');` or `'2 seconds'`) if responsiveness matters
again and quota allows it.

**Why each invocation is a single quick poll-and-exit**, not a loop:
`pg_net` (which the cron job uses to call the function) hard-caps its
own HTTP response wait at 5000ms regardless of what `timeout_milliseconds`
is requested — confirmed by direct testing. An earlier design that
looped inside the function for ~100s to reduce cron overhead never
actually worked because of this; it was reverted. Responsiveness now
comes entirely from polling frequently via cron, not from any single
invocation waiting longer.

**Overlap lock**: at a fast polling interval, invocations can overlap. Since
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
`sheet-templates-sync` (below) mostly avoids this: templates-app only
ever writes the `starred` field, and the sync function reads-then-merges
that field back in rather than overwriting `state` wholesale — so a
star set from the app can't be clobbered by the next sync (see
templates-app's entry above for how `starred` itself is kept in sync).

Extra required secrets beyond the Telegram bot's:
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` —
  from the service account's downloaded JSON key, shared across all
  three functions
- `GOOGLE_SHEET_ID` (budget), `GOOGLE_TRAINING_SHEET_ID` (training),
  `GOOGLE_BALANCES_SHEET_ID` (investment) — three separate sheets, each
  shared with the service account's email (Editor for budget/training
  since they write back, Viewer is enough for the balances sheet since
  it's read-only)

## Google Doc sync (sheet-templates-sync, sheet-teletemplates-sync)

Same self-querying, cron-triggered pattern as the sheet syncs above (and
the same shared Google service account), but the source is a Google
*Doc*, not a Sheet — the WILLOW consult-templates doc — and it's fetched
via Drive's plain-text export (`files/{id}/export?mimeType=text/plain`)
rather than the Sheets API, since that already gives clean
paragraph-per-line text without walking Docs API structuralElements.

One-way, doc → app, every 10 minutes (bumped up from a daily cadence so
an in-progress doc edit shows up in the app almost immediately — the
owner edits these mid-shift more often than the other synced sheets).
Parsing relies on two things the doc
already has: each template is separated from the next by a paragraph
that's just a long run of `=` characters (title = the first non-blank
line after it), and the doc's own table of contents lists every
condition under a category heading in the same top-to-bottom order the
body follows. Category is assigned by walking the TOC in step with the
body — each block's title is loosely matched (case/punctuation-
insensitive containment) against the next few not-yet-consumed TOC
entries; a hit advances to that entry's category, a miss means the block
is a variant of the current condition (e.g. "URTI (COVID)" / "URTI" /
"Paeds URTI" all under one TOC entry) and inherits the category
unchanged. This ordering approach replaced an earlier version that tried
reading category off a restated header line at the top of each
category's first body block — the doc only does that consistently for a
handful of categories, so for the rest it silently dumped everything
after the last correctly-detected category into that one category
(caught by comparing parsed counts against the TOC's own per-category
counts before shipping). Because it's order-based rather than a hard
structural anchor, category is still best-effort — occasionally a block
can land one category off — while titles and bodies, read directly off
the block, are always exact. If fewer than 20 templates parse out, the
function aborts without writing, on the theory that's a doc-structure
change rather than a real 0-template day — better to leave the last
synced copy in place than silently overwrite it with garbage.

If the doc's variant naming ever needs actual "one condition, several
variants" grouping (e.g. "URTI (COVID)" / "URTI" / "Paeds URTI" shown as
tabs under one shared condition rather than three separate list entries)
— that grouping isn't attempted here, since there's no reliable shared
key across blocks to cluster on beyond the doc's own free-text titles.
Each block is a standalone, independently searchable template.

Extra required secret beyond the sheet syncs' own:
- `GOOGLE_WILLOW_DOC_ID` — the id from the doc's URL
  (`docs.google.com/document/d/<id>/edit`); the doc must be shared with
  the same service account email as the sheet syncs (Viewer is enough,
  read-only).

**sheet-teletemplates-sync** is the companion sync for WILLOW TM (the
teleconsultation-note equivalent of the same doctor's WILLOW doc — see
templates-app's entry above for how the two feed the app's In-Clinic/
Teleconsult mode toggle). Its parsing is much simpler than
sheet-templates-sync's, because the source doc is authored with real
Google Docs heading styles instead of `====` separators: it's fetched as
Markdown (`export?mimeType=text/markdown`, not plain text) and parsed
directly off the resulting `#`/`##`/`###` markers — `##` headings are
categories, `###` headings under them are templates, no table-of-
contents cross-referencing or label-guessing needed. The doc's own
"Table of Contents" section is skipped outright (just a bullet list of
links). One quirk: the doc's "Standard Teleconsult Blocks" section
(reusable opening/closing scripts, MC disclaimer footer, a specialist
referral letter template, paediatric medication precautions) doesn't use
`###` for its sub-items — each is a paragraph that's *only* bold text
(e.g. `**Opening (use for every teleconsult):**`) — so a trimmed line
matching `^\*\*(.+)\*\*$` is treated the same as a heading, filed under
its own `"Standard Blocks"` category. Same starred-preserving upsert and
<20-templates abort safety net as sheet-templates-sync.

Extra required secret beyond sheet-templates-sync's own:
- `GOOGLE_WILLOW_TM_DOC_ID` — the id from the WILLOW TM doc's URL; same
  service account, Viewer access.

## Doc editing (template-edit)

The one place in the sync architecture where an app writes *into* a doc
rather than just reading from it — templates-app's edit button lets the
owner fix a template's body in-app and have that change written straight
back into the live WILLOW or WILLOW TM doc, for both In-Clinic and
Teleconsult. Templates and categories otherwise stay one-way (doc →
app); this is the single exception.

Unlike every other Edge Function here, `template-edit` is called by the
app itself as the signed-in user (`SupaSync.invokeFunction`, which
attaches the session's access token) rather than by cron, so
`verify_jwt` is left on and the resolved user id is also checked against
`WILLOW_USER_ID` as a second layer — the service-role client this
function uses to read/write `app_state` bypasses RLS, so that check is
what actually stops another Supabase user from hitting the function and
editing the doctor's real doc.

Safety design, since a wrong edit here corrupts the doctor's real
clinical reference doc, not just a cached copy: given a template id, it
looks up that template's stored `title` from the last successful sync
(already known to exist verbatim in the live doc as of that sync),
fetches the doc via the Docs API (not the plain-text/markdown export the
read syncs use — this needs real paragraph start/end indices to build a
batchUpdate request), and searches for paragraphs matching each doc's
own boundary/title rules (`====` separator or age-variant marker for
WILLOW; heading or bold-only paragraph for WILLOW TM — mirroring each
read parser's own boundary logic exactly). It requires **exactly one**
match — zero means the doc changed since the last sync, more than one is
an ambiguous doc it refuses to guess at — and aborts with a clear error
in either case rather than editing the wrong section. The body's end
boundary is the next boundary paragraph, trimmed to the innermost
non-blank paragraphs so surrounding blank-line spacing is preserved. The
actual edit is a delete-then-insert `batchUpdate` with
`writeControl.requiredRevisionId` set to the revision just read, so a
concurrent doc edit between the read and the write fails the call
cleanly instead of silently clobbering it. On success, the template's
`body` in `app_state` is updated immediately too (preserving `starred`
and everything else), rather than waiting for the next periodic sync.

Requires Editor (not just Viewer) access on both docs for the shared
Google service account — no new secrets beyond what the sheet-sync
functions already use.

## Doc adding (template-add)

The other place an app writes *into* a doc rather than reading from
it — templates-app's "Add template" button lets the owner create a
brand-new template in-app and have it appended straight into the live
WILLOW or WILLOW TM doc, for both In-Clinic and Teleconsult. Same
auth pattern as `template-edit` (`verify_jwt` on, resolved user id
checked against `WILLOW_USER_ID`, CORS handled explicitly for the
browser call).

The two docs need genuinely different insertion strategies, mirroring
how their read syncs parse them:
- **Teleconsult (WILLOW TM)** — categories are their own `"## "`
  headings in the doc, so the target category is looked up directly
  (exactly one match required) and the new template is appended right
  before the next `"## "`-or-higher heading. Excludes "Standard
  Blocks" (different bold-only-paragraph convention).
- **In-Clinic (WILLOW)** — categories aren't headings at all;
  `sheet-templates-sync` assigns category by walking the doc's table
  of contents in step with the body, so there's no single heading to
  anchor a new entry on. Instead, `template-add` takes the *last*
  existing template already stored under the chosen category
  (`app_state`'s array order mirrors doc order), locates that exact
  template's title paragraph live in the doc, then scans forward for
  the next real `"===="` separator — deliberately skipping over any
  embedded age-variant marker lines along the way, so a new entry can
  never get spliced into the middle of an existing multi-variant block
  (which would otherwise carve something like "Balanitis (Paeds)" out
  into its own raw block and change how *existing* content parses).
  The new template is appended right after that separator, with its
  own new `"===="` closing it off. Since `sheet-templates-sync`
  assigns category purely by sequential TOC-matching — a title with no
  TOC entry just inherits whatever category is "current" when that
  block is reached, the same fallback age-variants rely on — appending
  right after the category's last known block makes the parser assign
  the new entry that same category correctly, with no TOC entry
  required.

Safety design mirrors `template-edit`: the insertion anchor must match
**exactly once** in the doc (0 or >1 aborts with a clear error); the
new title must not already exist (case-insensitive); insertion only
ever appends at a boundary already computed from the live doc, never
touching or reordering existing content; and
`writeControl.requiredRevisionId` locks the whole `batchUpdate` to the
revision just read.

The inserted text is always plain — no markdown syntax, no style
embedded in the string. This was learned the hard way: the insertion
point sits at the start of the *next* boundary paragraph, and Docs'
`insertText` splits that paragraph at the insertion point, so every
new paragraph created by the inserted text's own newlines inherits
that split paragraph's style (bold + heading, not `NORMAL_TEXT`) —
first found when a real "TEST" addition in Teleconsult came back with
its whole body silently turned into bold headings, which
`sheet-teletemplates-sync` then parsed as separate empty templates.
The same bug turned out to already be live in `template-edit` too
(its delete-then-insert lands at the same kind of boundary), and had
silently corrupted a real "Primary Dysmenorrhoea" template's body at
some point before it was caught. Fix in both functions: explicitly
reset the *entire* inserted range to `NORMAL_TEXT` + not bold first,
then (Teleconsult only) re-apply Heading 3 + bold to just the title
paragraph as a later, overriding request. In-Clinic's own parser never
looks at paragraph style at all — it's a plain-text export parsed
purely by `"===="` text and TOC matching — so the reset there is a
cosmetic safeguard against an ugly inherited style, not a correctness
fix, but cheap enough to apply uniformly.

`template-cleanup` (see its own header comment) carries a
`fixCorruptedBody` mode that narrowly repairs one named template's
body back to plain text if this class of bug ever recurs, and a
`previewAddClinic`/`previewAdd` read-only mode used to verify
`template-add`'s anchor-finding and insertion-point math against the
real live docs before trusting a real write — needed since
`template-add` itself requires real user auth that can't be faked to
test directly.

On a successful real write, the new template is also appended to
`app_state[app].templates` immediately (preserving `starred` and
everything else), and the matching sheet sync is re-triggered so the
doc's own re-parse is cross-checked against what was just written.

Requires the same Editor access already granted for `template-edit` —
no new secrets.

## Accounts sheet writing (teleconsult-end-shift)

The other place an app writes rather than reads: teleconsult-tracker's
"End shift" button. Same `verify_jwt`-on + `WILLOW_USER_ID`-check pattern
as `template-edit` (called by the app as the signed-in user via
`SupaSync.invokeFunction`, not by cron), but simpler — it doesn't re-derive
Whitecoat/Fullerton pay logic server-side at all. The client sends
already-computed rows (same shape "Copy for sheet" builds:
company/venue/hours/pay/comment/bg) plus the session's `{year, month, day,
weekday}`, and the function only writes exactly what it's given. Trusting
the client like this is a deliberate single-user-app tradeoff — duplicating
the pay-rate math here would just be a second place for it to drift out of
sync with `teleconsult-tracker/script.js`.

Always targets the leftmost tab of the Accounts sheet — same "no fixed tab
name, a new one is added every month" convention as
sheet-budget-sync/sheet-training-sync, confirmed against the real sheet
(newest month tab is always frontmost, e.g. "Aug 2026").

**Where in the tab new rows land** has bitten this function twice, both
times because the real per-day log doesn't start at row 1 — rows 1-10 are
always a header + summary/bonus block with column A blank throughout,
regardless of what month or how much data exists:
- First: `values.append`'s own table auto-detection (anchored at A1) read
  that blank column A as "table is empty" and inserted new rows at the
  very top of a tab that already had ~55 rows of real log data.
  Fixed by dropping `values.append` for a targeted `values.update` (PUT),
  with the write position found by explicitly scanning column A for the
  first blank row once the log's own data had been seen.
- Second: that scan itself still anchored at row 1, so it failed
  identically on a brand-new month's tab with *no* log rows logged yet —
  column A is blank for the entire fetched range, "seen some data" never
  becomes true, and the fallback resolved to row 1 again.
  Fixed by anchoring the scan to a fixed `LOG_START_ROW = 11` constant
  (`findLogEndRow` in `teleconsult-end-shift/index.ts`) instead of
  scanning from row 1 — this matches the same fixed row the
  `telemed-locum-claims`/`confirm-tm-income` skills already use by hand,
  rather than something to auto-detect. Everything from row 11 down is
  unambiguously either a real logged day or genuinely unused, never a
  header row.

Two more things it deliberately avoids doing the "obvious" way, both
learned from bugs already hit once in this app's clipboard-copy path:

- **The date is sent as `{year, month, day}` integers, converted to a
  Sheets serial number (`days since 1899-12-30`) server-side**, not sent
  as a "D/M/YYYY" string for `values.append` to smart-parse — a string
  would depend on the spreadsheet's locale actually being day-first to
  parse correctly, which the served value is never allowed to gamble on.
  A separate `batchUpdate` right after sets that cell's `numberFormat` to
  `d/m/yyyy` explicitly, matching the sheet's existing date columns.
- **Column J (Comment) values like `7/48` or `2 over` are appended under
  `valueInputOption=RAW` as genuine JSON strings**, not left to Sheets'
  own smart-parsing (which is what turned a real comment like `13/5` into
  a right-aligned "number" once already, via the clipboard-paste path —
  see the git history around that fix). Hours/Pay are sent as genuine
  JSON numbers instead of numeric-looking strings, which under RAW still
  land as real numbers (RAW only suppresses *string* reinterpretation,
  not the JSON value's own type) — this is what keeps them usable by any
  `SUMIF`-style formula elsewhere in the sheet that reads column I.

Row formatting — the background fill per column E–I (`#f4cccc` Whitecoat /
`#9900ff` Fullerton), alignment, and the Comment column's black box
border — is applied via a `batchUpdate` `repeatCell` request per
row/column-group, using the same `startRow` the values write itself just
used (from `findLogEndRow`), so it can never touch a row it didn't just
write. If that formatting call fails after the values write already
succeeded, the function still reports success (with a warning) — the
numbers are correctly in the sheet either way, just possibly uncoloured;
reporting failure there would wrongly imply nothing was written.

Requires **Editor** (not just Viewer) access to the Accounts sheet for the
shared Google service account (`sheet-budget-sync@willow-budget-sync.iam.gserviceaccount.com`)
— already granted as of this feature shipping, confirmed via the sheet's
own Share dialog (turned out this account already had Editor on Accounts,
despite every *other* thing that's touched this sheet — the
`telemed-locum-claims` skill, etc. — going through the owner's own Google
login via Composio instead).

Required secret, beyond what the other sheet-sync functions already use:
- `GOOGLE_ACCOUNTS_SHEET_ID` — the id from the Accounts sheet's URL
  (`docs.google.com/spreadsheets/d/<this>/edit`), set to
  `1qQf7-bPLkHpvVPSwAU1Mj8AXshOvdy85whs0fo61mAc`

## Calendar reading (teleconsult-check-roster)

The one place in this repo's sync architecture that *reads* Google
Calendar via the shared service account rather than via `mcp__Google_Calendar__*`
(Composio, the owner's own login) — teleconsult-tracker's "Check calendar"
button and its once-per-fresh-day auto-run. Same `verify_jwt`-on +
`WILLOW_USER_ID`-check pattern as the other user-invoked functions.

Matching mirrors the `confirm-tm-income` skill's own documented rules
exactly, so a day this function calls "rostered" agrees with how the
owner's calendar is already interpreted everywhere else in this repo: an
event summary containing "WC TM" (case-insensitive) → Whitecoat TM
rostered; containing "FHG TM" → Fullerton TM rostered; trimmed/case-folded
*exactly* "inspire medical" (not "INSPIRE COVER") → today is an Inspire
day, which drops the suggested Whitecoat TM target from $650 to $250 (the
same two figures the owner already logs against — this never invents a
third). Events are read for the target date's Singapore calendar day
specifically (`T00:00:00+08:00` to `T23:59:59+08:00` — Singapore has no
DST, so this fixed offset needs no `Intl` timezone gymnastics), since the
Edge Function runtime itself runs in UTC.

Deliberately does not overwrite a rostered toggle the owner already
changed by hand mid-session — the app only calls this automatically once,
on a genuinely fresh day (see teleconsult-tracker's own entry above). A
result the owner didn't ask for right now can't clobber one they did.

Requires the calendar shared with the service account (Viewer / "See all
event details" — this only reads) and the **Calendar API enabled** on
whichever Google Cloud project the service account belongs to — a
separate one-time toggle from the Sheets/Docs APIs the other functions
use, easy to miss since nothing else in this repo needed it yet.

Required secret, beyond what the other Google-touching functions already
use:
- `GOOGLE_CALENDAR_ID` — the owner's calendar id, which for a personal
  Google Calendar is just their email address (`weiliang93@gmail.com`)

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
connected, secrets still have to be set via the dashboard. Supabase MCP
*can* deploy function code directly (`deploy_edge_function`, project id
`fozipnpmmjmmlthkdplf`) — that part doesn't need the dashboard, only the
secrets themselves do.

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
  `telegram_poll_fast` started at a deliberate 2-second responsiveness
  tradeoff the user asked for explicitly, then got dialed back to 15s
  and then to once a minute (both Sept 2026) as bot usage narrowed to
  job-posting-keyword-watch only, trading `/exp`/`/set`/`/diary`
  responsiveness (now ~60s lag) for staying under the Edge Function
  invocation quota — check the current interval in the DB/see the
  Telegram bot section above rather than assuming any of these numbers,
  and don't change it without asking.
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
