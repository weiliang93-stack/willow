// Supabase Edge Function: pulls the latest month's investment balances for
// Wei Liang and Zhen Ling out of the household net-worth tracker sheet and
// writes them into investment-planner's two matching accounts.
//
// The "Balances" tab is a wide layout, not one row per month: row 4 holds
// a date per column ("Updated On"), and each person's block has an
// "Investments" row (currently row 6 for Wei Liang, row 22 for Zhen Ling)
// with that month's figure in the same column. A new column is added to
// the right each month, so this always reads whichever column in row 4 is
// the last non-empty one, rather than a fixed cell reference.
//
// Only the matching accounts' currentBalance is touched. An account is
// matched by exact name (case-insensitive, trimmed) against
// WEI_LIANG_ACCOUNT_NAME / ZHEN_LING_ACCOUNT_NAME below — rename an
// account in the app and this stops finding it, so keep those constants
// and the account names in sync. If no account with that name exists yet,
// one is created with the sheet's balance and monthlyContribution/
// annualReturnPct left at 0 for you to fill in in the app. Existing
// monthlyContribution and annualReturnPct on a matched account are never
// touched — only currentBalance is ever overwritten by this sync.
//
// Same known limitation as sheet-budget-sync / sheet-training-sync:
// app_state is a single JSON blob synced last-write-wins (see
// SupaSync.pushState in investment-planner/script.js). If the app is open
// in a browser tab when this runs, a balance update written here can be
// silently overwritten the next time that tab calls save().
//
// This is a separate Google Sheet from the expenses/training ones, so it
// needs its own sheet ID — see GOOGLE_BALANCES_SHEET_ID below. The
// existing service account (from sheet-budget-sync's setup) is reused,
// but this sheet must also be shared with that service account's email —
// Viewer is enough, since this only ever reads it.
//
// Required secrets:
//   GOOGLE_BALANCES_SHEET_ID            - the id from this (separate)
//                                          sheet's URL
//   GOOGLE_SERVICE_ACCOUNT_EMAIL,
//   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY  - reused from sheet-budget-sync's
//                                          setup, see that function's
//                                          header comment
//   WILLOW_USER_ID, DB_WEBHOOK_SECRET   - reuse the same values already
//                                          set for the other functions
//
// Meant to be triggered on a schedule by a Database > Cron Job calling
// this via pg_net, same as the other sheet-sync functions.

import { createClient } from "npm:@supabase/supabase-js@2";
import { JWT } from "npm:google-auth-library@9";

const USER_ID = Deno.env.get("WILLOW_USER_ID")!;
const WEBHOOK_SECRET = Deno.env.get("DB_WEBHOOK_SECRET")!;
const SHEET_ID = Deno.env.get("GOOGLE_BALANCES_SHEET_ID")!;
const SERVICE_ACCOUNT_EMAIL = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL")!;
const SERVICE_ACCOUNT_KEY = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY")!.replace(/\\n/g, "\n");

const TAB_NAME = "Balances";
const DATE_ROW = 4;
const WEI_LIANG_ROW = 6;
const ZHEN_LING_ROW = 22;
const WEI_LIANG_ACCOUNT_NAME = "Wei Liang";
const ZHEN_LING_ACCOUNT_NAME = "Zhen Ling";

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

// Fetches rows DATE_ROW, WEI_LIANG_ROW, and ZHEN_LING_ROW in one call and
// returns them as three same-shaped arrays (Sheets omits trailing empty
// cells per row, so these can end up different lengths — callers must
// bounds-check before indexing).
async function fetchRows(accessToken: string): Promise<{ dateRow: unknown[]; weiLiangRow: unknown[]; zhenLingRow: unknown[] }> {
  const ranges = [DATE_ROW, WEI_LIANG_ROW, ZHEN_LING_ROW].map((r) => `${TAB_NAME}!${r}:${r}`);
  const query = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join("&");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchGet?${query}&valueRenderOption=UNFORMATTED_VALUE`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`values.batchGet failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const [dateRange, weiLiangRange, zhenLingRange] = data.valueRanges ?? [];
  return {
    dateRow: dateRange?.values?.[0] ?? [],
    weiLiangRow: weiLiangRange?.values?.[0] ?? [],
    zhenLingRow: zhenLingRange?.values?.[0] ?? [],
  };
}

function lastFilledIndex(row: unknown[]): number {
  for (let i = row.length - 1; i >= 0; i--) {
    if (row[i] !== "" && row[i] !== null && row[i] !== undefined) return i;
  }
  return -1;
}

function numberAt(row: unknown[], idx: number): number | null {
  const v = row[idx];
  return typeof v === "number" ? v : null;
}

function applyBalance(accounts: any[], name: string, balance: number): { accounts: any[]; note: string } {
  const idx = accounts.findIndex((a) => typeof a.name === "string" && a.name.trim().toLowerCase() === name.toLowerCase());
  if (idx === -1) {
    const created = {
      id: crypto.randomUUID(),
      name,
      currentBalance: balance,
      monthlyContribution: 0,
      annualReturnPct: 0,
    };
    return { accounts: [...accounts, created], note: `created "${name}" with balance ${balance}` };
  }
  if (accounts[idx].currentBalance === balance) {
    return { accounts, note: `"${name}" balance unchanged (${balance})` };
  }
  const updated = accounts.slice();
  updated[idx] = { ...updated[idx], currentBalance: balance };
  return { accounts: updated, note: `"${name}" balance updated to ${balance}` };
}

Deno.serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  let dateRow: unknown[], weiLiangRow: unknown[], zhenLingRow: unknown[];
  try {
    const accessToken = await getAccessToken();
    ({ dateRow, weiLiangRow, zhenLingRow } = await fetchRows(accessToken));
  } catch (err) {
    console.error(err);
    return new Response(`error reading sheet: ${err}`, { status: 500 });
  }

  const latestIdx = lastFilledIndex(dateRow);
  if (latestIdx === -1) {
    return new Response(`row ${DATE_ROW} on "${TAB_NAME}" has no dates — nothing to sync`, { status: 500 });
  }

  const weiLiangBalance = numberAt(weiLiangRow, latestIdx);
  const zhenLingBalance = numberAt(zhenLingRow, latestIdx);

  const { data: row, error } = await supabase
    .from("app_state")
    .select("state")
    .eq("user_id", USER_ID)
    .eq("app", "investment")
    .maybeSingle();
  if (error) {
    console.error(error);
    return new Response("error reading app_state", { status: 500 });
  }

  const state = row?.state ?? { annualExpenses: 0, withdrawalRate: 4, accounts: [], horizonMode: "auto" };
  let accounts = state.accounts ?? [];
  const notes: string[] = [];

  if (weiLiangBalance === null) {
    notes.push(`row ${WEI_LIANG_ROW}, col ${latestIdx} is empty or non-numeric — leaving ${WEI_LIANG_ACCOUNT_NAME} untouched`);
  } else {
    const result = applyBalance(accounts, WEI_LIANG_ACCOUNT_NAME, weiLiangBalance);
    accounts = result.accounts;
    notes.push(result.note);
  }

  if (zhenLingBalance === null) {
    notes.push(`row ${ZHEN_LING_ROW}, col ${latestIdx} is empty or non-numeric — leaving ${ZHEN_LING_ACCOUNT_NAME} untouched`);
  } else {
    const result = applyBalance(accounts, ZHEN_LING_ACCOUNT_NAME, zhenLingBalance);
    accounts = result.accounts;
    notes.push(result.note);
  }

  if (accounts !== state.accounts) {
    const { error: upsertError } = await supabase
      .from("app_state")
      .upsert({ user_id: USER_ID, app: "investment", state: { ...state, accounts }, updated_at: new Date().toISOString() });
    if (upsertError) {
      console.error(upsertError);
      return new Response(`${notes.join("; ")}; error writing app_state: ${upsertError.message}`, { status: 500 });
    }
  }

  return new Response(`${notes.join("; ")} (column index ${latestIdx} on "${TAB_NAME}")`);
});
