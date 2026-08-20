// Supabase Edge Function: two-way sync between a Google Sheet and the
// expenses app's budget.
//   - Pulls the current month's budget out of the sheet (cell R15) and
//     writes it into app_state.monthlyBudget, so the number entered in
//     the sheet is the one the app (and budget-alert) actually uses.
//   - Pushes the current month's total spend (computed from app_state,
//     same as budget-alert) back into the sheet (cell R16), so the sheet
//     always shows an up-to-date spent figure without manual entry.
//
// The sheet gets a new tab every month with no fixed naming convention,
// but new tabs are always added as the leftmost tab — so this always
// reads/writes the leftmost (index 0) tab rather than trying to guess a
// tab name from the current date. R15/R16 are in the same position on
// every monthly tab.
//
// Auth is via a Google service account (not your own Google login) so
// this can run unattended on a schedule: the sheet is shared with the
// service account's email as an EDITOR (view-only isn't enough now that
// this writes R16), and the account's private key is used to mint a
// short-lived access token on each run.
//
// Meant to be triggered on a schedule by a Database > Cron Job calling
// this via pg_net, same as budget-alert — see that function's header
// comment for why (missing supabase_functions schema on this project
// rules out Database Webhooks).
//
// Required secrets, in addition to the ones the other functions use:
//   GOOGLE_SERVICE_ACCOUNT_EMAIL        - "client_email" from the service
//                                          account's downloaded JSON key
//   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY  - "private_key" from the same
//                                          JSON key file, including the
//                                          -----BEGIN/END PRIVATE KEY----- lines
//   GOOGLE_SHEET_ID                     - the id from the sheet's URL
//                                          (docs.google.com/spreadsheets/d/<this>/edit)
//   WILLOW_USER_ID, DB_WEBHOOK_SECRET   - reuse the same values already
//                                          set for the other functions

import { createClient } from "npm:@supabase/supabase-js@2";
import { JWT } from "npm:google-auth-library@9";

const USER_ID = Deno.env.get("WILLOW_USER_ID")!;
const WEBHOOK_SECRET = Deno.env.get("DB_WEBHOOK_SECRET")!;
const SHEET_ID = Deno.env.get("GOOGLE_SHEET_ID")!;
const SERVICE_ACCOUNT_EMAIL = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL")!;
const SERVICE_ACCOUNT_KEY = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY")!.replace(/\\n/g, "\n");

const BUDGET_CELL = "R15";
const SPENT_CELL = "R16";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function getAccessToken(): Promise<string> {
  const jwt = new JWT({
    email: SERVICE_ACCOUNT_EMAIL,
    key: SERVICE_ACCOUNT_KEY,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error("failed to obtain Google access token");
  return token;
}

async function getLeftmostTabTitle(accessToken: string): Promise<string> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties(title,index)`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`sheets.get failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const sheets = (data.sheets ?? []).map((s: any) => s.properties);
  if (sheets.length === 0) throw new Error("spreadsheet has no tabs");
  sheets.sort((a: any, b: any) => a.index - b.index);
  return sheets[0].title;
}

async function getCellValue(accessToken: string, tabTitle: string, cell: string): Promise<number | null> {
  const range = `${tabTitle}!${cell}`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`values.get failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const raw = data.values?.[0]?.[0];
  return typeof raw === "number" ? raw : null;
}

async function setCellValue(accessToken: string, tabTitle: string, cell: string, value: number): Promise<void> {
  const range = `${tabTitle}!${cell}`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [[value]] }),
  });
  if (!res.ok) throw new Error(`values.update failed: ${res.status} ${await res.text()}`);
}

// Singapore local time, not UTC — same reasoning as budget-alert and
// telegram-poll: Edge Functions run in UTC, so anything logged between
// midnight and 8am SGT would otherwise land in the wrong month.
function currentMonthSGT(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date())
    .slice(0, 7);
}

function monthlySpend(expenses: any[]): number {
  const thisMonth = currentMonthSGT();
  return (expenses || [])
    .filter((e) => typeof e.date === "string" && e.date.slice(0, 7) === thisMonth)
    .reduce((sum, e) => sum + e.amount, 0);
}

Deno.serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  let accessToken: string;
  let tabTitle: string;
  let budget: number | null;
  try {
    accessToken = await getAccessToken();
    tabTitle = await getLeftmostTabTitle(accessToken);
    budget = await getCellValue(accessToken, tabTitle, BUDGET_CELL);
  } catch (err) {
    console.error(err);
    return new Response(`error reading sheet: ${err}`, { status: 500 });
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

  const state = row?.state ?? { cards: [], expenses: [], categories: [], monthlyBudget: null };
  const notes: string[] = [];

  if (budget === null) {
    notes.push(`${BUDGET_CELL} is empty or non-numeric — leaving budget untouched`);
  } else if (state.monthlyBudget === budget) {
    notes.push(`budget unchanged (${budget})`);
  } else {
    const { error: upsertError } = await supabase
      .from("app_state")
      .upsert({ user_id: USER_ID, app: "expenses", state: { ...state, monthlyBudget: budget }, updated_at: new Date().toISOString() });
    if (upsertError) {
      console.error(upsertError);
      return new Response("error writing app_state", { status: 500 });
    }
    notes.push(`budget updated to ${budget}`);
  }

  const spent = monthlySpend(state.expenses);
  try {
    await setCellValue(accessToken, tabTitle, SPENT_CELL, spent);
    notes.push(`${SPENT_CELL} set to ${spent}`);
  } catch (err) {
    console.error(err);
    return new Response(`${notes.join("; ")}; error writing ${SPENT_CELL}: ${err}`, { status: 500 });
  }

  return new Response(`${notes.join("; ")} on "${tabTitle}"`);
});
