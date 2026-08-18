// Supabase Edge Function: sends a Telegram message when your monthly
// spend crosses 70% or 100% of your budget. Meant to be triggered by a
// Database Webhook on public.app_state (INSERT and UPDATE), configured
// in the Dashboard under Database > Webhooks.
//
// Required secrets, in addition to the ones telegram-webhook/index.ts uses:
//   DB_WEBHOOK_SECRET - a random string you invent; set the same value as
//                        a custom HTTP header (e.g. x-webhook-secret) on
//                        the Database Webhook, so this function only
//                        accepts calls that actually came from it.
//
// Requires shared/telegram-schema.sql to have been run (creates
// budget_alert_state, which tracks the last-sent tier so this only
// messages you on a genuine threshold crossing, not on every edit).

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

function tierFor(spent: number, budget: number): "none" | "warn" | "over" {
  if (budget <= 0) return "none";
  if (spent >= budget) return "over";
  if (spent >= budget * 0.7) return "warn";
  return "none";
}

Deno.serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  const payload = await req.json();
  const record = payload.record;
  // Only care about your own expenses row — ignore training/diary rows,
  // and (defensively, though this project is single-user) anyone else's.
  if (!record || record.app !== "expenses" || record.user_id !== USER_ID) {
    return new Response("ignored");
  }

  const state = record.state ?? {};
  const budget = state.monthlyBudget;
  if (typeof budget !== "number" || budget <= 0) return new Response("no budget set");

  const thisMonth = new Date().toISOString().slice(0, 7);
  const spent = (state.expenses || [])
    .filter((e: any) => typeof e.date === "string" && e.date.slice(0, 7) === thisMonth)
    .reduce((s: number, e: any) => s + e.amount, 0);

  const currentTier = tierFor(spent, budget);

  const { data: alertRow } = await supabase.from("budget_alert_state").select("tier").eq("user_id", USER_ID).maybeSingle();
  const lastTier = alertRow?.tier ?? "none";

  if (currentTier === lastTier) return new Response("no change");

  if (currentTier === "warn" || currentTier === "over") {
    const label = currentTier === "over" ? "over budget" : "at 70% of budget";
    await sendMessage(`Budget alert: $${spent.toFixed(2)} / $${budget.toFixed(2)} this month — you're ${label}.`);
  }

  await supabase
    .from("budget_alert_state")
    .upsert({ user_id: USER_ID, tier: currentTier, updated_at: new Date().toISOString() });

  return new Response("ok");
});
