# Agents

Read [CLAUDE.md](CLAUDE.md) first. It is the source of truth for this repo:
the apps, Supabase `app_state`, the Telegram bot, the sheet syncs, and the
rules for changing them.

## Family hub

`family-hub/` is the Loh Family Hub (Home, Calendar, Money, Kids, Docs).
The Kids tab switches between Anya and Yuna. After merge it is served at
https://weiliang93-stack.github.io/willow/family-hub/

Its Supabase row is `app_state.app = "familyhub"`. Variable household
spend is read-only: `type === "combined"` against `combinedMonthlyBudget`,
with a link to the Household Expenses sheet. Fixed monthly costs are a
read-only copy of the TeoLoh sheet, written only by `sync-fixed-costs`
into `state.fixedCosts`, and the Insurance tab into `state.insurance`
(no policy numbers, in the app or in git). Condo, car, childcare, net
worth, annual dates, and folder links are further fields on that row.
Children live on `state.kids`, migrated from the older `state.anya` keys.
It may `pullState("expenses")`
and `pullState("expenses_automation")` and must never push those rows.
`family-calendar` is an on-demand Edge Function; its iCal secret
`FAMILY_CAL_ICS_URL` is never committed. The fixed-cost cron is scheduled
by hand and is not committed. No Google OAuth client. Plain-English
notes: `family-hub/HANDOVER.md`.
