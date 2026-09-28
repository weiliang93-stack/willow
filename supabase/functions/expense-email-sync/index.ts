// Supabase Edge Function: turns bank/card alert emails into expense-tracker
// entries - the code replacement for the nightly Claude routine "Auto-log
// expenses from bank emails + email report". Runs every 15 minutes via
// pg_cron (see shared/expense-sync-schema.sql), so charges appear in the app
// within ~15 minutes instead of the next morning.
//
// What's code vs. judgement:
//   - parse.ts  : one parser per alert format (UOB/DBS/Citi/HSBC/CDG Zig).
//                 Unknown formats are never guessed - they go to Telegram.
//   - rules.ts  : the routine's decision process (card mapping,
//                 exclusionRules, categoryRules, self-transfers, bill
//                 payments, reversals, CDG vs Cabcharge de-dup), reading the
//                 same rules from app_state "expenses_automation".
//   - Category for a merchant no rule covers: a Claude Haiku guess (or
//     config.defaultCategory - Restaurant - without ANTHROPIC_API_KEY), logged immediately, with a
//     Telegram "change?" prompt; changing it offers to save a categoryRule
//     so that merchant is automatic from then on (handled in telegram-poll,
//     callback prefix "xs:").
//   - Incoming PayNow: Telegram prompt listing recent charges it might
//     offset; tapping one adds the negative cash entry.
//
// Modes (EXPENSE_SYNC_MODE secret):
//   shadow (default) - decides everything and records it in expense_sync_log
//                      but writes nothing else: no app_state, no labels, no
//                      Telegram, no email. GET ?compare=1 diffs those
//                      decisions against what the routine actually logged.
//   live             - applies decisions, labels + archives the emails
//                      "Expense Logged", sends Telegram prompts and the daily
//                      report email.
// Entry ids are "gm-<gmail message id>" - the same scheme the routine uses -
// and live mode skips any id already present, so overlapping with the
// routine during cutover can't double-log.
//
// Required secrets (beyond the auto-injected SUPABASE_*):
//   WILLOW_USER_ID, DB_WEBHOOK_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//     - same values the other functions already use
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
//     - OAuth client + refresh token for the owner's Gmail (scopes
//       gmail.modify + gmail.send); setup steps in CLAUDE.md
// Optional:
//   ANTHROPIC_API_KEY  - enables Haiku category guesses
//   EXPENSE_SYNC_MODE  - "shadow" (default) or "live"
//   REPORT_HOUR_SGT    - hour the daily email goes out (default 0 = the
//                        first run after midnight, like the routine)

import { createClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";
import { Gmail } from "./gmail.ts";
import { normalizeText, parseEmail } from "./parse.ts";
import { classify, monthToDate, money, round2, type Context, type Decision, type Expense, type ExcludedExpense, type Incoming } from "./rules.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { buildReport, type ReportItem } from "./report.ts";

const USER_ID = Deno.env.get("WILLOW_USER_ID")!;
const CALL_SECRET = Deno.env.get("DB_WEBHOOK_SECRET")!;
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID")!;
const MODE = (Deno.env.get("EXPENSE_SYNC_MODE") ?? "shadow").toLowerCase() === "live" ? "live" : "shadow";
const REPORT_HOUR = parseInt(Deno.env.get("REPORT_HOUR_SGT") ?? "0", 10);
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const gmail = new Gmail(Deno.env.get("GMAIL_CLIENT_ID")!, Deno.env.get("GMAIL_CLIENT_SECRET")!, Deno.env.get("GMAIL_REFRESH_TOKEN")!);

const SENDERS = [
  "ibanking.alert@dbs.com", "DBSAlert@dbs.com", "unialerts@uobgroup.com", "alerts.sg@sc.com", "alerts@citibank.com.sg",
  "hsbc.com.sg", "notification.hsbc.com.hk", "noreply@cdgtaxi.com.sg",
];
const QUERY = `from:(${SENDERS.join(" OR ")}) newer_than:3d`;
const LABEL = "Expense Logged";

// ---------------- dates (Singapore, fixed +08:00, no DST) ----------------
function sgtDate(ms: number) {
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
}
function sgtHour(ms: number) {
  return new Date(ms + 8 * 3600_000).getUTCHours();
}
function addDays(date: string, n: number) {
  return new Date(Date.parse(date) + n * 86_400_000).toISOString().slice(0, 10);
}

// ---------------- app_state helpers ----------------
async function readRow(app: string): Promise<{ state: any; updatedAt: string | null }> {
  const { data, error } = await supabase.from("app_state").select("state, updated_at").eq("user_id", USER_ID).eq("app", app).maybeSingle();
  if (error) throw error;
  return { state: data?.state ?? null, updatedAt: data?.updated_at ?? null };
}

// Read-modify-write guarded on updated_at, so a concurrent write from the
// app (or the bot) makes this retry against the fresh copy instead of
// being clobbered or clobbering it.
async function mutateRow(app: string, fn: (state: any) => any | null) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { state, updatedAt } = await readRow(app);
    if (!state || !updatedAt) throw new Error(`app_state "${app}" missing`);
    const next = fn(structuredClone(state));
    if (next == null) return;
    const { data, error } = await supabase
      .from("app_state")
      .update({ state: next, updated_at: new Date().toISOString() })
      .eq("user_id", USER_ID)
      .eq("app", app)
      .eq("updated_at", updatedAt)
      .select("app");
    if (error) throw error;
    if (data && data.length) return;
    await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
  }
  throw new Error(`app_state "${app}" kept changing underneath; gave up after 5 tries`);
}

// ---------------- Telegram ----------------
type Button = { text: string; data: string };
async function tg(text: string, keyboard?: Button[][]) {
  const body: Record<string, unknown> = { chat_id: CHAT_ID, text };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard.map((r) => r.map((b) => ({ text: b.text, callback_data: b.data }))) };
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
async function pending(kind: string, messageId: string, payload: unknown): Promise<number> {
  const { data, error } = await supabase.from("expense_sync_pending").insert({ kind, message_id: messageId, payload }).select("id").single();
  if (error) throw error;
  return data.id;
}
function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
// Strips trailing reference codes so a saved rule matches future charges:
// "Grab* A-9SF6ULKG" -> "Grab*", "HELPLING* SG-8674120" -> "HELPLING*".
function merchantKey(note: string) {
  const merchant = note.replace(/, auto-logged from email$/, "").replace(/^\[card ending \d{4} — not mapped\] /, "").replace(/^PayNow to |^Funds transfer to /, "");
  return merchant.replace(/(\s+\S*\d\S*)+$/, "").replace(/\s*\((UEN|Mobile) ending [^)]*\)$/i, "").trim().slice(0, 40) || merchant.slice(0, 40);
}

// ---------------- category guess ----------------
async function guessCategory(text: string, amount: number, categories: string[], preferred: string): Promise<{ category: string; source: "ai" | "default" }> {
  const fallback = categories.includes(preferred) ? preferred : categories.includes("Shopping") ? "Shopping" : categories[0] ?? "Shopping";
  if (!ANTHROPIC_KEY) return { category: fallback, source: "default" };
  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const res = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 20,
      system: `You categorise Singapore card transactions for a personal budget. Reply with exactly one category name from this list and nothing else: ${categories.join(", ")}. "Food" is groceries and casual food/food delivery; "Restaurant" is sit-down dining.`,
      messages: [{ role: "user", content: `Merchant: ${text}\nAmount: SGD ${amount.toFixed(2)}` }],
    });
    const reply = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim().replace(/[."]/g, "");
    const hit = categories.find((c) => c.toLowerCase() === reply.toLowerCase());
    return hit ? { category: hit, source: "ai" } : { category: fallback, source: "default" };
  } catch (err) {
    console.error("category guess failed:", err);
    return { category: fallback, source: "default" };
  }
}

// ---------------- main run ----------------
async function run() {
  const nowMs = Date.now();
  const today = sgtDate(nowMs);

  const ids = await gmail.listIds(QUERY);
  const { data: seenRows, error: seenErr } = await supabase.from("expense_sync_log").select("message_id").eq("mode", MODE).in("message_id", ids.length ? ids : ["-"]);
  if (seenErr) throw seenErr;
  const seen = new Set((seenRows ?? []).map((r) => r.message_id));
  const fresh = ids.filter((id) => !seen.has(id));

  const batch: (Incoming & { from: string; subject: string })[] = [];
  for (const id of fresh) {
    const m = await gmail.get(id);
    const event = parseEmail({ from: m.from, subject: m.subject, text: normalizeText(m.text), receivedDate: sgtDate(m.internalDate) });
    batch.push({ messageId: id, event, from: m.from, subject: m.subject });
  }

  const [expRow, autoRow, cfgRow] = await Promise.all([readRow("expenses"), readRow("expenses_automation"), readRow("expense_sync")]);
  const exp = expRow.state ?? {};
  const auto = autoRow.state ?? {};
  const expenses: Expense[] = exp.expenses ?? [];
  const excluded: ExcludedExpense[] = auto.excludedExpenses ?? [];
  const categories: string[] = exp.categories ?? [];
  const config = { ...DEFAULT_CONFIG, ...(cfgRow.state?.config ?? {}) };

  const batchIds = new Set(batch.map((b) => `gm-${b.messageId}`));
  const weekAgo = addDays(today, -7);
  // Shadow mode must decide as if the routine hadn't run yet, or every
  // email it already handled would just read "already logged".
  const existingIds = MODE === "live" ? new Set([...expenses, ...excluded].map((e) => e.id)) : new Set<string>();
  const recent = [
    ...expenses.map((e) => ({ ...e, target: "expenses" as const })),
    ...excluded.map((e) => ({ ...e, target: "excluded" as const })),
  ].filter((e) => e.date >= weekAgo && (MODE === "live" || !batchIds.has(e.id)));

  const ctx: Context = {
    exclusionRules: auto.exclusionRules ?? [],
    categoryRules: auto.categoryRules ?? [],
    selfTransferAccounts: auto.selfTransferAccounts ?? [],
    config,
    existingIds,
    recent,
  };
  const decisions = classify(batch, ctx, today);

  // Fill categories no rule covered.
  const guessed = new Map<string, "ai" | "default">();
  for (const d of decisions) {
    if (d.action !== "log" || !d.needsCategory) continue;
    const g = await guessCategory(d.entry.note.replace(/, auto-logged from email$/, ""), d.entry.amount, categories, config.defaultCategory);
    d.entry.category = g.category;
    guessed.set(d.messageId, g.source);
  }

  const toRecord = decisions.filter((d) => d.action !== "defer");
  if (MODE === "shadow") {
    await recordLog(toRecord, false);
    return { mode: MODE, scanned: ids.length, new: fresh.length, decisions: summarise(decisions) };
  }

  // ---- live: apply ----
  const logExp = toRecord.filter((d): d is Extract<Decision, { action: "log" }> => d.action === "log" && d.target === "expenses");
  const logExc = toRecord.filter((d): d is Extract<Decision, { action: "log" }> => d.action === "log" && d.target === "excluded");
  const rmExp = toRecord.filter((d): d is Extract<Decision, { action: "remove" }> => d.action === "remove" && d.target === "expenses");
  const rmExc = toRecord.filter((d): d is Extract<Decision, { action: "remove" }> => d.action === "remove" && d.target === "excluded");

  if (logExp.length || rmExp.length) {
    await mutateRow("expenses", (s) => {
      const have = new Set((s.expenses ?? []).map((e: Expense) => e.id));
      const drop = new Set(rmExp.map((d) => d.removeId));
      s.expenses = [...(s.expenses ?? []).filter((e: Expense) => !drop.has(e.id)), ...logExp.map((d) => d.entry).filter((e) => !have.has(e.id))];
      return s;
    });
  }
  if (logExc.length || rmExc.length) {
    await mutateRow("expenses_automation", (s) => {
      const have = new Set((s.excludedExpenses ?? []).map((e: Expense) => e.id));
      const drop = new Set(rmExc.map((d) => d.removeId));
      s.excludedExpenses = [...(s.excludedExpenses ?? []).filter((e: Expense) => !drop.has(e.id)), ...logExc.map((d) => d.entry).filter((e) => !have.has(e.id))];
      return s;
    });
  }

  const labelIds = toRecord.filter((d) => !(d.action === "skip" && !d.label)).map((d) => d.messageId);
  if (labelIds.length) await gmail.labelAndArchive(labelIds, await gmail.labelId(LABEL));
  await recordLog(toRecord, true);

  // ---- Telegram prompts ----
  const catButtons = (pid: number) => chunk(categories.map((c, i) => ({ text: c, data: `xs:${pid}:c${i}` })), 3);
  for (const d of toRecord) {
    if (d.action === "log") {
      const src = guessed.get(d.messageId);
      const line = `${money(d.entry.amount)} ${d.entry.note.replace(/, auto-logged from email$/, "")}`;
      if (src) {
        const pid = await pending("category", d.messageId, { entryId: d.entry.id, target: d.target, key: merchantKey(d.entry.note), categories, current: d.entry.category });
        await tg(`Logged ${line} as ${d.entry.category}${src === "ai" ? " (guessed)" : " (default — no rule for this merchant)"}. Change it?`, [...catButtons(pid), [{ text: `✓ ${d.entry.category} is right`, data: `xs:${pid}:ok` }]]);
      } else if (d.lowConfidence) {
        await tg(`Logged ${line} — ${d.lowConfidence}. Edit it in the app if that's wrong.`);
      }
    } else if (d.action === "review") {
      const pid = await pending("review", d.messageId, { summary: d.summary });
      const b = batch.find((x) => x.messageId === d.messageId);
      await tg(`⚠️ Couldn't log this automatically: ${d.summary}${b ? `\nFrom: ${b.from}\nSubject: ${b.subject}` : ""}\nLog it with /exp if it's a real expense.`, [[{ text: "Dismiss", data: `xs:${pid}:x` }]]);
    } else if (d.action === "incoming") {
      const candidates = [...expenses, ...excluded]
        .filter((e) => e.amount > 0 && e.date >= addDays(d.date, -3) && e.date <= d.date)
        .sort((a, b) => (a.date < b.date ? 1 : -1))
        .slice(0, 6)
        .map((e) => ({ id: e.id, amount: e.amount, category: e.category, note: e.note.replace(/, auto-logged from email$/, "").slice(0, 40), date: e.date }));
      const pid = await pending("incoming", d.messageId, { amount: d.amount, date: d.date, acct: d.destAcct, candidates });
      await tg(`💰 Received ${money(d.amount)} into a/c ${d.destAcct ?? "?"} (${d.date}). Does it offset a charge?`, [
        ...candidates.map((c, i) => [{ text: `${money(c.amount)} ${c.note.slice(0, 28)} (${c.date.slice(8)}/${+c.date.slice(5, 7)})`, data: `xs:${pid}:o${i}` }]),
        [{ text: "Not an offset", data: `xs:${pid}:x` }],
      ]);
    } else if (d.action === "remove") {
      await tg(`↩️ ${d.summary}`);
    }
  }

  const reported = await maybeSendReport(nowMs, today);
  return { mode: MODE, scanned: ids.length, new: fresh.length, decisions: summarise(decisions), reported };
}

function summarise(ds: Decision[]) {
  return ds.map((d) => ({ id: d.messageId, action: d.action, ...(d.action === "log" ? { target: d.target, amount: d.entry.amount, cardId: d.entry.cardId, category: d.entry.category } : {}), summary: d.summary }));
}

async function recordLog(ds: Decision[], applied: boolean) {
  if (!ds.length) return;
  const rows = ds.map((d) => ({
    message_id: d.messageId,
    mode: MODE,
    action: d.action,
    target: d.action === "log" || d.action === "remove" ? d.target : null,
    entry: d.action === "log" ? d.entry : d.action === "remove" ? { removeId: d.removeId } : d.action === "incoming" ? { amount: d.amount, date: d.date, destAcct: d.destAcct } : null,
    summary: d.summary,
    applied,
  }));
  const { error } = await supabase.from("expense_sync_log").upsert(rows, { onConflict: "message_id,mode" });
  if (error) throw error;
}

// ---------------- daily report ----------------
async function maybeSendReport(nowMs: number, today: string): Promise<boolean> {
  if (sgtHour(nowMs) < REPORT_HOUR) return false;
  const { data: st } = await supabase.from("expense_sync_state").select("last_report_date").eq("id", 1).maybeSingle();
  if (st?.last_report_date === today) return false;

  const yesterday = addDays(today, -1);
  const from = `${yesterday}T00:00:00+08:00`;
  const to = `${today}T00:00:00+08:00`;
  const { data: rows, error } = await supabase.from("expense_sync_log").select("*").eq("mode", "live").gte("decided_at", from).lt("decided_at", to);
  if (error) throw error;

  const [expRow, autoRow] = await Promise.all([readRow("expenses"), readRow("expenses_automation")]);
  const cards = expRow.state?.cards ?? [];
  const cardName = (id: string) => cards.find((c: any) => c.id === id)?.name ?? (id === "cash" ? "Cash / transfer" : id);
  const item = (e: any): ReportItem => ({ merchant: e.note.replace(/, auto-logged from email$/, ""), category: e.category, cardLabel: cardName(e.cardId), amount: e.amount, excludedReason: e.reason });
  const logs = rows ?? [];

  const mtd = monthToDate(today, expRow.state?.expenses ?? [], autoRow.state?.excludedExpenses ?? [], cards, autoRow.state?.exclusionRules ?? [], expRow.state?.monthlyBudget ?? null);
  const dateLabel = new Intl.DateTimeFormat("en-SG", { timeZone: "Asia/Singapore", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${yesterday}T12:00:00+08:00`));
  const report = buildReport({
    dateLabel,
    charges: logs.filter((r) => r.action === "log" && r.target === "expenses").map((r) => item(r.entry)),
    excluded: logs.filter((r) => r.action === "log" && r.target === "excluded").map((r) => item(r.entry)),
    incoming: logs.filter((r) => r.action === "incoming").map((r) => r.summary),
    skipped: logs.filter((r) => r.action === "skip" && r.summary !== "already logged").map((r) => r.summary),
    review: logs.filter((r) => r.action === "review").map((r) => r.summary),
    spent: round2(mtd.spent),
    budget: mtd.budget,
    caps: mtd.caps,
  });
  await gmail.send(await gmail.profileEmail(), report.subject, report.text, report.html);
  await supabase.from("expense_sync_state").upsert({ id: 1, last_report_date: today });
  return true;
}

// ---------------- shadow comparison ----------------
// Diffs shadow decisions against what the routine actually logged (same
// gm-<id> scheme). Category differences are listed separately - a Haiku
// guess vs the routine's guess isn't a correctness bug.
async function compare(days: number) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data: rows, error } = await supabase.from("expense_sync_log").select("*").eq("mode", "shadow").gte("decided_at", since);
  if (error) throw error;
  const [expRow, autoRow] = await Promise.all([readRow("expenses"), readRow("expenses_automation")]);
  const actual = new Map<string, any>();
  for (const e of expRow.state?.expenses ?? []) actual.set(e.id, { ...e, target: "expenses" });
  for (const e of autoRow.state?.excludedExpenses ?? []) actual.set(e.id, { ...e, target: "excluded" });

  const mismatches: unknown[] = [];
  const categoryDiffs: unknown[] = [];
  let matched = 0;
  for (const r of rows ?? []) {
    const a = actual.get(`gm-${r.message_id}`);
    if (r.action === "log") {
      const e = r.entry;
      if (!a) mismatches.push({ messageId: r.message_id, problem: "shadow would log, routine didn't", shadow: e, summary: r.summary });
      else if (a.target !== r.target || Math.abs(a.amount - e.amount) > 0.001 || a.cardId !== e.cardId)
        mismatches.push({ messageId: r.message_id, problem: "logged differently", shadow: { target: r.target, amount: e.amount, cardId: e.cardId }, routine: { target: a.target, amount: a.amount, cardId: a.cardId } });
      else {
        matched++;
        if (a.category !== e.category) categoryDiffs.push({ messageId: r.message_id, note: e.note, shadow: e.category, routine: a.category });
      }
    } else if (a) {
      mismatches.push({ messageId: r.message_id, problem: `routine logged it, shadow chose "${r.action}"`, routine: { target: a.target, amount: a.amount, cardId: a.cardId, note: a.note }, summary: r.summary });
    } else matched++;
  }
  return { days, decisions: rows?.length ?? 0, matched, mismatches, categoryDiffs };
}

Deno.serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== CALL_SECRET) return new Response("unauthorized", { status: 401 });
  try {
    const url = new URL(req.url);
    const body = url.searchParams.get("compare") ? await compare(parseInt(url.searchParams.get("days") ?? "7", 10)) : await run();
    return new Response(JSON.stringify(body, null, 2), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : String(err);
    await alertFailure(message).catch((e) => console.error("failure alert failed:", e));
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});

// A broken run (expired Gmail token, bank format change that throws, DB
// error) messages Telegram at most once every 6 hours, so a failure is seen
// the same day instead of noticed weeks later as missing expenses.
async function alertFailure(message: string) {
  if (MODE !== "live") return;
  const { data } = await supabase.from("expense_sync_state").select("last_error_at").eq("id", 1).maybeSingle();
  if (data?.last_error_at && Date.now() - Date.parse(data.last_error_at) < 6 * 3600_000) return;
  await supabase.from("expense_sync_state").upsert({ id: 1, last_error_at: new Date().toISOString() });
  await tg(`⚠️ expense-email-sync failed: ${message.slice(0, 500)}\nCharges aren't being logged until this is fixed.`);
}
