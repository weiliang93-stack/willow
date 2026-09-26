// In-memory stand-in for Supabase's REST API (PostgREST), just enough of it
// for the functions' own queries: eq/in/gte/lt/or filters, single-object
// Accept, PATCH, POST with upsert. Test-only (underscore dir isn't deployed).
export type Row = Record<string, any>;
export const db: Record<string, Row[]> = { app_state: [], expense_sync_log: [], expense_sync_pending: [], expense_sync_state: [], telegram_poll_state: [], telegram_session_state: [], telegram_job_watch: [] };
let seq = 1;
let tick = 0;
export const now = () => new Date(Date.UTC(2026, 8, 25, 16, 0, tick++)).toISOString();

export function seed() {
  db.app_state = [
    { user_id: "u1", app: "expenses", updated_at: now(), state: {
      cards: [{ id: "msx1uobkris01", name: "UOB KrisFlyer", cap: 0, resetMode: "calendar", statementDay: null }, { id: "msjivaj3mypi2", name: "DBS Women World", cap: 1000, resetMode: "calendar", statementDay: null }],
      categories: ["Food", "Restaurant", "Transport", "Shopping", "Badminton"], monthlyBudget: 2000,
      expenses: [{ id: "x-old", date: "2026-09-24", amount: 30, category: "Restaurant", cardId: "msjivaj3mypi2", note: "Dinner, auto-logged from email" }],
    } },
    { user_id: "u1", app: "expenses_automation", updated_at: now(), state: {
      exclusionRules: [
        { matchType: "cardLast4", matchValue: "8959", type: "combined", reason: "UOB Lady Supplementary card (wife's) - combined expense", cardId: "uob_lady_supp_8959" },
        { matchType: "paynowRecipient", matchValue: "INSPIRE MEDICAL", type: "not_expense", reason: "Transfer to own clinic" },
      ],
      categoryRules: [{ merchantPattern: "PLAYTOMIC", category: "Badminton" }],
      selfTransferAccounts: ["7831", "3561"],
      excludedExpenses: [],
    } },
  ];
  db.expense_sync_log = [];
  db.expense_sync_pending = [];
  db.expense_sync_state = [];
  db.telegram_poll_state = [{ id: 1, last_update_id: 0, locked_at: null }];
  db.telegram_session_state = [];
  db.telegram_job_watch = [];
}

function matches(row: Row, params: URLSearchParams) {
  for (const [k, v] of params) {
    if (["select", "on_conflict", "columns", "or", "order", "limit"].includes(k)) continue;
    const [op, ...rest] = v.split(".");
    const val = rest.join(".");
    const cell = row[k] == null ? null : String(row[k]);
    if (op === "eq" && cell !== val) return false;
    if (op === "in" && !val.replace(/^\(|\)$/g, "").split(",").map((s) => s.replace(/^"|"$/g, "")).includes(cell ?? "")) return false;
    if (op === "gte" && !(cell! >= val)) return false;
    if (op === "lt" && !(cell! < val)) return false;
  }
  return true;
}

export async function restFetch(url: URL, init: RequestInit): Promise<Response> {
  const table = url.pathname.replace("/rest/v1/", "");
  const rows = (db[table] ??= []);
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  const single = (headers.get("Accept") ?? "").includes("vnd.pgrst.object");
  const out = (data: Row[]) => (single ? (data.length ? Response.json(data[0]) : new Response(JSON.stringify({ code: "PGRST116" }), { status: 406 })) : Response.json(data));
  if (method === "GET") return out(rows.filter((r) => matches(r, url.searchParams)));
  const body = init.body ? JSON.parse(String(init.body)) : null;
  if (method === "PATCH") {
    const hit = rows.filter((r) => matches(r, url.searchParams));
    for (const r of hit) Object.assign(r, body);
    return out(hit);
  }
  if (method === "POST") {
    const list = Array.isArray(body) ? body : [body];
    const upsert = (headers.get("Prefer") ?? "").includes("merge-duplicates");
    const conflict = (url.searchParams.get("on_conflict") ?? (table === "expense_sync_state" ? "id" : "")).split(",").filter(Boolean);
    const inserted: Row[] = [];
    for (const item of list) {
      const existing = upsert && conflict.length ? rows.find((r) => conflict.every((c) => String(r[c]) === String(item[c]))) : undefined;
      if (existing) { Object.assign(existing, item); inserted.push(existing); continue; }
      const row = { ...item };
      if (table === "expense_sync_pending") { row.id = seq++; row.resolved_at = null; }
      if (table === "expense_sync_log") row.decided_at = item.decided_at ?? new Date().toISOString();
      rows.push(row);
      inserted.push(row);
    }
    return out(inserted);
  }
  return new Response("unhandled rest", { status: 500 });
}

