// Button taps on expense-email-sync's Telegram prompts ("xs:" callbacks),
// driven through the real telegram-poll handler with fake Telegram + Supabase.
// Run: cd supabase/functions && deno test --allow-env --allow-read --allow-net=localhost telegram-poll/xs_callbacks.test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";
import { db, now, restFetch, seed } from "../_test/fake_backend.ts";

for (const [k, v] of Object.entries({
  TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1", WILLOW_USER_ID: "u1", DB_WEBHOOK_SECRET: "s",
  SUPABASE_URL: "http://localhost:54321", SUPABASE_SERVICE_ROLE_KEY: "k",
})) Deno.env.set(k, v);

let updates: any[] = [];
const sent: any[] = [];
globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (input instanceof Request) init = { method: input.method, headers: input.headers, body: (await input.text()) || undefined, ...init };
  if (url.hostname === "api.telegram.org") {
    if (url.pathname.endsWith("/getUpdates")) {
      const u = updates;
      updates = [];
      return Response.json({ ok: true, result: u });
    }
    if (url.pathname.endsWith("/sendMessage")) sent.push(JSON.parse(String(init.body)));
    return Response.json({ ok: true });
  }
  if (url.hostname === "localhost") return restFetch(url, init);
  return new Response("unexpected " + url, { status: 500 });
}) as typeof fetch;

let handler: (req: Request) => Promise<Response>;
(Deno as any).serve = (h: any) => { handler = h; return {} as any; };
await import("./index.ts");

let updateId = 100;
async function tap(data: string) {
  updates = [{ update_id: ++updateId, callback_query: { id: `cq${updateId}`, data, message: { chat: { id: 1 } } } }];
  const res = await handler(new Request("http://localhost/", { method: "POST", headers: { "x-webhook-secret": "s" } }));
  assertEquals(res.status, 200);
}

function setup() {
  seed();
  db.app_state[0].state.expenses.push({ id: "gm-m1", date: "2026-09-25", amount: 35.01, category: "Shopping", cardId: "msx1uobkris01", note: "KrisPay*LeNu Chef Wai, auto-logged from email" });
  db.app_state[0].updated_at = now();
  db.expense_sync_pending = [
    { id: 1, kind: "category", message_id: "m1", resolved_at: null, payload: { entryId: "gm-m1", target: "expenses", key: "KrisPay*LeNu Chef Wai", categories: ["Food", "Restaurant", "Transport"], current: "Shopping" } },
    { id: 2, kind: "incoming", message_id: "m4", resolved_at: null, payload: { amount: 24, date: "2026-09-25", acct: "3561", candidates: [{ id: "x-old", amount: 30, category: "Restaurant", note: "Dinner", date: "2026-09-24" }] } },
    { id: 3, kind: "review", message_id: "m6", resolved_at: null, payload: { summary: "?" } },
  ];
  sent.length = 0;
}

Deno.test("changing a guessed category updates the entry, then saves a rule on 'always'", async () => {
  setup();
  await tap("xs:1:c1");
  assertEquals(db.app_state[0].state.expenses.find((e: any) => e.id === "gm-m1").category, "Restaurant");
  assert(sent.at(-1).text.startsWith("Changed to Restaurant."));
  assert(db.expense_sync_pending[0].resolved_at);
  await tap("xs:1:ay");
  assertEquals(db.app_state[1].state.categoryRules.at(-1), { merchantPattern: "KrisPay*LeNu Chef Wai", category: "Restaurant" });
  // tapping a stale category button again is refused
  await tap("xs:1:c0");
  assertEquals(sent.at(-1).text, "Already handled.");
  assertEquals(db.app_state[0].state.expenses.find((e: any) => e.id === "gm-m1").category, "Restaurant");
});

Deno.test("incoming PayNow offset adds one negative cash entry, idempotently", async () => {
  setup();
  await tap("xs:2:o0");
  const offs = db.app_state[0].state.expenses.filter((e: any) => e.id === "offset-m4");
  assertEquals(offs.length, 1);
  assertEquals(offs[0].amount, -24);
  assertEquals(offs[0].category, "Restaurant");
  assertEquals(offs[0].cardId, "cash");
  await tap("xs:2:o0");
  assertEquals(db.app_state[0].state.expenses.filter((e: any) => e.id === "offset-m4").length, 1);
});

Deno.test("dismiss resolves without touching expenses", async () => {
  setup();
  const before = JSON.stringify(db.app_state);
  await tap("xs:3:x");
  assertEquals(JSON.stringify(db.app_state), before);
  assert(db.expense_sync_pending[2].resolved_at);
  assertEquals(sent.at(-1).text, "Dismissed.");
});
