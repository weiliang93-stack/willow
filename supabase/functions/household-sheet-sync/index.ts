// Supabase Edge Function: pushes combined/household expenses into a
// dedicated "Household Expenses" Google Sheet, one row per expense — same
// append+delete pattern as sheet-expense-sync (see that function's header
// comment for the fuller rationale).
//
// Source of truth is app_state row (app = 'expenses_automation',
// user_id = WILLOW_USER_ID)'s `excludedExpenses` array — NOT a dedicated
// table. That row is owned by the bank-email auto-logger routine (see its
// Routine prompt), which classifies charges against `exclusionRules`
// (merchant- or card-based rules marking a charge as shared/combined
// household spend, e.g. the UOB Lady Supplementary and Citibank Rewards
// cards) and appends matches there instead of to the personal expenses
// array. This function only reads and mirrors that array into the sheet;
// it never writes to expenses_automation.
//
// Card display names are derived from `exclusionRules` at read time
// (matched by cardId) rather than hardcoded, so a newly added rule's
// card shows up in the sheet with a sensible label automatically.
//
// Writes to the "Log" tab specifically (found by name, not by leftmost
// index — the sheet's first/leftmost tab is "Summary", a budget-vs-actual
// view computed by formulas that read the Log tab, meant to be what
// opens by default). Column F holds the expense id (hidden), used to
// find and delete a row when the underlying excludedExpenses entry is
// removed.
//
// Auth is via the same Google service account as the other sheet syncs.
// The sheet must be shared with that service account's email as an
// Editor, same as the others.
//
// Meant to be triggered on a schedule by a Database > Cron Job calling
// this via pg_net, same as the other sync functions — see
// sheet-budget-sync/index.ts's header comment for why (missing
// supabase_functions schema on this project rules out Database Webhooks).
//
// Required secrets, in addition to the ones the other sync functions use:
//   GOOGLE_HOUSEHOLD_SHEET_ID - the id from this (separate) sheet's URL
//                               (docs.google.com/spreadsheets/d/<this>/edit)
//   WILLOW_USER_ID, DB_WEBHOOK_SECRET, GOOGLE_SERVICE_ACCOUNT_EMAIL,
//   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
//                            - reuse the same values already set for the
//                              other functions

import { createClient } from "npm:@supabase/supabase-js@2";
import { JWT } from "npm:google-auth-library@9";

const USER_ID = Deno.env.get("WILLOW_USER_ID")!;
const WEBHOOK_SECRET = Deno.env.get("DB_WEBHOOK_SECRET")!;
const SHEET_ID = Deno.env.get("GOOGLE_HOUSEHOLD_SHEET_ID")!.trim();
const SERVICE_ACCOUNT_EMAIL = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL")!;
const SERVICE_ACCOUNT_KEY = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY")!.replace(/\\n/g, "\n");

const LOG_TAB_NAME = "log";
const HEADER_ROW = ["Date", "Card", "Merchant", "Category", "Amount", "Expense ID"];
const ID_COLUMN_INDEX = 5; // zero-based; column F

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

type TabInfo = { title: string; index: number; sheetId: number };

async function getTabs(accessToken: string): Promise<TabInfo[]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties(title,index,sheetId)`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`sheets.get failed for sheet id "${SHEET_ID}": ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.sheets ?? []).map((s: any) => s.properties);
}

async function getLogTab(accessToken: string): Promise<TabInfo> {
  const sheets = await getTabs(accessToken);
  const tab = sheets.find((s) => s.title.trim().toLowerCase() === LOG_TAB_NAME);
  if (!tab) throw new Error(`no "${LOG_TAB_NAME}" tab found`);
  return tab;
}

async function getTabValues(accessToken: string, tabTitle: string, range: string): Promise<any[][]> {
  const fullRange = `${tabTitle}!${range}`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(fullRange)}?valueRenderOption=UNFORMATTED_VALUE`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`values.get failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.values ?? [];
}

async function tabIsEmpty(accessToken: string, tabTitle: string): Promise<boolean> {
  const values = await getTabValues(accessToken, tabTitle, "A1");
  return values.length === 0;
}

async function appendRows(accessToken: string, tabTitle: string, rows: unknown[][]): Promise<void> {
  const range = `${tabTitle}!A1`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: rows }),
  });
  if (!res.ok) throw new Error(`values.append failed: ${res.status} ${await res.text()}`);
}

async function batchUpdate(accessToken: string, requests: unknown[]): Promise<void> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error(`batchUpdate failed: ${res.status} ${await res.text()}`);
}

async function hideIdColumn(accessToken: string, sheetId: number): Promise<void> {
  await batchUpdate(accessToken, [
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: ID_COLUMN_INDEX, endIndex: ID_COLUMN_INDEX + 1 },
        properties: { hiddenByUser: true },
        fields: "hiddenByUser",
      },
    },
  ]);
}

async function getIdToRowIndex(accessToken: string, tabTitle: string): Promise<Map<string, number>> {
  const idCells = await getTabValues(accessToken, tabTitle, "F:F");
  const map = new Map<string, number>();
  for (let i = 1; i < idCells.length; i++) {
    const id = idCells[i]?.[0];
    if (typeof id === "string" && id) map.set(id, i);
  }
  return map;
}

async function deleteRows(accessToken: string, sheetId: number, rowIndices: number[]): Promise<void> {
  const sorted = [...rowIndices].sort((a, b) => b - a);
  const requests = sorted.map((rowIndex) => ({
    deleteDimension: {
      range: { sheetId, dimension: "ROWS", startIndex: rowIndex, endIndex: rowIndex + 1 },
    },
  }));
  await batchUpdate(accessToken, requests);
}

// Builds a cardId -> display label map from exclusionRules, so a newly
// added rule's card shows up with a sensible name automatically instead
// of a raw internal id like "citi_rewards_3902".
function cardLabelsFromRules(exclusionRules: any[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const rule of exclusionRules ?? []) {
    if (!rule.cardId || map.has(rule.cardId)) continue;
    if (rule.matchType === "merchant") {
      map.set(rule.cardId, `${rule.matchValue} (${rule.reason ?? "combined"})`);
    } else if (rule.matchType === "cardLast4") {
      map.set(rule.cardId, rule.reason ?? `card ending ${rule.matchValue}`);
    }
  }
  return map;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  const { data: row, error } = await supabase
    .from("app_state")
    .select("state")
    .eq("user_id", USER_ID)
    .eq("app", "expenses_automation")
    .maybeSingle();
  if (error) {
    console.error(error);
    return new Response("error reading app_state", { status: 500 });
  }

  const state = row?.state ?? { excludedExpenses: [], exclusionRules: [], categoryRules: [] };
  const excludedExpenses: any[] = state.excludedExpenses ?? [];
  const cardLabels = cardLabelsFromRules(state.exclusionRules ?? []);

  const { data: syncRow, error: syncError } = await supabase
    .from("household_expense_sync_state")
    .select("synced_ids")
    .eq("id", 1)
    .maybeSingle();
  if (syncError) {
    console.error(syncError);
    return new Response("error reading household_expense_sync_state", { status: 500 });
  }

  const syncedIds: Set<string> = new Set(syncRow?.synced_ids ?? []);
  const liveIds = new Set(excludedExpenses.filter((e) => e.id).map((e) => e.id));

  const newEntries = excludedExpenses
    .filter((e) => e.id && !syncedIds.has(e.id))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const deletedIds = [...syncedIds].filter((id) => !liveIds.has(id));

  if (newEntries.length === 0 && deletedIds.length === 0) {
    return new Response("nothing new to sync");
  }

  let accessToken: string;
  let tab: TabInfo;
  try {
    accessToken = await getAccessToken();
    tab = await getLogTab(accessToken);
  } catch (err) {
    console.error(err);
    return new Response(`error reading sheet: ${err}`, { status: 500 });
  }

  const notes: string[] = [];

  if (deletedIds.length > 0) {
    try {
      const idToRow = await getIdToRowIndex(accessToken, tab.title);
      const rowIndices = deletedIds.map((id) => idToRow.get(id)).filter((i): i is number => i !== undefined);
      if (rowIndices.length > 0) await deleteRows(accessToken, tab.sheetId, rowIndices);
      notes.push(`removed ${rowIndices.length} deleted expense(s)`);
    } catch (err) {
      console.error(err);
      return new Response(`error removing deleted rows: ${err}`, { status: 500 });
    }
  }

  if (newEntries.length > 0) {
    const dataRows = newEntries.map((e) => [
      e.date ?? "",
      cardLabels.get(e.cardId) ?? e.cardId ?? "",
      e.note ?? "",
      e.category ?? "",
      e.amount ?? "",
      e.id,
    ]);
    try {
      const needsHeader = await tabIsEmpty(accessToken, tab.title);
      await appendRows(accessToken, tab.title, needsHeader ? [HEADER_ROW, ...dataRows] : dataRows);
      if (needsHeader) await hideIdColumn(accessToken, tab.sheetId);
    } catch (err) {
      console.error(err);
      return new Response(`error writing sheet: ${err}`, { status: 500 });
    }
    notes.push(`appended ${dataRows.length} row(s)`);
  }

  const updatedSyncedIds = [...syncedIds].filter((id) => !deletedIds.includes(id)).concat(newEntries.map((e) => e.id));
  const { error: upsertError } = await supabase
    .from("household_expense_sync_state")
    .upsert({ id: 1, synced_ids: updatedSyncedIds, updated_at: new Date().toISOString() });
  if (upsertError) {
    console.error(upsertError);
    return new Response(`${notes.join("; ")}, but failed to update sync state: ${upsertError.message}`, { status: 500 });
  }

  return new Response(`${notes.join("; ")} on "${tab.title}"`);
});
