// Supabase Edge Function: sends a Telegram message when your monthly
// spend crosses 70% or 100% of your budget, or when any individual
// credit card crosses 90% or 100% of its own cap for the current billing
// cycle. Meant to be triggered on a schedule by a Database > Cron Job
// (using pg_net directly), rather than a Database Webhook on app_state —
// some projects are missing the internal supabase_functions schema that
// Database Webhooks depend on, so this checks the current state itself
// on each run instead of relying on a trigger payload. That also means
// it catches expenses added from the app UI, not just ones logged
// through the bot.
//
// Required secrets, in addition to the ones telegram-webhook/index.ts uses:
//   DB_WEBHOOK_SECRET - a random string you invent; set the same value as
//                        a custom HTTP header (e.g. x-webhook-secret) on
//                        the Cron Job's request, so this function only
//                        accepts calls that actually came from it.
//
// Requires shared/telegram-schema.sql to have been run (creates
// budget_alert_state, which tracks the last-sent tier so this only
// messages you on a genuine threshold crossing, not on every run).

import { createClient } from "npm:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID")!;
const USER_ID = Deno.env.get("WILLOW_USER_ID")!;
const WEBHOOK_SECRET = Deno.env.get("DB_WEBHOOK_SECRET")!;

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function sendMessage(text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text }),
  });
}

function tierFor(spent: number, cap: number, warnFraction: number): "none" | "warn" | "over" {
  if (cap <= 0) return "none";
  if (spent >= cap) return "over";
  if (spent >= cap * warnFraction) return "warn";
  return "none";
}

// Mirrors expense-tracker/script.js's clampedDate/getCardCycleRange exactly,
// just using UTC getters/Date.UTC instead of local-timezone Date methods
// (Deno itself always runs in UTC, so this is just being explicit about it).
function clampedDateUTC(year: number, month: number, day: number): Date {
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay)));
}

function formatDateStrUTC(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getCardCycleRange(card: any, referenceDateStr: string): { start: string; end: string } {
  const ref = new Date(referenceDateStr + "T00:00:00Z");

  if (card.resetMode === "statement" && card.statementDay) {
    const day = card.statementDay;
    let startYear = ref.getUTCFullYear();
    let startMonth = ref.getUTCMonth();
    if (ref.getUTCDate() < day) {
      startMonth -= 1;
      if (startMonth < 0) {
        startMonth = 11;
        startYear -= 1;
      }
    }
    const start = clampedDateUTC(startYear, startMonth, day);

    let endYear = startYear;
    let endMonth = startMonth + 1;
    if (endMonth > 11) {
      endMonth = 0;
      endYear += 1;
    }
    const nextStart = clampedDateUTC(endYear, endMonth, day);
    const end = new Date(nextStart);
    end.setUTCDate(end.getUTCDate() - 1);

    return { start: formatDateStrUTC(start), end: formatDateStrUTC(end) };
  }

  const start = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1));
  const end = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 0));
  return { start: formatDateStrUTC(start), end: formatDateStrUTC(end) };
}

Deno.serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  const { data: row, error } = await supabase
    .from("app_state")
    .select("state")
    .eq("user_id", USER_ID)
    .eq("app", "expenses")
    .maybeSingle();
  if (error) {
    console.error(error);
    return new Response("error reading app_state", { status: 500 });
  }
  if (!row) return new Response("no expenses data yet");

  const state = row.state ?? {};

  // Singapore local time, not UTC — see telegram-poll's todayStr comment
  // for why (this only matters right around the turn of the month/cycle).
  const todaySGT = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const { data: alertRow } = await supabase
    .from("budget_alert_state")
    .select("tier, card_tiers")
    .eq("user_id", USER_ID)
    .maybeSingle();
  const lastTier = alertRow?.tier ?? "none";
  const lastCardTiers: Record<string, string> = alertRow?.card_tiers ?? {};

  const results: string[] = [];
  let currentTier = lastTier;
  const budget = state.monthlyBudget;

  if (typeof budget === "number" && budget > 0) {
    const thisMonth = todaySGT.slice(0, 7);
    const spent = (state.expenses || [])
      .filter((e: any) => typeof e.date === "string" && e.date.slice(0, 7) === thisMonth)
      .reduce((s: number, e: any) => s + e.amount, 0);

    currentTier = tierFor(spent, budget, 0.7);
    if (currentTier !== lastTier) {
      if (currentTier === "warn" || currentTier === "over") {
        const label = currentTier === "over" ? "over budget" : "at 70% of budget";
        await sendMessage(`Budget alert: $${spent.toFixed(2)} / $${budget.toFixed(2)} this month — you're ${label}.`);
      }
      results.push(`budget: ${lastTier} -> ${currentTier}`);
    }
  }

  // Per-card caps (90% / 100%), each on its own billing-cycle window.
  const cards: any[] = state.cards || [];
  const newCardTiers: Record<string, string> = {};
  for (const card of cards) {
    if (typeof card.cap !== "number" || card.cap <= 0) continue;

    const { start, end } = getCardCycleRange(card, todaySGT);
    const spent = (state.expenses || [])
      .filter((e: any) => e.cardId === card.id && typeof e.date === "string" && e.date >= start && e.date <= end)
      .reduce((s: number, e: any) => s + e.amount, 0);

    const tier = tierFor(spent, card.cap, 0.9);
    newCardTiers[card.id] = tier;

    const lastCardTier = lastCardTiers[card.id] ?? "none";
    if (tier !== lastCardTier) {
      if (tier === "warn" || tier === "over") {
        const label = tier === "over" ? "over its cap" : "at 90% of its cap";
        await sendMessage(`Card alert: ${card.name} $${spent.toFixed(2)} / $${card.cap.toFixed(2)} this cycle — ${label}.`);
      }
      results.push(`card ${card.name}: ${lastCardTier} -> ${tier}`);
    }
  }

  if (results.length === 0) return new Response("no change");

  await supabase
    .from("budget_alert_state")
    .upsert({ user_id: USER_ID, tier: currentTier, card_tiers: newCardTiers, updated_at: new Date().toISOString() });

  return new Response(results.join("; "));
});
