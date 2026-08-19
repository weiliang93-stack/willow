// Supabase Edge Function: one-way push of logged workout sets into a
// dedicated Google Sheet — one row per set, in the same shape as
// training-app's own CSV export (Date, Day, Focus, Exercise, Set,
// Weight (kg), Reps, RPE).
//
// Append-only: each run reads training-app's state.log, skips any entry
// whose `id` has already been pushed (tracked in
// training_sheet_sync_state, see shared/training-sheet-sync-schema.sql),
// and appends rows only for what's new since the last run. Unlike
// sheet-budget-sync's fixed-cell overwrite, this never rewrites rows it's
// already written, so manual edits/formatting added to already-synced
// rows in the sheet are left alone.
//
// This is a separate Google Sheet from the expenses budget sheet, so it
// needs its own sheet ID — see GOOGLE_TRAINING_SHEET_ID below. The
// existing service account (from sheet-budget-sync's setup) is reused,
// but the new sheet must also be shared with that service account's
// email as an Editor, same as the budget sheet was.
//
// Always writes to the leftmost tab (index 0), same convention as
// sheet-budget-sync, and adds a header row automatically the first time
// the tab is empty.
//
// Auth is via the same Google service account as sheet-budget-sync (not
// your own Google login) so this can run unattended on a schedule.
//
// Meant to be triggered on a schedule by a Database > Cron Job calling
// this via pg_net, same as the other sync functions — see
// sheet-budget-sync/index.ts's header comment for why (missing
// supabase_functions schema on this project rules out Database Webhooks).
//
// Required secrets, in addition to the ones sheet-budget-sync uses:
//   GOOGLE_TRAINING_SHEET_ID - the id from this (separate) sheet's URL
//                              (docs.google.com/spreadsheets/d/<this>/edit)
//   WILLOW_USER_ID, DB_WEBHOOK_SECRET,
//   GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
//                            - reuse the same values already set for the
//                              other functions

import { createClient } from "npm:@supabase/supabase-js@2";
import { JWT } from "npm:google-auth-library@9";

const USER_ID = Deno.env.get("WILLOW_USER_ID")!;
const WEBHOOK_SECRET = Deno.env.get("DB_WEBHOOK_SECRET")!;
const SHEET_ID = Deno.env.get("GOOGLE_TRAINING_SHEET_ID")!;
const SERVICE_ACCOUNT_EMAIL = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL")!;
const SERVICE_ACCOUNT_KEY = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY")!.replace(/\\n/g, "\n");

const HEADER_ROW = ["Date", "Day", "Focus", "Exercise", "Set", "Weight (kg)", "Reps", "RPE"];

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
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`values.get failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return !data.values || data.values.length === 0;
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

Deno.serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  const { data: trainingRow, error: trainingError } = await supabase
    .from("app_state")
    .select("state")
    .eq("user_id", USER_ID)
    .eq("app", "training")
    .maybeSingle();
  if (trainingError) {
    console.error(trainingError);
    return new Response("error reading app_state", { status: 500 });
  }

  const log: any[] = trainingRow?.state?.log ?? [];
  if (log.length === 0) return new Response("no workout data yet");

  const { data: syncRow, error: syncError } = await supabase
    .from("training_sheet_sync_state")
    .select("synced_ids")
    .eq("id", 1)
    .maybeSingle();
  if (syncError) {
    console.error(syncError);
    return new Response("error reading training_sheet_sync_state", { status: 500 });
  }

  const syncedIds: Set<string> = new Set(syncRow?.synced_ids ?? []);
  const newEntries = log
    .filter((e) => e.id && !syncedIds.has(e.id))
    .sort(
      (a, b) =>
        String(a.date).localeCompare(String(b.date)) ||
        (a.templateIdx ?? 0) - (b.templateIdx ?? 0) ||
        (a.exIdx ?? 0) - (b.exIdx ?? 0) ||
        (a.setNumber ?? 0) - (b.setNumber ?? 0)
    );

  if (newEntries.length === 0) return new Response("nothing new to sync");

  let accessToken: string;
  let tabTitle: string;
  try {
    accessToken = await getAccessToken();
    tabTitle = await getLeftmostTabTitle(accessToken);
  } catch (err) {
    console.error(err);
    return new Response(`error reading sheet: ${err}`, { status: 500 });
  }

  const dataRows = newEntries.map((e) => [
    e.date ?? "",
    e.dayFull ?? "",
    e.focus ?? "",
    e.exercise ?? "",
    e.setNumber ?? "",
    e.weight ?? "",
    e.reps ?? "",
    e.rpe ?? "",
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
    .from("training_sheet_sync_state")
    .upsert({ id: 1, synced_ids: updatedSyncedIds, updated_at: new Date().toISOString() });
  if (upsertError) {
    console.error(upsertError);
    return new Response(`appended ${dataRows.length} row(s) but failed to update sync state: ${upsertError.message}`, {
      status: 500,
    });
  }

  return new Response(`appended ${dataRows.length} row(s) to "${tabTitle}"`);
});
