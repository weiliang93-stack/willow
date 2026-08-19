// Supabase Edge Function: pulls the current month's budget out of a
// Google Sheet and writes it into app_state.monthlyBudget for the
// expenses app, so the number entered in the sheet is the one the app
// (and budget-alert) actually uses.
//
// The sheet gets a new tab every month with no fixed naming convention,
// but new tabs are always added as the leftmost tab — so this always
// reads the leftmost (index 0) tab rather than trying to guess a tab
// name from the current date. The budget lives in the same cell (R15)
// on every monthly tab.
//
// Auth is via a Google service account (not your own Google login) so
// this can run unattended on a schedule: the sheet is shared read-only
// with the service account's email, and the account's private key is
// used to mint a short-lived access token on each run. Nothing here can
// write to the sheet — only spreadsheets.readonly scope is requested.
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

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function getAccessToken(): Promise<string> {
  const jwt = new JWT({
    email: SERVICE_ACCOUNT_EMAIL,
    key: SERVICE_ACCOUNT_KEY,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
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

async function getBudgetValue(accessToken: string, tabTitle: string): Promise<number | null> {
  const range = `${tabTitle}!${BUDGET_CELL}`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`values.get failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const raw = data.values?.[0]?.[0];
  return typeof raw === "number" ? raw : null;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  let tabTitle: string;
  let budget: number | null;
  try {
    const accessToken = await getAccessToken();
    tabTitle = await getLeftmostTabTitle(accessToken);
    budget = await getBudgetValue(accessToken, tabTitle);
  } catch (err) {
    console.error(err);
    return new Response(`error reading sheet: ${err}`, { status: 500 });
  }

  if (budget === null) {
    return new Response(`${BUDGET_CELL} on "${tabTitle}" is empty or non-numeric — leaving budget untouched`);
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
  if (state.monthlyBudget === budget) {
    return new Response(`budget unchanged (${budget}) from "${tabTitle}"`);
  }

  const { error: upsertError } = await supabase
    .from("app_state")
    .upsert({ user_id: USER_ID, app: "expenses", state: { ...state, monthlyBudget: budget }, updated_at: new Date().toISOString() });
  if (upsertError) {
    console.error(upsertError);
    return new Response("error writing app_state", { status: 500 });
  }

  return new Response(`budget updated to ${budget} from "${tabTitle}"`);
});
