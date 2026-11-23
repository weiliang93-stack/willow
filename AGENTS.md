# Agents

Read [CLAUDE.md](CLAUDE.md) first. It is the source of truth for this repo:
the apps, Supabase `app_state`, the Telegram bot, the sheet syncs, and the
rules for changing them.

## Family hub

`family-hub/` is the Loh Family Hub (Home, Calendar, Money, Anya, Docs).
After merge it is served at
https://weiliang93-stack.github.io/willow/family-hub/

Its Supabase row is `app_state.app = "familyhub"`. The Money tab is
read-only and shows combined household spend (`type === "combined"`)
against `combinedMonthlyBudget`. It may `pullState("expenses")` and
`pullState("expenses_automation")` and must never push those rows.
`family-calendar` is an on-demand Edge Function; its iCal secret
`FAMILY_CAL_ICS_URL` is never committed. No cron and no Google OAuth
client. Plain-English notes: `family-hub/HANDOVER.md`.
