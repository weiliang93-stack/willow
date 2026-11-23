# Agents

Read [CLAUDE.md](CLAUDE.md) first. It is the source of truth for this repo:
the apps, Supabase `app_state`, the Telegram bot, the sheet syncs, and the
rules for changing them.

## Family hub

`family-hub/` is the Loh Family Hub (Home, Calendar, Money, Anya, Docs).
After merge it is served at
https://weiliang93-stack.github.io/willow/family-hub/

Its Supabase row is `app_state.app = "familyhub"`. The Money tab is
read-only: it may `pullState("expenses")` and
`pullState("expenses_automation")` and must never push those rows, or any
other app's row. Do not add cron jobs, Edge Functions, secrets, or Google
Calendar OAuth for this app. Plain-English notes for later edits, including
the seed SQL, are in `family-hub/HANDOVER.md`.
