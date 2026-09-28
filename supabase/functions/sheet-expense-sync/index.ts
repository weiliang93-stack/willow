// Supabase Edge Function: two-way-in-effect sync between expenses-app's
// expense log and a dedicated Google Sheet, one row per expense — mirrors
// sheet-training-sync's push side (see that function's header comment for
// the full rationale) but also removes rows for expenses deleted from the
// app, which training-sync's log doesn't need to do. Does not pull
// anything back into the app. Budget-number sync (the R15/R16 cells on
// the monthly budget-tracking sheet) is handled separately by
// sheet-budget-sync — this is a different, dedicated sheet.
//
// Each run:
//   - Appends a row for every expense whose `id` hasn't been pushed yet
//     (tracked in expense_sheet_sync_state, see
//     shared/expense-sheet-sync-schema.sql).
//   - Deletes the row for every previously-pushed `id` that no longer
//     exists in expenses-app's state (i.e. the user deleted it in the app).
// Always operates on the leftmost tab (index 0), same convention as the
// other sheet syncs, and adds a header row automatically the first time
// that tab is empty.
//
// Column F holds the expense id, hidden by default — it's what makes row
// deletion possible (matching a since-deleted app expense back to a
// specific sheet row), but isn't meant to be seen or edited by hand.
//
// Auth is via the same Google service account as the other sheet syncs
// (not your own Google login) so this can run unattended on a schedule —
// the sheet must be shared with that service account's email as an
// Editor, same as the training/budget sheets were.
//
// Meant to be triggered on a schedule by a Database > Cron Job calling
// this via pg_net, same as the other sync functions — see
// sheet-budget-sync/index.ts's header comment for why (missing
// supabase_functions schema on this project rules out Database Webhooks).
//
// Required secrets, in addition to the ones the other sync functions use:
//   GOOGLE_EXPENSE_SHEET_ID - the id from this (separate) sheet's URL
//                             (docs.google.com/spreadsheets/d/<this>/edit)
//   WILLOW_USER_ID, DB_WEBHOOK_SECRET,
//   GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
//                            - reuse the same values already set for the
//                              other functions

import { createClient } from "npm:@supabase/supabase-js@2";
import { JWT } from "npm:google-auth-library@9";

const USER_ID = Deno.env.get("WILLOW_USER_ID")!;
const WEBHOOK_SECRET = Deno.env.get("DB_WEBHOOK_SECRET")!;
const SHEET_ID = Deno.env.get("GOOGLE_EXPENSE_SHEET_ID")!.trim();
const SERVICE_ACCOUNT_EMAIL = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL")!;
const SERVICE_ACCOUNT_KEY = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY")!.replace(/\\n/g, "\n");

const HEADER_ROW = ["Date", "Category", "Payment", "Note", "Amount", "Expense ID"];
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

async function getLeftmostTab(accessToken: string): Promise<TabInfo> {
  const sheets = await getTabs(accessToken);
  if (sheets.length === 0) throw new Error("spreadsheet has no tabs");
  sheets.sort((a, b) => a.index - b.index);
  return sheets[0];
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
  // USER_ENTERED (not RAW) so the Date column is parsed as a real date
  // rather than text, in case anything (e.g. a pivot table or a date
  // filter) is ever built against this sheet.
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
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

// Hides the expense-id column (F) — it's plumbing for row deletion, not
// meant for the user to see or hand-edit.
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

// Maps expense id -> zero-based sheet row index, by reading the whole id
// column. Row 0 is the header, so data starts at row 1.
async function getIdToRowIndex(accessToken: string, tabTitle: string): Promise<Map<string, number>> {
  const idCells = await getTabValues(accessToken, tabTitle, "F:F");
  const map = new Map<string, number>();
  for (let i = 1; i < idCells.length; i++) {
    const id = idCells[i]?.[0];
    if (typeof id === "string" && id) map.set(id, i);
  }
  return map;
}

// Deletes the given zero-based row indices from the sheet in one batch —
// order matters: deleting highest-index rows first means the indices of
// not-yet-deleted rows (all lower) never shift underneath us.
async function deleteRows(accessToken: string, sheetId: number, rowIndices: number[]): Promise<void> {
  const sorted = [...rowIndices].sort((a, b) => b - a);
  const requests = sorted.map((rowIndex) => ({
    deleteDimension: {
      range: { sheetId, dimension: "ROWS", startIndex: rowIndex, endIndex: rowIndex + 1 },
    },
  }));
  await batchUpdate(accessToken, requests);
}

// Resolves a stored cardId ("cash" or a card's id) to the human-readable
// label shown in the app, same mapping as telegram-poll's paymentOptions.
// Falls back to the raw id if the card has since been deleted from the app.
function paymentLabel(cardId: string, cards: any[]): string {
  if (cardId === "cash") return "Cash / Other";
  return cards.find((c) => c.id === cardId)?.name ?? cardId;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
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
  const expenses: any[] = state.expenses ?? [];

  const { data: syncRow, error: syncError } = await supabase
    .from("expense_sheet_sync_state")
    .select("synced_ids")
    .eq("id", 1)
    .maybeSingle();
  if (syncError) {
    console.error(syncError);
    return new Response("error reading expense_sheet_sync_state", { status: 500 });
  }

  const syncedIds: Set<string> = new Set(syncRow?.synced_ids ?? []);
  const liveIds = new Set(expenses.filter((e) => e.id).map((e) => e.id));

  const newEntries = expenses
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
    tab = await getLeftmostTab(accessToken);
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
    const cards: any[] = state.cards ?? [];
    const dataRows = newEntries.map((e) => [
      e.date ?? "",
      e.category ?? "",
      paymentLabel(e.cardId, cards),
      e.note ?? "",
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
    .from("expense_sheet_sync_state")
    .upsert({ id: 1, synced_ids: updatedSyncedIds, updated_at: new Date().toISOString() });
  if (upsertError) {
    console.error(upsertError);
    return new Response(`${notes.join("; ")}, but failed to update sync state: ${upsertError.message}`, { status: 500 });
  }

  return new Response(`${notes.join("; ")} on "${tab.title}"`);
});
