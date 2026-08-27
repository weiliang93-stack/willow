// Supabase Edge Function: lets teleconsult-tracker's "End shift" button
// write the session's rows straight into the owner's real Accounts Google
// Sheet, instead of the user copy-pasting them by hand ("Copy for
// sheet"/"Copy both rows" in the app remain as a fallback).
//
// Called by the app itself as the signed-in user (via
// SupaSync.invokeFunction, which attaches the session's access token), not
// by cron — verify_jwt is left on, and the resolved user id is checked
// against WILLOW_USER_ID as a second layer, same reasoning as
// template-edit: the service-role client this function uses to talk to
// Supabase bypasses RLS, so this check is what actually stops another
// Supabase user from hitting the function and writing into the doctor's
// real Accounts sheet.
//
// The client sends already-computed rows (same shape as what "Copy for
// sheet" builds — see teleconsult-tracker/script.js's buildRowCells) rather
// than raw session counts: this function does not re-derive Whitecoat/
// Fullerton pay logic, it only writes what it's given. That's a deliberate
// choice for a single-user personal app — duplicating the pay-rate math
// here would just be a second place for it to drift out of sync with the
// client. Column J (Comment) values like "7/48" or "2 over" are written as
// literal text (RAW valueInputOption + JSON string type), not left to
// Sheets' own smart parsing — that's the exact bug the in-app clipboard
// copy hit once already (a comment like "13/5" landing as a right-aligned
// number). The date is sent as {year, month, day} and converted to a Sheets
// serial number server-side instead of a "D/M/YYYY" string, so there's no
// locale-parsing ambiguity either.
//
// Always appends to the leftmost tab — same "no fixed tab name, a new one
// is added every month" convention as sheet-budget-sync/sheet-training-
// sync, confirmed against the real Accounts sheet (newest month tab is
// always frontmost). The append position itself is found by explicitly
// scanning column A for the first blank row once the log's own data has
// begun (see findLogEndRow) rather than trusting values.append's built-in
// table auto-detection — that auto-detection inserted new rows at the very
// top of the sheet once already, since the real per-day log doesn't start
// at row 1 (rows above it are a header + summary/bonus block with a blank
// column A throughout, which the auto-detection read as "empty table").
// Row formatting (background color per column E-I, alignment, and the
// Comment column's black box border) is read directly off the real sheet
// — see teleconsult-tracker/CLAUDE.md entry — and applied via a
// batchUpdate right after the values write, using that same computed row
// number so it never touches unrelated rows. If that formatting call fails
// after the values already landed, this still reports success (with a
// warning) rather than implying nothing was written — the numbers are
// correct in the sheet either way, just possibly uncoloured.
//
// Required secrets, beyond what the other sheet-sync functions already use:
//   GOOGLE_ACCOUNTS_SHEET_ID - the id from the Accounts sheet's URL
//                              (docs.google.com/spreadsheets/d/<this>/edit)
// The service account needs Editor (not just Viewer) access to this sheet
// — already granted as of this feature shipping (confirmed via the
// sheet's own Share dialog), despite every *other* thing that's touched
// this sheet (the telemed-locum-claims skill etc.) going through the
// owner's own Google login via Composio instead.

import { createClient } from "npm:@supabase/supabase-js@2";
import { JWT } from "npm:google-auth-library@9";

const USER_ID = Deno.env.get("WILLOW_USER_ID")!;
const SHEET_ID = Deno.env.get("GOOGLE_ACCOUNTS_SHEET_ID")!;
const SERVICE_ACCOUNT_EMAIL = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL")!;
const SERVICE_ACCOUNT_KEY = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY")!.replace(/\\n/g, "\n");

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// Same cross-origin situation as template-edit: called directly from the
// browser, not server-to-server, so CORS preflight needs answering.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

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

interface TabInfo {
  sheetId: number;
  title: string;
  index: number;
}

async function getTabs(accessToken: string): Promise<TabInfo[]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties(sheetId,title,index)`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`sheets.get failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.sheets ?? []).map((s: { properties: TabInfo }) => s.properties);
}

async function getLeftmostTab(accessToken: string): Promise<TabInfo> {
  const tabs = await getTabs(accessToken);
  if (tabs.length === 0) throw new Error("spreadsheet has no tabs");
  tabs.sort((a, b) => a.index - b.index);
  return tabs[0];
}

// Days since the Sheets/Excel epoch (Dec 30 1899) — sending a real serial
// number instead of a "D/M/YYYY" string sidesteps any locale-dependent
// date parsing on Google's end entirely.
function sheetsDateSerial(year: number, month: number, day: number): number {
  const target = Date.UTC(year, month - 1, day);
  const epoch = Date.UTC(1899, 11, 30);
  return Math.round((target - epoch) / 86_400_000);
}

function hexToRgb(hex: string): { red: number; green: number; blue: number } {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`invalid color "${hex}"`);
  return { red: parseInt(m[1], 16) / 255, green: parseInt(m[2], 16) / 255, blue: parseInt(m[3], 16) / 255 };
}

const WHITE = "#ffffff";

interface InputRow {
  company: string;
  venue: string;
  hours: number;
  pay: number;
  comment: string;
  bg: string; // hex fill for columns E-I, e.g. "#f4cccc" (Whitecoat) or "#9900ff" (Fullerton)
}

function validateRow(r: unknown, i: number): InputRow {
  const row = r as Record<string, unknown>;
  if (typeof row?.company !== "string" || !row.company) throw new Error(`rows[${i}].company is required`);
  if (typeof row?.venue !== "string" || !row.venue) throw new Error(`rows[${i}].venue is required`);
  if (typeof row?.hours !== "number" || !Number.isFinite(row.hours)) throw new Error(`rows[${i}].hours must be a number`);
  if (typeof row?.pay !== "number" || !Number.isFinite(row.pay)) throw new Error(`rows[${i}].pay must be a number`);
  if (typeof row?.comment !== "string") throw new Error(`rows[${i}].comment must be a string`);
  if (typeof row?.bg !== "string" || !/^#[0-9a-f]{6}$/i.test(row.bg)) throw new Error(`rows[${i}].bg must be a "#rrggbb" color`);
  return row as unknown as InputRow;
}

// Finds the row right after the daily log's last real entry. Deliberately
// does NOT use values.append's own "find the table automatically" behavior
// (insertDataOption=INSERT_ROWS anchored at A1) — that auto-detection
// looks at whether the anchor cell/row has data, and this sheet's real
// per-day log doesn't start at row 1: rows above it are a header + summary/
// bonus block where column A is blank throughout. Anchoring table-detection
// at A1 saw that blank column and decided the table was empty, inserting
// new rows at the very top instead of after the real log (hit once already
// — see git history). Scanning column A explicitly for "first blank row
// after data has been seen" sidesteps that entirely, matching the same
// approach the confirm-tm-income skill already uses by hand.
async function findLogEndRow(accessToken: string, tabTitle: string): Promise<number> {
  const range = `${tabTitle}!A1:A1000`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`values.get failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const rows: unknown[][] = data.values ?? [];
  let seenData = false;
  for (let i = 0; i < rows.length; i++) {
    const cell = rows[i]?.[0];
    const hasValue = cell !== undefined && cell !== null && String(cell).trim() !== "";
    if (hasValue) {
      seenData = true;
    } else if (seenData) {
      return i + 1; // 1-indexed sheet row: first blank once the log's own data has begun
    }
  }
  // No gap found within the fetched window (no log yet, or it runs to the
  // very end of what was fetched) — append right after the last row seen.
  return rows.length + 1;
}

async function writeRows(accessToken: string, tabTitle: string, startRow: number, valuesRows: unknown[][]): Promise<void> {
  const endRow = startRow + valuesRows.length - 1;
  const range = `${tabTitle}!A${startRow}:J${endRow}`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ range, values: valuesRows }),
  });
  if (!res.ok) throw new Error(`values.update failed: ${res.status} ${await res.text()}`);
}

// Column layout read directly off the real sheet (see the CLAUDE.md entry
// for teleconsult-tracker): A Date / B Day / C-D blank Start-End / E Company
// / F Venue / G blank Pay-h / H Hours / I Pay / J Comment. A/B center,
// C-F left, G-I right, J left with a black box border — the only column
// with an explicit border.
function formatRequestsForRow(sheetId: number, rowIndex0: number, jobBg: string): unknown[] {
  const bg = hexToRgb(jobBg);
  const white = hexToRgb(WHITE);
  const range = (startCol: number, endCol: number) => ({
    sheetId,
    startRowIndex: rowIndex0,
    endRowIndex: rowIndex0 + 1,
    startColumnIndex: startCol,
    endColumnIndex: endCol,
  });

  return [
    {
      repeatCell: {
        range: range(0, 1), // A: Date
        cell: { userEnteredFormat: { backgroundColor: white, horizontalAlignment: "CENTER", numberFormat: { type: "DATE", pattern: "d/m/yyyy" } } },
        fields: "userEnteredFormat(backgroundColor,horizontalAlignment,numberFormat)",
      },
    },
    {
      repeatCell: {
        range: range(1, 2), // B: Day
        cell: { userEnteredFormat: { backgroundColor: white, horizontalAlignment: "CENTER" } },
        fields: "userEnteredFormat(backgroundColor,horizontalAlignment)",
      },
    },
    {
      repeatCell: {
        range: range(2, 4), // C-D: blank Start/End
        cell: { userEnteredFormat: { backgroundColor: white, horizontalAlignment: "LEFT" } },
        fields: "userEnteredFormat(backgroundColor,horizontalAlignment)",
      },
    },
    {
      repeatCell: {
        range: range(4, 6), // E-F: Company, Venue
        cell: { userEnteredFormat: { backgroundColor: bg, horizontalAlignment: "LEFT" } },
        fields: "userEnteredFormat(backgroundColor,horizontalAlignment)",
      },
    },
    {
      repeatCell: {
        range: range(6, 9), // G-I: blank Pay/h, Hours, Pay
        cell: { userEnteredFormat: { backgroundColor: bg, horizontalAlignment: "RIGHT" } },
        fields: "userEnteredFormat(backgroundColor,horizontalAlignment)",
      },
    },
    {
      repeatCell: {
        range: range(9, 10), // J: Comment
        cell: {
          userEnteredFormat: {
            backgroundColor: white,
            horizontalAlignment: "LEFT",
            borders: {
              top: { style: "SOLID", width: 1, color: { red: 0, green: 0, blue: 0 } },
              bottom: { style: "SOLID", width: 1, color: { red: 0, green: 0, blue: 0 } },
              left: { style: "SOLID", width: 1, color: { red: 0, green: 0, blue: 0 } },
              right: { style: "SOLID", width: 1, color: { red: 0, green: 0, blue: 0 } },
            },
          },
        },
        fields: "userEnteredFormat(backgroundColor,horizontalAlignment,borders)",
      },
    },
  ];
}

async function applyFormatting(accessToken: string, sheetId: number, startRow: number, rows: InputRow[]): Promise<void> {
  const requests = rows.flatMap((r, i) => formatRequestsForRow(sheetId, startRow - 1 + i, r.bg));
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error(`batchUpdate formatting failed: ${res.status} ${await res.text()}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return jsonResponse(401, { error: "missing Authorization header" });

  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData?.user || authData.user.id !== USER_ID) {
    console.error(
      "teleconsult-end-shift auth rejected:",
      JSON.stringify({ authError: authError?.message, gotUserId: authData?.user?.id, expectedUserId: USER_ID }),
    );
    return jsonResponse(403, { error: "not authorized" });
  }

  let payload: { year?: number; month?: number; day?: number; weekday?: string; rows?: unknown[] };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }

  const { year, month, day, weekday, rows: rawRows } = payload;
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return jsonResponse(400, { error: "year, month, and day must be integers" });
  }
  if (typeof weekday !== "string" || !weekday) return jsonResponse(400, { error: "weekday is required" });
  if (!Array.isArray(rawRows) || rawRows.length === 0) return jsonResponse(400, { error: "rows must be a non-empty array" });
  if (rawRows.length > 10) return jsonResponse(400, { error: "too many rows in one request" });

  let rows: InputRow[];
  try {
    rows = rawRows.map(validateRow);
  } catch (err) {
    return jsonResponse(400, { error: String(err instanceof Error ? err.message : err) });
  }

  if (!SHEET_ID) return jsonResponse(500, { error: "GOOGLE_ACCOUNTS_SHEET_ID is not set" });

  let accessToken: string;
  let tab: TabInfo;
  try {
    accessToken = await getAccessToken();
    tab = await getLeftmostTab(accessToken);
  } catch (err) {
    return jsonResponse(500, { error: `error reading sheet: ${err}` });
  }

  const dateSerial = sheetsDateSerial(year!, month!, day!);
  const valuesRows = rows.map((r) => [dateSerial, weekday, "", "", r.company, r.venue, "", r.hours, r.pay, r.comment]);

  let startRow: number;
  try {
    startRow = await findLogEndRow(accessToken, tab.title);
    await writeRows(accessToken, tab.title, startRow, valuesRows);
  } catch (err) {
    return jsonResponse(500, { error: `error writing rows: ${err}` });
  }

  try {
    await applyFormatting(accessToken, tab.sheetId, startRow, rows);
  } catch (err) {
    console.error("teleconsult-end-shift formatting failed after successful append:", err);
    return jsonResponse(200, {
      ok: true,
      tab: tab.title,
      rowsWritten: rows.length,
      warning: `rows were added but formatting failed: ${err}`,
    });
  }

  return jsonResponse(200, { ok: true, tab: tab.title, rowsWritten: rows.length });
});
