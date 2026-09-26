// End-to-end run of the real handler (index.ts) against in-memory fakes of
// Gmail, Supabase's REST API (PostgREST) and Telegram, via a stubbed fetch.
// Run: cd supabase/functions && deno test --allow-env --allow-read --allow-net=localhost expense-email-sync/e2e.test.ts
// (the Anthropic key is left unset, so category guesses fall back to Shopping.)

import { assert, assertEquals } from "jsr:@std/assert@1";

const env: Record<string, string> = {
  WILLOW_USER_ID: "u1", DB_WEBHOOK_SECRET: "s3cret", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1",
  SUPABASE_URL: "http://localhost:54321", SUPABASE_SERVICE_ROLE_KEY: "k",
  GMAIL_CLIENT_ID: "c", GMAIL_CLIENT_SECRET: "cs", GMAIL_REFRESH_TOKEN: "r",
};
for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);

// ---------------- fake Gmail ----------------
const b64 = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_");
const at = (iso: string) => String(Date.parse(iso));
const MAILS: Record<string, { from: string; subject: string; body: string; date: string; html?: boolean }> = {
  m1: { from: "UOB <unialerts@uobgroup.com>", subject: "UOB - Transaction Alert", date: "2026-09-25T05:52:47Z", body: "A transaction of SGD 35.01 was made with your UOB Card ending 3051 on 25/09/26 at KrisPay*LeNu Chef Wai. If unauthorised, call 24/7 Fraud Hotline now" },
  m2: { from: "unialerts@uobgroup.com", subject: "UOB - Transaction Alert", date: "2026-09-25T13:00:44Z", body: "A transaction of SGD 56.40 was made with your UOB Card ending 8959 on 25/09/26 at HELPLING* SG-8674120. If unauthorised, call" },
  m3: { from: "DBS <ibanking.alert@dbs.com>", subject: "Card Transaction Alert", date: "2026-09-25T01:20:46Z", html: true, body: "<table><tr><td>Date &amp; Time:</td><td>25 SEP 09:20 (SGT)</td></tr><tr><td>Amount:</td><td>SGD20.00</td></tr><tr><td>From:</td><td>DBS/POSB card ending 3014</td></tr><tr><td>To:</td><td>PLAYTOMIC SG SINGAPORE SGP</td></tr></table>If unauthorised, please login" },
  m4: { from: "unialerts@uobgroup.com", subject: "UOB-PayNow transfer received", date: "2026-09-25T10:00:00Z", body: "You have received SGD 24.00 in your PayNow-linked account ending 3561 on 25-SEP-2026 06:00PM." },
  m5: { from: "unialerts@uobgroup.com", subject: "UOB Personal Internet Banking Notification Alerts", date: "2026-09-25T08:00:00Z", body: "You made a PayNow transfer of SGD 4000.00 to INSPIRE MEDICAL PTE. LTD. (UEN ending 080E) on your a/c ending 3561 at 4:00PM SGT, 25 Sep 26. If unauthorised" },
  m6: { from: "alerts.sg@sc.com", subject: "Transaction alert", date: "2026-09-25T09:00:00Z", body: "Your card ending 3399 was charged SGD 12.00 at SOMEWHERE on 25/09/26." },
  m7: { from: "unialerts@uobgroup.com", subject: "Your eStatement/eAdvice is ready for viewing", date: "2026-09-25T09:30:00Z", body: "Dear Customer, your UNIPLUS eStatement is ready for viewing." },
};
const gmailLog: { modify: any[]; sent: string[] } = { modify: [], sent: [] };

function gmailFetch(url: URL, init: RequestInit): Response {
  const p = url.pathname.replace("/gmail/v1/users/me", "");
  if (p === "/messages") return Response.json({ messages: Object.keys(MAILS).map((id) => ({ id })) });
  if (p === "/messages/batchModify") { gmailLog.modify.push(JSON.parse(String(init.body))); return new Response(null, { status: 204 }); }
  if (p === "/messages/send") { gmailLog.sent.push(JSON.parse(String(init.body)).raw); return Response.json({ id: "sent" }); }
  const mm = p.match(/^\/messages\/(\w+)$/);
  if (mm) {
    const m = MAILS[mm[1]];
    return Response.json({
      id: mm[1], internalDate: at(m.date), labelIds: ["INBOX"],
      payload: { mimeType: "multipart/alternative", headers: [{ name: "From", value: m.from }, { name: "Subject", value: m.subject }], parts: [{ mimeType: m.html ? "text/html" : "text/plain", body: { data: b64(m.body) } }] },
    });
  }
  if (p === "/labels" && (init.method ?? "GET") === "GET") return Response.json({ labels: [{ id: "Label_7", name: "Expense Logged" }] });
  if (p === "/messages/batchModify") { gmailLog.modify.push(JSON.parse(String(init.body))); return new Response(null, { status: 204 }); }
  if (p === "/profile") return Response.json({ emailAddress: "owner@example.com" });
  if (p === "/messages/send") { gmailLog.sent.push(JSON.parse(String(init.body)).raw); return Response.json({ id: "sent" }); }
  return new Response("unhandled gmail " + p, { status: 500 });
}

import { db, now, restFetch, seed } from "../_test/fake_backend.ts";

const telegram: any[] = [];
globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (input instanceof Request) init = { method: input.method, headers: input.headers, body: await input.text() || undefined, ...init };
  if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "at" });
  if (url.hostname === "gmail.googleapis.com") return gmailFetch(url, init);
  if (url.hostname === "api.telegram.org") { telegram.push(JSON.parse(String(init.body))); return Response.json({ ok: true }); }
  if (url.hostname === "localhost") return restFetch(url, init);
  return new Response("unexpected " + url, { status: 500 });
}) as typeof fetch;

let handler: (req: Request) => Promise<Response>;
(Deno as any).serve = (h: any) => { handler = h; return {} as any; };

async function call(mode: string, q = "") {
  Deno.env.set("EXPENSE_SYNC_MODE", mode);
  // index.ts reads MODE at import, so import a fresh copy per mode.
  await import(`./index.ts?mode=${mode}&n=${Math.random()}`);
  const res = await handler(new Request(`http://localhost/functions/v1/expense-email-sync${q}`, { method: "POST", headers: { "x-webhook-secret": "s3cret" } }));
  return { status: res.status, body: await res.json() };
}

Deno.test("rejects calls without the cron secret", async () => {
  seed();
  await import(`./index.ts?auth=${Math.random()}`);
  const res = await handler(new Request("http://localhost/x", { method: "POST" }));
  assertEquals(res.status, 401);
});

Deno.test("shadow mode decides everything but writes nothing except the log", async () => {
  seed();
  const before = JSON.stringify(db.app_state);
  telegram.length = 0; gmailLog.modify = []; gmailLog.sent = [];
  const { status, body } = await call("shadow");
  assertEquals(status, 200, JSON.stringify(body));
  const by = Object.fromEntries(body.decisions.map((d: any) => [d.id, d]));
  assertEquals(by.m1.action, "log"); assertEquals(by.m1.target, "expenses"); assertEquals(by.m1.category, "Shopping");
  assertEquals(by.m2.target, "excluded");
  assertEquals(by.m3.category, "Badminton"); assertEquals(by.m3.cardId, "msjivaj3mypi2");
  assertEquals(by.m4.action, "incoming");
  assertEquals(by.m5.action, "skip");
  assertEquals(by.m6.action, "review");
  assertEquals(by.m7.action, "skip");
  assertEquals(JSON.stringify(db.app_state), before);
  assertEquals(telegram.length, 0); assertEquals(gmailLog.modify.length, 0); assertEquals(gmailLog.sent.length, 0);
  assertEquals(db.expense_sync_log.filter((r) => r.mode === "shadow").length, 7);

  // second run: nothing new
  const again = await call("shadow");
  assertEquals(again.body.new, 0);

  // compare: routine logged m1 identically, m2 on a different card, m3 not at all
  const exp = db.app_state[0].state;
  exp.expenses.push({ id: "gm-m1", date: "2026-09-25", amount: 35.01, category: "Restaurant", cardId: "msx1uobkris01", note: "x" });
  db.app_state[1].state.excludedExpenses.push({ id: "gm-m2", date: "2026-09-25", amount: 56.4, category: "Bills", cardId: "wrong", note: "x", type: "combined", reason: "" });
  const cmp = await call("shadow", "?compare=1");
  assertEquals(cmp.body.categoryDiffs.length, 1); // m1: Shopping vs Restaurant
  const problems = cmp.body.mismatches.map((m: any) => `${m.messageId}:${m.problem}`).sort();
  assertEquals(problems, ["m2:logged differently", "m3:shadow would log, routine didn't"]);
});

Deno.test("live mode applies, labels, prompts, reports once, and never double-logs", async () => {
  seed();
  telegram.length = 0; gmailLog.modify = []; gmailLog.sent = [];
  const { status, body } = await call("live");
  assertEquals(status, 200, JSON.stringify(body));
  const exp = db.app_state[0].state.expenses.map((e: any) => e.id);
  assert(exp.includes("gm-m1") && exp.includes("gm-m3") && exp.includes("x-old"));
  assertEquals(db.app_state[1].state.excludedExpenses.map((e: any) => e.id), ["gm-m2"]);
  // labelled: everything decided except the info-only statement (m7)
  assertEquals(gmailLog.modify[0].ids.sort(), ["m1", "m2", "m3", "m4", "m5", "m6"]);
  assertEquals(gmailLog.modify[0].removeLabelIds, ["INBOX"]);
  // Telegram: category prompt for m1 (default category), review for m6, incoming for m4
  const texts = telegram.map((t) => t.text);
  assert(texts.some((t) => t.startsWith("Logged $35.01 KrisPay*LeNu Chef Wai as Shopping")), texts.join("\n"));
  assert(texts.some((t) => t.startsWith("⚠️ Couldn't log this automatically")));
  const inc = telegram.find((t) => t.text.startsWith("💰 Received $24.00"));
  assert(inc && inc.reply_markup.inline_keyboard.length >= 2);
  assertEquals(db.expense_sync_pending.length, 4); // m1 + m2 category guesses, m4 incoming, m6 review
  // daily report went out once (run is after midnight SGT on the 26th)
  assertEquals(gmailLog.sent.length, 1);
  assertEquals(body.reported, true);
  assertEquals(db.expense_sync_state[0].last_report_date, new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10));
  const mime = atob(gmailLog.sent[0].replace(/-/g, "+").replace(/_/g, "/"));
  assert(mime.includes("Subject: =?UTF-8?B?") && mime.includes("multipart/alternative"));

  // a second run the same day: no new emails processed, no second report, no duplicates
  const again = await call("live");
  assertEquals(again.body.new, 0);
  assertEquals(gmailLog.sent.length, 1);
  assertEquals(db.app_state[0].state.expenses.filter((e: any) => e.id === "gm-m1").length, 1);
});

Deno.test("live mode skips emails the routine already logged (safe cutover overlap)", async () => {
  seed();
  db.app_state[0].state.expenses.push({ id: "gm-m1", date: "2026-09-25", amount: 35.01, category: "Restaurant", cardId: "msx1uobkris01", note: "routine" });
  telegram.length = 0;
  const { body } = await call("live");
  const m1 = body.decisions.find((d: any) => d.id === "m1");
  assertEquals(m1.action, "skip");
  assertEquals(db.app_state[0].state.expenses.filter((e: any) => e.id === "gm-m1").length, 1);
  assertEquals(db.app_state[0].state.expenses.find((e: any) => e.id === "gm-m1").note, "routine");
});

Deno.test("a concurrent app write between read and write is retried, not clobbered", async () => {
  seed();
  // Simulate the app saving right after the function reads the row: bump
  // updated_at and add an expense on the first PATCH attempt only.
  const realFetch = globalThis.fetch;
  let raced = false;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url ?? input.href);
    if (!raced && url.hostname === "localhost" && (init.method === "PATCH" || input?.method === "PATCH") && url.searchParams.get("app") === "eq.expenses") {
      raced = true;
      const row = db.app_state[0];
      row.state.expenses.push({ id: "from-app", date: "2026-09-25", amount: 1, category: "Food", cardId: "cash", note: "added in app" });
      row.updated_at = now();
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    await call("live");
  } finally {
    globalThis.fetch = realFetch;
  }
  const ids = db.app_state[0].state.expenses.map((e: any) => e.id);
  assert(raced);
  assert(ids.includes("from-app") && ids.includes("gm-m1") && ids.includes("gm-m3"), ids.join(","));
});
