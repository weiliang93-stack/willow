// Supabase Edge Function: polls Telegram for new messages and logs
// entries straight into the same app_state rows the willow apps
// themselves read and write, using a fixed (single) Supabase user — this
// bot is for personal use only, not multi-user.
//
// This polls instead of receiving a Telegram webhook push. Inbound
// webhook delivery from Telegram's servers to this project's Edge
// Functions was blocked at the network/edge level — confirmed by
// pointing the webhook at an external inspector (webhook.site), which
// received Telegram's request correctly and instantly, while the exact
// same message never reached this project's functions.supabase.co
// endpoint at all (getWebhookInfo showed a raw 401 that this function's
// own code never produces, meaning something in front of it rejected
// the request before our code ran). Likely a bot-protection/WAF layer
// blocking Telegram's server traffic specifically. Polling only needs
// outbound requests from Supabase to Telegram, which works fine, so
// this sidesteps the problem entirely — at the cost of up to ~1 minute
// of latency instead of an instant push.
//
// Meant to be triggered every minute by a Database > Cron Job (using
// pg_net directly), the same way budget-alert is.
//
// Required secrets:
//   TELEGRAM_BOT_TOKEN        - from @BotFather
//   TELEGRAM_CHAT_ID          - your personal chat id (messages from any other
//                               chat are silently ignored)
//   WILLOW_USER_ID            - your Supabase auth user id (Authentication > Users)
//   DB_WEBHOOK_SECRET         - the same random string used for budget-alert's
//                               Cron Job; reused here to protect this function's
//                               URL from random callers the same way
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY - auto-injected by Supabase, no
//                               need to set these yourself
//
// Requires shared/telegram-schema.sql to have been run (creates
// telegram_poll_state, which tracks the last processed Telegram update
// id so the same message isn't logged twice).
//
// IMPORTANT: Telegram will not deliver updates to getUpdates while a
// webhook is registered — call deleteWebhook once before using this.
//
// Commands:
//   /exp <amount> <category> [note]   e.g. /exp 12.50 Food lunch with team
//   /set <exercise> <weight> <reps>   e.g. /set squat 60 5
//   /diary <text>                     e.g. /diary Had a great day at the gym
//   /help

import { createClient } from "npm:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID")!;
const USER_ID = Deno.env.get("WILLOW_USER_ID")!;
const CALL_SECRET = Deno.env.get("DB_WEBHOOK_SECRET")!;

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

async function sendMessage(text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text }),
  });
}

async function getAppState(app: string): Promise<any> {
  const { data, error } = await supabase.from("app_state").select("state").eq("user_id", USER_ID).eq("app", app).maybeSingle();
  if (error) throw error;
  return data?.state ?? null;
}

async function setAppState(app: string, state: unknown) {
  const { error } = await supabase
    .from("app_state")
    .upsert({ user_id: USER_ID, app, state, updated_at: new Date().toISOString() });
  if (error) throw error;
}

async function logExpense(amount: number, category: string, note: string) {
  const state =
    (await getAppState("expenses")) ??
    ({
      cards: [],
      expenses: [],
      categories: ["Food", "Transport", "Shopping", "Bills", "Entertainment", "Other"],
      monthlyBudget: null,
    } as any);

  const categories: string[] = state.categories || [];
  const matched = categories.find((c) => c.toLowerCase() === category.toLowerCase());
  const resolvedCategory = matched || categories[categories.length - 1] || "Other";

  state.expenses = state.expenses || [];
  state.expenses.push({ id: uid(), amount, category: resolvedCategory, cardId: "cash", date: todayStr(), note });
  await setAppState("expenses", state);

  const thisMonth = todayStr().slice(0, 7);
  const spent = state.expenses
    .filter((e: any) => e.date.slice(0, 7) === thisMonth)
    .reduce((s: number, e: any) => s + e.amount, 0);
  const budgetLine =
    typeof state.monthlyBudget === "number" ? ` — $${spent.toFixed(2)} / $${state.monthlyBudget.toFixed(2)} this month` : "";

  return `Logged $${amount.toFixed(2)} · ${resolvedCategory}${note ? ` · ${note}` : ""}${budgetLine}`;
}

async function logWorkoutSet(exercise: string, weight: string, reps: string) {
  const state =
    (await getAppState("training")) ??
    ({
      done: {},
      actualWeight: {},
      actualReps: {},
      rpe: {},
      order: [0, 1, 2, 3, 4, 5, 6],
      log: [],
      exerciseOverrides: {},
      customExercises: {},
      deletedExercises: {},
      weekKey: null,
      restEndTime: null,
    } as any);

  state.log = state.log || [];
  state.log.push({
    id: uid(),
    date: todayStr(),
    templateIdx: -1,
    day: "Bot",
    dayFull: "Logged via Telegram",
    focus: "Quick log",
    exIdx: -1,
    exercise,
    setNumber: 1,
    weight,
    reps,
    rpe: "",
  });
  await setAppState("training", state);

  return `Logged ${exercise}: ${weight}kg × ${reps} reps`;
}

async function logDiaryEntry(text: string) {
  const state = (await getAppState("diary")) ?? ({ entries: [] } as any);
  state.entries = state.entries || [];

  const now = new Date().toISOString();
  const firstLineBreak = text.indexOf("\n");
  const title = firstLineBreak === -1 ? text.slice(0, 60) : text.slice(0, firstLineBreak);

  state.entries.push({
    id: uid(),
    date: todayStr(),
    title,
    body: text,
    attachments: [],
    createdAt: now,
    updatedAt: now,
  });
  await setAppState("diary", state);

  return `Diary entry added for ${todayStr()}`;
}

type ParsedCommand =
  | { kind: "expense"; amount: number; category: string; note: string }
  | { kind: "set"; exercise: string; weight: string; reps: string }
  | { kind: "diary"; text: string }
  | { kind: "help" }
  | { kind: "unknown" };

function parseCommand(text: string): ParsedCommand {
  const trimmed = text.trim();

  const expMatch = trimmed.match(/^\/exp(?:ense)?\s+([\d.]+)\s+(\S+)\s*(.*)$/is);
  if (expMatch) {
    return { kind: "expense", amount: parseFloat(expMatch[1]), category: expMatch[2], note: expMatch[3].trim() };
  }

  const setMatch = trimmed.match(/^\/set\s+(\S+)\s+([\d.]+)\s+(\d+)\s*$/i);
  if (setMatch) {
    return { kind: "set", exercise: setMatch[1], weight: setMatch[2], reps: setMatch[3] };
  }

  const diaryMatch = trimmed.match(/^\/diary\s+([\s\S]+)$/i);
  if (diaryMatch) {
    return { kind: "diary", text: diaryMatch[1].trim() };
  }

  if (/^\/help/i.test(trimmed)) return { kind: "help" };

  return { kind: "unknown" };
}

const HELP_TEXT = [
  "Commands:",
  "/exp <amount> <category> [note] — e.g. /exp 12.50 Food lunch with team",
  "/set <exercise> <weight> <reps> — e.g. /set squat 60 5",
  "/diary <text> — e.g. /diary Had a great day at the gym",
].join("\n");

async function getOffset(): Promise<number> {
  const { data } = await supabase.from("telegram_poll_state").select("last_update_id").eq("id", 1).maybeSingle();
  return data?.last_update_id ?? 0;
}

async function setOffset(id: number) {
  await supabase.from("telegram_poll_state").upsert({ id: 1, last_update_id: id, updated_at: new Date().toISOString() });
}

async function processMessage(message: any) {
  if (!message || typeof message.text !== "string") return;

  // Ignore anyone but you — this bot writes into your personal data with
  // no further auth, so this check is the only thing standing between a
  // stranger who finds the bot and your expense/workout/diary data.
  if (String(message.chat.id) !== CHAT_ID) return;

  const parsed = parseCommand(message.text);
  try {
    let reply: string;
    switch (parsed.kind) {
      case "expense":
        reply = await logExpense(parsed.amount, parsed.category, parsed.note);
        break;
      case "set":
        reply = await logWorkoutSet(parsed.exercise, parsed.weight, parsed.reps);
        break;
      case "diary":
        reply = await logDiaryEntry(parsed.text);
        break;
      case "help":
        reply = HELP_TEXT;
        break;
      default:
        reply = `Didn't recognize that.\n\n${HELP_TEXT}`;
    }
    await sendMessage(reply);
  } catch (err) {
    console.error(err);
    await sendMessage(`Something went wrong: ${err instanceof Error ? err.message : String(err)}`);
  }
}

Deno.serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== CALL_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  const offset = await getOffset();
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${offset + 1}&timeout=0`);
  const data = await res.json();
  if (!data.ok) {
    console.error("getUpdates failed", data);
    return new Response("getUpdates failed", { status: 500 });
  }

  const updates = data.result as any[];
  for (const update of updates) {
    await processMessage(update.message);
  }

  if (updates.length > 0) {
    const maxId = Math.max(...updates.map((u: any) => u.update_id));
    await setOffset(maxId);
  }

  return new Response(`processed ${updates.length}`);
});
