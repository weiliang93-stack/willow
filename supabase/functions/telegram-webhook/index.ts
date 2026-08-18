// Supabase Edge Function: receives Telegram bot updates and logs entries
// straight into the same app_state rows the willow apps themselves read
// and write, using a fixed (single) Supabase user — this bot is for
// personal use only, not multi-user.
//
// Required secrets (Edge Functions > Manage secrets, or `supabase secrets set`):
//   TELEGRAM_BOT_TOKEN        - from @BotFather
//   TELEGRAM_WEBHOOK_SECRET   - a random string you invent; also passed as
//                               secret_token when registering the webhook with Telegram
//   TELEGRAM_CHAT_ID          - your personal chat id (messages from any other
//                               chat are silently ignored)
//   WILLOW_USER_ID            - your Supabase auth user id (Authentication > Users)
//   SUPABASE_URL              - project URL, same as shared/supabase-config.js
//   SUPABASE_SERVICE_ROLE_KEY - Settings > API > service_role key.
//                               NEVER put this key in client-side code — it
//                               bypasses Row Level Security entirely. It's
//                               only safe here because Edge Functions run
//                               server-side.
//
// Commands:
//   /exp <amount> <category> [note]   e.g. /exp 12.50 Food lunch with team
//   /set <exercise> <weight> <reps>   e.g. /set squat 60 5
//   /diary <text>                     e.g. /diary Had a great day at the gym
//   /help

import { createClient } from "npm:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")!;
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID")!;
const USER_ID = Deno.env.get("WILLOW_USER_ID")!;

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

Deno.serve(async (req) => {
  if (req.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  const update = await req.json();
  const message = update.message;
  if (!message || typeof message.text !== "string") return new Response("ok");

  // Ignore anyone but you — this bot writes into your personal data with
  // no further auth, so this check is the only thing standing between a
  // stranger who finds the bot and your expense/workout/diary data.
  if (String(message.chat.id) !== CHAT_ID) return new Response("ok");

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

  return new Response("ok");
});
