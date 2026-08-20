// Supabase Edge Function: polls Telegram for new messages/button taps and
// logs entries straight into the same app_state rows the willow apps
// themselves read and write, using a fixed (single) Supabase user — this
// bot is for personal use only, not multi-user.
//
// Polls instead of receiving a Telegram webhook push — see the comment
// history on this function (or PR #64) for why: inbound webhook delivery
// from Telegram's servers was blocked at Supabase's network edge on this
// project, confirmed via an external inspector (webhook.site) receiving
// the exact same request correctly while it never reached this endpoint.
//
// Each invocation does a single quick check and exits (previously it
// looped internally for ~100s — reverted, see PR history: Supabase's
// pg_net hard-caps HTTP call timeouts at 5 seconds regardless of what's
// requested, so a cron-triggered call was never actually able to wait
// for a 100s-long response; the invocation was getting cut short every
// time). Responsiveness now comes entirely from firing the cron trigger
// itself frequently (every few seconds) via pg_cron's interval-based
// scheduling — see shared/telegram-schema.sql and the setup notes for
// the cron SQL, which has to be run directly rather than through the
// dashboard's cron-expression-only form.
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
// telegram_poll_state and telegram_session_state).
//
// IMPORTANT: Telegram will not deliver updates to getUpdates while a
// webhook is registered — call deleteWebhook once before using this.
//
// Commands (power-user, single message, logs immediately):
//   /exp <amount> [category] [payment] [note]   e.g. /exp 12.50 Food Amex lunch with team
//   /set <exercise> <weight> <reps>             e.g. /set squat 60 5
//   /diary <text>                               e.g. /diary Had a great day at the gym
//
// Guided flows (button taps, walks you through it):
//   /exp    - asks amount (add a note after it in the same reply if you
//             want one, e.g. "12.50 lunch with team"), then category as
//             tappable buttons, then payment method as tappable buttons
//             (pulled live from your actual expense-tracker categories
//             and cards) — logs immediately once payment is picked, no
//             separate note step
//   /set    - shows today's planned exercises (from training-app's
//             schedule, respecting day-swaps) as buttons, then which
//             set, offering "same as planned" / "same as last time"
//             quick-fill, then asks RPE. On a rest day, offers to log an
//             ad-hoc exercise instead (same as today's day-view does)
//   /help

import { createClient } from "npm:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID")!;
const USER_ID = Deno.env.get("WILLOW_USER_ID")!;
const CALL_SECRET = Deno.env.get("DB_WEBHOOK_SECRET")!;

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const SESSION_STALE_MS = 15 * 60 * 1000;

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Singapore local time, not UTC — Edge Functions run in UTC, and without
// this, anything logged between midnight and 8am SGT would land on the
// previous day.
function todayStr() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Monday-indexed 0-6 (matches training-app's todayIndex()), computed in
// Singapore local time.
function todaySlotIndex() {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Singapore", weekday: "short" }).format(new Date());
  const order = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return order.indexOf(weekday);
}

type Keyboard = { text: string; data: string }[][];

async function sendMessage(text: string, keyboard?: Keyboard) {
  const body: Record<string, unknown> = { chat_id: CHAT_ID, text };
  if (keyboard) {
    body.reply_markup = { inline_keyboard: keyboard.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) };
  }
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function answerCallback(callbackQueryId: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
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

// ---------------------------------------------------------------------
// Conversation session (tracks where you are in a guided /exp or /set flow)
// ---------------------------------------------------------------------

type Session = { flow: string | null; step: string | null; data: any; updatedAt: string | null };

async function getSession(): Promise<Session> {
  const { data } = await supabase.from("telegram_session_state").select("flow, step, data, updated_at").eq("id", 1).maybeSingle();
  if (!data) return { flow: null, step: null, data: {}, updatedAt: null };
  if (data.flow && data.updated_at && Date.now() - new Date(data.updated_at).getTime() > SESSION_STALE_MS) {
    return { flow: null, step: null, data: {}, updatedAt: null };
  }
  return { flow: data.flow, step: data.step, data: data.data || {}, updatedAt: data.updated_at };
}

async function setSession(flow: string | null, step: string | null, data: any) {
  await supabase
    .from("telegram_session_state")
    .upsert({ id: 1, flow, step, data, updated_at: new Date().toISOString() });
}

async function clearSession() {
  await setSession(null, null, {});
}

// ---------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------

const DEFAULT_EXPENSE_STATE = {
  cards: [],
  expenses: [],
  categories: ["Food", "Transport", "Shopping", "Bills", "Entertainment", "Other"],
  monthlyBudget: null,
};

// Pushes the expense into state, saves it, and returns the "$spent /
// $budget this month" suffix (or "" if no budget is set) — shared by
// every logging path below so the push/save/budget-line logic lives
// in one place.
async function recordExpense(state: any, amount: number, category: string, cardId: string, note: string): Promise<string> {
  state.expenses = state.expenses || [];
  state.expenses.push({ id: uid(), amount, category, cardId, date: todayStr(), note });
  await setAppState("expenses", state);

  const thisMonth = todayStr().slice(0, 7);
  const spent = state.expenses
    .filter((e: any) => e.date.slice(0, 7) === thisMonth)
    .reduce((s: number, e: any) => s + e.amount, 0);
  return typeof state.monthlyBudget === "number" ? ` — $${spent.toFixed(2)} / $${state.monthlyBudget.toFixed(2)} this month` : "";
}

// Matches the longest possible word-prefix of `words` against
// `candidates` (case-insensitive, so multi-word names like "Chase
// Sapphire" or a two-word category still match as one unit). Returns
// the canonical candidate string and the remaining words, or null.
function matchLongestPrefix(words: string[], candidates: string[]): { matched: string; rest: string[] } | null {
  for (let len = Math.min(words.length, 4); len >= 1; len--) {
    const candidate = words.slice(0, len).join(" ");
    const found = candidates.find((c) => c.toLowerCase() === candidate.toLowerCase());
    if (found) return { matched: found, rest: words.slice(len) };
  }
  return null;
}

// Immediate single-message logging: /exp <amount> [category] [payment] [note]
// `rest` is everything after the amount — greedily matched against known
// category and payment-method names (in that order) so e.g.
// "/exp 12.50 Food Amex lunch with team" resolves category=Food,
// payment=Amex, note="lunch with team". Unmatched leading words are left
// in the note rather than guessed at.
async function logExpenseOneShot(amount: number, rest: string) {
  const state = (await getAppState("expenses")) ?? { ...DEFAULT_EXPENSE_STATE };
  const categories: string[] = state.categories?.length ? state.categories : DEFAULT_EXPENSE_STATE.categories;
  const payments = paymentOptions(state);

  let words = rest.split(/\s+/).filter(Boolean);

  const catMatch = matchLongestPrefix(words, categories);
  const category = catMatch?.matched ?? categories[categories.length - 1] ?? "Other";
  if (catMatch) words = catMatch.rest;

  let cardId = "cash";
  const payMatch = matchLongestPrefix(words, payments.map((p) => p.label));
  if (payMatch) {
    words = payMatch.rest;
    cardId = payments.find((p) => p.label.toLowerCase() === payMatch.matched.toLowerCase())?.id ?? "cash";
  } else if (words[0]?.toLowerCase() === "cash") {
    words = words.slice(1);
  }

  const note = words.join(" ");
  const budgetLine = await recordExpense(state, amount, category, cardId, note);
  await sendMessage(`Logged $${amount.toFixed(2)} · ${category}${note ? ` · ${note}` : ""}${budgetLine}`);
}

function paymentOptions(state: any): { label: string; id: string }[] {
  const cards: any[] = state.cards || [];
  return [{ label: "Cash / Other", id: "cash" }, ...cards.map((c: any) => ({ label: c.name, id: c.id }))];
}

async function startExpenseFlow(amount?: number) {
  if (amount != null) {
    await promptExpenseCategory(amount, "");
  } else {
    await setSession("exp", "awaiting_amount", {});
    await sendMessage('How much did you spend? (add a note after the amount if you like, e.g. "12.50 lunch with team")');
  }
}

async function promptExpenseCategory(amount: number, note: string) {
  const state = (await getAppState("expenses")) ?? { ...DEFAULT_EXPENSE_STATE };
  const categories: string[] = state.categories?.length ? state.categories : DEFAULT_EXPENSE_STATE.categories;
  await setSession("exp", "awaiting_category", { amount, note, categories });
  const keyboard: Keyboard = [];
  for (let i = 0; i < categories.length; i += 2) {
    keyboard.push(categories.slice(i, i + 2).map((c, j) => ({ text: c, data: `exp:cat:${i + j}` })));
  }
  await sendMessage("Category?", keyboard);
}

async function promptExpensePayment(amount: number, category: string, note: string) {
  const state = (await getAppState("expenses")) ?? { ...DEFAULT_EXPENSE_STATE };
  const payments = paymentOptions(state);
  await setSession("exp", "awaiting_payment", { amount, category, note, payments });
  const keyboard: Keyboard = payments.map((p, i) => [{ text: p.label, data: `exp:pay:${i}` }]);
  await sendMessage("Payment method?", keyboard);
}

async function finishExpense(amount: number, category: string, cardId: string, cardLabel: string, note: string) {
  const state = (await getAppState("expenses")) ?? { ...DEFAULT_EXPENSE_STATE };
  const budgetLine = await recordExpense(state, amount, category, cardId, note);
  await sendMessage(
    `Logged $${amount.toFixed(2)} · ${category} · ${cardLabel}${note ? ` · ${note}` : ""}${budgetLine}`,
    [[{ text: "Log another expense", data: "exp:restart" }]]
  );
  await clearSession();
}

// ---------------------------------------------------------------------
// Training — mirrors training-app/script.js's own resolution logic
// (contentFor / exercisesFor / effectiveEx / visibleExercises / key),
// operating on the `templates` field training-app now includes in its
// synced state specifically so the bot can do this server-side.
// ---------------------------------------------------------------------

const DEFAULT_TRAINING_STATE = {
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
  templates: null,
};

function resolveTodayExercises(state: any) {
  const templates = state.templates;
  if (!Array.isArray(templates) || templates.length !== 7) return null; // not synced yet

  const order: number[] = Array.isArray(state.order) && state.order.length === 7 ? state.order : [0, 1, 2, 3, 4, 5, 6];
  const slotIdx = todaySlotIndex();
  const templateIdx = order[slotIdx];
  const template = templates[templateIdx];
  const focus = template?.focus ?? "Workout";

  const base = template?.exercises ?? [];
  const custom = state.customExercises?.[templateIdx] ?? [];
  const combined = [...base, ...custom];

  const overrides = state.exerciseOverrides || {};
  const deleted = state.deletedExercises || {};

  const exercises = combined
    .map((baseEx: any, exIdx: number) => {
      const override = overrides[`${templateIdx}-${exIdx}`];
      const ex = override ? { ...baseEx, ...override } : baseEx;
      return { exIdx, name: ex.name, sets: ex.sets, reps: ex.reps, weight: ex.weight || null };
    })
    .filter((_: any, exIdx: number) => !deleted[`${templateIdx}-${exIdx}`]);

  return { templateIdx, focus, exercises };
}

function trainingKey(templateIdx: number, exIdx: number, setIdx: number) {
  return `${templateIdx}-${exIdx}-${setIdx}`;
}

// Most recent past log entry for this exercise+set, for the "same as
// last time" quick-fill.
function findLastLogged(state: any, exerciseName: string, setNumber: number) {
  const log: any[] = state.log || [];
  const matches = log
    .filter((e) => e.exercise === exerciseName && e.setNumber === setNumber && e.weight)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return matches.length ? matches[matches.length - 1] : null;
}

async function startSetFlow() {
  const state = (await getAppState("training")) ?? { ...DEFAULT_TRAINING_STATE };
  const resolved = resolveTodayExercises(state);

  if (!resolved) {
    await sendMessage(
      "Can't see today's plan yet — open training-app once on your phone so it syncs your workout schedule to the cloud, then try /set again."
    );
    return;
  }

  if (resolved.exercises.length === 0) {
    await setSession("set", "rest_day_offer", {});
    await sendMessage(`Rest day — no workout scheduled (${resolved.focus}).`, [
      [{ text: "Log an exercise anyway", data: "set:adhoc_start" }],
    ]);
    return;
  }

  await promptExercisePicker(resolved.templateIdx, resolved.focus, resolved.exercises);
}

async function promptExercisePicker(templateIdx: number, focus: string, exercises: any[]) {
  await setSession("set", "awaiting_exercise", { templateIdx, focus, exercises });
  const keyboard: Keyboard = exercises.map((ex, i) => [
    { text: `${ex.name} — ${ex.sets}×${ex.reps}`, data: `set:ex:${i}` },
  ]);
  await sendMessage(`${focus} — pick an exercise:`, keyboard);
}

async function promptSetPicker(templateIdx: number, focus: string, exercises: any[], exIdx: number) {
  const ex = exercises.find((e: any) => e.exIdx === exIdx);
  await setSession("set", "awaiting_set", { templateIdx, focus, exercises, exIdx });
  const keyboard: Keyboard = [];
  for (let i = 1; i <= ex.sets; i++) keyboard.push([{ text: `Set ${i}`, data: `set:setnum:${i}` }]);
  await sendMessage(`${ex.name} (${ex.sets}×${ex.reps}) — which set?`, keyboard);
}

async function promptWeightReps(templateIdx: number, focus: string, exercises: any[], exIdx: number, setNumber: number) {
  const ex = exercises.find((e: any) => e.exIdx === exIdx);
  const trainingState = (await getAppState("training")) ?? { ...DEFAULT_TRAINING_STATE };
  const last = findLastLogged(trainingState, ex.name, setNumber);

  await setSession("set", "awaiting_weight_reps", { templateIdx, focus, exercises, exIdx, setNumber });

  // Each shortcut gets its own row — putting them side by side crams two
  // long labels into half-width buttons and Telegram truncates the text.
  const rows: Keyboard = [];
  if (ex.weight && ex.reps) rows.push([{ text: `Same as planned (${ex.weight}, ${ex.reps} reps)`, data: "set:wr:planned" }]);
  if (last) {
    const lastRpe = last.rpe ? ` RPE ${last.rpe}` : "";
    rows.push([{ text: `Same as last time (${last.weight}kg × ${last.reps})${lastRpe}`, data: "set:wr:last" }]);
  }

  await sendMessage(
    `${ex.name} Set ${setNumber} — send weight and reps (e.g. "60 5")${rows.length ? ", or tap a shortcut:" : ""}`,
    rows.length ? rows : undefined
  );
}

async function promptRpe(sessionData: any, weight: string, reps: string) {
  await setSession("set", "awaiting_rpe", { ...sessionData, weight, reps });

  let hint = "";
  const ex = sessionData.exercises?.find((e: any) => e.exIdx === sessionData.exIdx);
  if (ex) {
    const trainingState = (await getAppState("training")) ?? { ...DEFAULT_TRAINING_STATE };
    const last = findLastLogged(trainingState, ex.name, sessionData.setNumber);
    if (last?.rpe) hint = ` (last time: RPE ${last.rpe})`;
  }

  await sendMessage(`RPE?${hint} (1-10, or tap Skip)`, [[{ text: "Skip", data: "set:rpe_skip" }]]);
}

async function finishSet(sessionData: any, weight: string, reps: string, rpe: string) {
  const { templateIdx, focus, exercises, exIdx, setNumber } = sessionData;
  const ex = exercises.find((e: any) => e.exIdx === exIdx);
  const state = (await getAppState("training")) ?? { ...DEFAULT_TRAINING_STATE };

  const k = trainingKey(templateIdx, exIdx, setNumber - 1);
  state.done = state.done || {};
  state.actualWeight = state.actualWeight || {};
  state.actualReps = state.actualReps || {};
  state.rpe = state.rpe || {};
  state.log = state.log || [];

  state.done[k] = true;
  state.actualWeight[k] = weight;
  state.actualReps[k] = reps;
  if (rpe) state.rpe[k] = rpe;

  state.log.push({
    id: uid(),
    date: todayStr(),
    templateIdx,
    day: "Bot",
    dayFull: "Logged via Telegram",
    focus,
    exIdx,
    exercise: ex.name,
    setNumber,
    weight,
    reps,
    rpe,
  });

  await setAppState("training", state);
  await sendMessage(`Logged ${ex.name} Set ${setNumber}: ${weight}kg × ${reps}${rpe ? ` · RPE ${rpe}` : ""}`, [
    [
      { text: "Log another set", data: "set:cont_same" },
      { text: "Different exercise", data: "set:cont_new" },
    ],
    [{ text: "Done", data: "set:cont_done" }],
  ]);
  // Keep exIdx around so "Log another set" (set:cont_same) knows which
  // exercise to return the set-picker for.
  await setSession("set", "awaiting_continuation", { templateIdx, focus, exercises, exIdx });
}

// Ad-hoc (rest day) logging — appends to the log only, same as the old
// single-message /set path, since there's no template slot to address.
async function finishAdhocSet(exerciseName: string, weight: string, reps: string, rpe: string) {
  const state = (await getAppState("training")) ?? { ...DEFAULT_TRAINING_STATE };
  state.log = state.log || [];
  state.log.push({
    id: uid(),
    date: todayStr(),
    templateIdx: -1,
    day: "Bot",
    dayFull: "Logged via Telegram",
    focus: "Quick log",
    exIdx: -1,
    exercise: exerciseName,
    setNumber: 1,
    weight,
    reps,
    rpe,
  });
  await setAppState("training", state);
  await sendMessage(`Logged ${exerciseName}: ${weight}kg × ${reps}${rpe ? ` · RPE ${rpe}` : ""}`);
  await clearSession();
}

// Immediate single-message logging: /set <exercise> <weight> <reps>
async function logSetOneShot(exercise: string, weight: string, reps: string) {
  const state = (await getAppState("training")) ?? { ...DEFAULT_TRAINING_STATE };
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
  await sendMessage(`Logged ${exercise}: ${weight}kg × ${reps}`);
}

// ---------------------------------------------------------------------
// Diary
// ---------------------------------------------------------------------

async function logDiaryEntry(text: string) {
  const state = (await getAppState("diary")) ?? { entries: [] };
  state.entries = state.entries || [];

  const now = new Date().toISOString();
  const firstLineBreak = text.indexOf("\n");
  const title = firstLineBreak === -1 ? text.slice(0, 60) : text.slice(0, firstLineBreak);

  state.entries.push({ id: uid(), date: todayStr(), title, body: text, attachments: [], createdAt: now, updatedAt: now });
  await setAppState("diary", state);
  await sendMessage(`Diary entry added for ${todayStr()}`);
}

// ---------------------------------------------------------------------
// Job-posting watcher — scans messages in any group/channel this bot has
// been added to (never your own DM with it) for keyword matches, and
// alerts you here. Requires group privacy mode disabled via @BotFather
// (see setup notes) so the bot actually receives regular group messages,
// not just ones that @-mention it.
// ---------------------------------------------------------------------

async function getJobKeywords(): Promise<string[]> {
  const { data } = await supabase.from("telegram_job_watch").select("keywords").eq("id", 1).maybeSingle();
  return data?.keywords ?? [];
}

async function setJobKeywords(keywords: string[]) {
  await supabase.from("telegram_job_watch").upsert({ id: 1, keywords, updated_at: new Date().toISOString() });
}

async function addJobKeyword(keyword: string) {
  const keywords = await getJobKeywords();
  if (keywords.some((k) => k.toLowerCase() === keyword.toLowerCase())) {
    await sendMessage(`Already watching for "${keyword}".`);
    return;
  }
  keywords.push(keyword);
  await setJobKeywords(keywords);
  await sendMessage(`Added "${keyword}". Watching for: ${keywords.join(", ")}`);
}

async function removeJobKeyword(keyword: string) {
  const keywords = await getJobKeywords();
  const next = keywords.filter((k) => k.toLowerCase() !== keyword.toLowerCase());
  if (next.length === keywords.length) {
    await sendMessage(`Wasn't watching for "${keyword}".`);
    return;
  }
  await setJobKeywords(next);
  await sendMessage(next.length ? `Removed "${keyword}". Watching for: ${next.join(", ")}` : `Removed "${keyword}". No keywords left.`);
}

async function listJobKeywords() {
  const keywords = await getJobKeywords();
  await sendMessage(keywords.length ? `Watching for: ${keywords.join(", ")}` : "No keywords set. Add one with /addkeyword <text>");
}

// Deep link to jump straight to the matched message, where Telegram's
// link format allows it (public chats with a @username, or supergroups
// via their internal /c/ link — regular private groups without a
// username can't be linked to directly).
function buildMessageLink(message: any): string | null {
  const chat = message.chat;
  if (chat.username) return `https://t.me/${chat.username}/${message.message_id}`;
  if (typeof chat.id === "number" && chat.id < 0) {
    const internalId = String(chat.id).replace(/^-100/, "");
    if (internalId !== String(chat.id)) return `https://t.me/c/${internalId}/${message.message_id}`;
  }
  return null;
}

async function checkJobKeywords(message: any) {
  if (!message || typeof message.text !== "string") return;
  if (String(message.chat.id) === CHAT_ID) return; // never scan your own DM with the bot

  const keywords = await getJobKeywords();
  if (keywords.length === 0) return;

  const lower = message.text.toLowerCase();
  const matched = keywords.filter((k) => lower.includes(k.toLowerCase()));
  if (matched.length === 0) return;

  const chatTitle = message.chat.title || message.chat.username || "a monitored chat";
  const link = buildMessageLink(message);
  const snippet = message.text.length > 500 ? `${message.text.slice(0, 500)}…` : message.text;

  await sendMessage(
    `Job match in ${chatTitle} (matched: ${matched.join(", ")}):\n\n${snippet}${link ? `\n\n${link}` : ""}`
  );
}

// ---------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------

type ParsedCommand =
  | { kind: "expense"; amount: number; rest: string }
  | { kind: "expense_flow"; amount?: number }
  | { kind: "set"; exercise: string; weight: string; reps: string }
  | { kind: "set_flow" }
  | { kind: "diary"; text: string }
  | { kind: "add_keyword"; keyword: string }
  | { kind: "remove_keyword"; keyword: string }
  | { kind: "list_keywords" }
  | { kind: "help" }
  | { kind: "unknown" };

function parseCommand(text: string): ParsedCommand {
  const trimmed = text.trim();

  const expFullMatch = trimmed.match(/^\/exp(?:ense)?\s+\$?([\d.]+)\s+(.+)$/is);
  if (expFullMatch) {
    return { kind: "expense", amount: parseFloat(expFullMatch[1]), rest: expFullMatch[2].trim() };
  }
  const expAmountOnlyMatch = trimmed.match(/^\/exp(?:ense)?\s+\$?([\d.]+)\s*$/i);
  if (expAmountOnlyMatch) return { kind: "expense_flow", amount: parseFloat(expAmountOnlyMatch[1]) };
  if (/^\/exp(?:ense)?\s*$/i.test(trimmed)) return { kind: "expense_flow" };

  const setFullMatch = trimmed.match(/^\/set\s+(\S+)\s+([\d.]+)\s+(\d+)\s*$/i);
  if (setFullMatch) return { kind: "set", exercise: setFullMatch[1], weight: setFullMatch[2], reps: setFullMatch[3] };
  if (/^\/set\s*$/i.test(trimmed)) return { kind: "set_flow" };

  const diaryMatch = trimmed.match(/^\/diary\s+([\s\S]+)$/i);
  if (diaryMatch) return { kind: "diary", text: diaryMatch[1].trim() };

  const addKeywordMatch = trimmed.match(/^\/addkeyword\s+([\s\S]+)$/i);
  if (addKeywordMatch) return { kind: "add_keyword", keyword: addKeywordMatch[1].trim() };

  const removeKeywordMatch = trimmed.match(/^\/removekeyword\s+([\s\S]+)$/i);
  if (removeKeywordMatch) return { kind: "remove_keyword", keyword: removeKeywordMatch[1].trim() };

  if (/^\/keywords\s*$/i.test(trimmed)) return { kind: "list_keywords" };

  if (/^\/help/i.test(trimmed)) return { kind: "help" };

  return { kind: "unknown" };
}

const HELP_TEXT = [
  "Commands:",
  "/exp <amount> [category] [payment] [note] — log instantly, e.g. /exp 12.50 Food Amex lunch",
  '/exp — guided: amount (add a note after it, e.g. "12.50 lunch"), then tap category, then tap payment method',
  "/set <exercise> <weight> <reps> — log instantly, e.g. /set squat 60 5",
  "/set — guided: today's planned exercises as buttons, then which set, then weight/reps/RPE",
  "/diary <text> — e.g. /diary Had a great day at the gym",
  "/addkeyword <text> — watch group/channel chats for this, e.g. /addkeyword frontend engineer",
  "/removekeyword <text> — stop watching for it",
  "/keywords — list what you're watching for",
].join("\n");

// ---------------------------------------------------------------------
// Update handling
// ---------------------------------------------------------------------

async function handleCommand(parsed: ParsedCommand) {
  switch (parsed.kind) {
    case "expense":
      await clearSession();
      await logExpenseOneShot(parsed.amount, parsed.rest);
      break;
    case "expense_flow":
      await startExpenseFlow(parsed.amount);
      break;
    case "set":
      await clearSession();
      await logSetOneShot(parsed.exercise, parsed.weight, parsed.reps);
      break;
    case "set_flow":
      await startSetFlow();
      break;
    case "diary":
      await clearSession();
      await logDiaryEntry(parsed.text);
      break;
    case "add_keyword":
      await addJobKeyword(parsed.keyword);
      break;
    case "remove_keyword":
      await removeJobKeyword(parsed.keyword);
      break;
    case "list_keywords":
      await listJobKeywords();
      break;
    case "help":
      await sendMessage(HELP_TEXT);
      break;
    default:
      await sendMessage(`Didn't recognize that.\n\n${HELP_TEXT}`);
  }
}

async function handleFlowMessage(session: Session, text: string) {
  const trimmed = text.trim();

  if (session.flow === "exp") {
    if (session.step === "awaiting_amount") {
      const match = trimmed.match(/^\$?([\d.]+)\s*(.*)$/s);
      const amount = match ? parseFloat(match[1]) : NaN;
      if (!Number.isFinite(amount) || amount <= 0) {
        await sendMessage('That doesn\'t look like an amount — try again, e.g. "12.50" or "$12.50 lunch with team"');
        return;
      }
      await promptExpenseCategory(amount, match![2].trim());
      return;
    }
  }

  if (session.flow === "set") {
    if (session.step === "awaiting_weight_reps") {
      const match = trimmed.match(/^([\d.]+)\s+(\d+)$/);
      if (!match) {
        await sendMessage('Send weight and reps like "60 5", or tap a shortcut above.');
        return;
      }
      await promptRpe(session.data, match[1], match[2]);
      return;
    }
    if (session.step === "awaiting_rpe") {
      const { weight, reps } = session.data;
      await finishSet(session.data, weight, reps, trimmed);
      return;
    }
    if (session.step === "awaiting_adhoc_name") {
      await setSession("set", "awaiting_adhoc_weight_reps", { exerciseName: trimmed });
      await sendMessage(`${trimmed} — send weight and reps (e.g. "60 5")`);
      return;
    }
    if (session.step === "awaiting_adhoc_weight_reps") {
      const match = trimmed.match(/^([\d.]+)\s+(\d+)$/);
      if (!match) {
        await sendMessage('Send weight and reps like "60 5".');
        return;
      }
      await setSession("set", "awaiting_adhoc_rpe", { ...session.data, weight: match[1], reps: match[2] });
      const trainingState = (await getAppState("training")) ?? { ...DEFAULT_TRAINING_STATE };
      const lastAdhoc = findLastLogged(trainingState, session.data.exerciseName, 1);
      const adhocHint = lastAdhoc?.rpe ? ` (last time: RPE ${lastAdhoc.rpe})` : "";
      await sendMessage(`RPE?${adhocHint} (1-10, or tap Skip)`, [[{ text: "Skip", data: "set:adhoc_rpe_skip" }]]);
      return;
    }
    if (session.step === "awaiting_adhoc_rpe") {
      const { exerciseName, weight, reps } = session.data;
      await finishAdhocSet(exerciseName, weight, reps, trimmed);
      return;
    }
  }

  // No matching flow step for free text — nudge toward /help.
  await sendMessage(`Not sure what to do with that.\n\n${HELP_TEXT}`);
}

async function handleMessage(message: any) {
  if (!message || typeof message.text !== "string") return;
  if (String(message.chat.id) !== CHAT_ID) return;

  const parsed = parseCommand(message.text);
  try {
    if (parsed.kind !== "unknown") {
      await handleCommand(parsed);
      return;
    }
    const session = await getSession();
    if (session.flow) {
      await handleFlowMessage(session, message.text);
    } else {
      await sendMessage(`Didn't recognize that.\n\n${HELP_TEXT}`);
    }
  } catch (err) {
    console.error(err);
    await sendMessage(`Something went wrong: ${err instanceof Error ? err.message : String(err)}`);
    await clearSession();
  }
}

async function handleCallback(cq: any) {
  if (!cq.message || String(cq.message.chat.id) !== CHAT_ID) {
    await answerCallback(cq.id);
    return;
  }
  const data: string = cq.data || "";
  try {
    const session = await getSession();

    if (data === "exp:restart") {
      await startExpenseFlow();
    } else if (data.startsWith("exp:cat:")) {
      const idx = parseInt(data.slice("exp:cat:".length), 10);
      const category = session.data.categories?.[idx];
      if (category != null) await promptExpensePayment(session.data.amount, category, session.data.note ?? "");
    } else if (data.startsWith("exp:pay:")) {
      const idx = parseInt(data.slice("exp:pay:".length), 10);
      const payment = session.data.payments?.[idx];
      if (payment) await finishExpense(session.data.amount, session.data.category, payment.id, payment.label, session.data.note ?? "");
    } else if (data === "set:adhoc_start") {
      await setSession("set", "awaiting_adhoc_name", {});
      await sendMessage("What exercise?");
    } else if (data.startsWith("set:ex:")) {
      const idx = parseInt(data.slice("set:ex:".length), 10);
      const ex = session.data.exercises?.[idx];
      if (ex) await promptSetPicker(session.data.templateIdx, session.data.focus, session.data.exercises, ex.exIdx);
    } else if (data.startsWith("set:setnum:")) {
      const setNumber = parseInt(data.slice("set:setnum:".length), 10);
      await promptWeightReps(session.data.templateIdx, session.data.focus, session.data.exercises, session.data.exIdx, setNumber);
    } else if (data === "set:wr:planned") {
      const ex = session.data.exercises.find((e: any) => e.exIdx === session.data.exIdx);
      await promptRpe(session.data, String(ex.weight ?? ""), String(ex.reps ?? ""));
    } else if (data === "set:wr:last") {
      const ex = session.data.exercises.find((e: any) => e.exIdx === session.data.exIdx);
      const trainingState = (await getAppState("training")) ?? { ...DEFAULT_TRAINING_STATE };
      const last = findLastLogged(trainingState, ex.name, session.data.setNumber);
      if (last) await promptRpe(session.data, String(last.weight), String(last.reps));
    } else if (data === "set:rpe_skip") {
      const { weight, reps } = session.data;
      await finishSet(session.data, weight, reps, "");
    } else if (data === "set:cont_same") {
      await promptSetPicker(session.data.templateIdx, session.data.focus, session.data.exercises, session.data.exIdx);
    } else if (data === "set:cont_new") {
      await promptExercisePicker(session.data.templateIdx, session.data.focus, session.data.exercises);
    } else if (data === "set:cont_done") {
      await clearSession();
      await sendMessage("Nice work.");
    } else if (data === "set:adhoc_rpe_skip") {
      const { exerciseName, weight, reps } = session.data;
      await finishAdhocSet(exerciseName, weight, reps, "");
    }
  } catch (err) {
    console.error(err);
    await sendMessage(`Something went wrong: ${err instanceof Error ? err.message : String(err)}`);
    await clearSession();
  } finally {
    await answerCallback(cq.id);
  }
}

// ---------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------

async function getOffset(): Promise<number> {
  const { data } = await supabase.from("telegram_poll_state").select("last_update_id").eq("id", 1).maybeSingle();
  return data?.last_update_id ?? 0;
}

async function setOffset(id: number) {
  await supabase.from("telegram_poll_state").upsert({ id: 1, last_update_id: id, updated_at: new Date().toISOString() });
}

async function pollOnce(): Promise<number> {
  const offset = await getOffset();
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${offset + 1}&timeout=0`);
  const data = await res.json();
  if (!data.ok) {
    console.error("getUpdates failed", data);
    return 0;
  }

  const updates = data.result as any[];
  for (const update of updates) {
    if (update.callback_query) {
      await handleCallback(update.callback_query);
    } else if (update.message) {
      // Job-keyword scanning runs on every message (group chats this bot
      // is in), independent of handleMessage's command handling, which
      // only ever acts on your own DM with the bot.
      await checkJobKeywords(update.message);
      await handleMessage(update.message);
    } else if (update.channel_post) {
      await checkJobKeywords(update.channel_post);
    }
  }

  if (updates.length > 0) {
    const maxId = Math.max(...updates.map((u: any) => u.update_id));
    await setOffset(maxId);
  }
  return updates.length;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== CALL_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  const count = await pollOnce();
  return new Response(`processed ${count}`);
});
