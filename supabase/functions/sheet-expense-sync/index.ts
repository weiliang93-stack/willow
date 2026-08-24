// Supabase Edge Function: pushes expenses-app's expense log into a
// dedicated Google Sheet, one row per expense — same pattern as
// sheet-training-sync's push side (see that function's header comment for
// the full rationale). This is push-only (append new rows); it does not
// pull anything back into the app. Budget-number sync (the R15/R16 cells
// on the monthly budget-tracking sheet) is handled separately by
// sheet-budget-sync — this is a different, dedicated sheet.
//
// Append-only: each run reads expenses-app's state.expenses, skips any
// entry whose `id` has already been pushed (tracked in
// expense_sheet_sync_state, see shared/expense-sheet-sync-schema.sql), and
// appends rows only for what's new since the last run. Always writes to
// the leftmost tab (index 0), same convention as the other sheet syncs,
// and adds a header row automatically the first time that tab is empty.
//
// Auth is via the same Google service account as the other sheet syncs
// (not your own Google login) so this can run unattended on a schedule —
// the new sheet must be shared with that service account's email as an
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
const SHEET_ID = Deno.env.get("GOOGLE_EXPENSE_SHEET_ID")!;
const SERVICE_ACCOUNT_EMAIL = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL")!;
const SERVICE_ACCOUNT_KEY = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY")!.replace(/\\n/g, "\n");

const HEADER_ROW = ["Date", "Category", "Payment", "Note", "Amount"];

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

async function tabIsEmpty(accessToken: string, tabTitle: string): Promise<boolean> {
  const range = `${tabTitle}!A1`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`values.get failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.values ?? []).length === 0;
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
  const notes: string[] = [];

  if (expenses.length === 0) {
    return new Response("no expenses yet");
  }

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
  const newEntries = expenses
    .filter((e) => e.id && !syncedIds.has(e.id))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  if (newEntries.length === 0) {
    return new Response("nothing new to sync");
  }

  let accessToken: string;
  let tabTitle: string;
  try {
    accessToken = await getAccessToken();
    tabTitle = await getLeftmostTabTitle(accessToken);
  } catch (err) {
    console.error(err);
    return new Response(`error reading sheet: ${err}`, { status: 500 });
  }

  const cards: any[] = state.cards ?? [];
  const dataRows = newEntries.map((e) => [
    e.date ?? "",
    e.category ?? "",
    paymentLabel(e.cardId, cards),
    e.note ?? "",
    e.amount ?? "",
  ]);

  try {
    const needsHeader = await tabIsEmpty(accessToken, tabTitle);
    await appendRows(accessToken, tabTitle, needsHeader ? [HEADER_ROW, ...dataRows] : dataRows);
  } catch (err) {
    console.error(err);
    return new Response(`error writing sheet: ${err}`, { status: 500 });
  }

  const updatedSyncedIds = [...syncedIds, ...newEntries.map((e) => e.id)];
  const { error: upsertError } = await supabase
    .from("expense_sheet_sync_state")
    .upsert({ id: 1, synced_ids: updatedSyncedIds, updated_at: new Date().toISOString() });
  if (upsertError) {
    console.error(upsertError);
    return new Response(`appended ${dataRows.length} row(s) but failed to update sync state: ${upsertError.message}`, { status: 500 });
  }

  notes.push(`appended ${dataRows.length} row(s) to "${tabTitle}"`);
  return new Response(notes.join("; "));
});
