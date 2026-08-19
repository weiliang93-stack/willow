// Supabase Edge Function: two-way sync between a dedicated Google Sheet and
// training-app's workout data.
//   - Pulls exercise plan updates from a "Plan" tab: each row (Focus,
//     Exercise, Sets, Reps, Weight, Equipment) is matched to an existing
//     template/exercise and applied as an override, or added as a new
//     custom exercise if no match is found. Sheet-driven changes only ever
//     ADD or UPDATE exercises — they never delete anything from the app,
//     even if a row disappears from the sheet.
//   - Pushes logged workout sets into the leftmost tab, one row per set, in
//     the same shape as training-app's own CSV export (Date, Day, Focus,
//     Exercise, Set, Weight (kg), Reps, RPE). Append-only: each run reads
//     training-app's state.log, skips any entry whose `id` has already
//     been pushed (tracked in training_sheet_sync_state, see
//     shared/training-sheet-sync-schema.sql), and appends rows only for
//     what's new since the last run.
//
// Plan-tab matching rules:
//   - A row's Focus must match exactly one template's `focus` text (from
//     state.templates, which rides along in the synced app_state blob —
//     see the comment on saveState() in training-app/script.js). Rows
//     whose focus matches zero or more than one template (e.g. two
//     templates both named "Rest — Clinic") are skipped, since there's no
//     safe way to pick a target.
//   - Within that template, a row's Exercise is matched by its current
//     effective name (base name, or the overridden name if the exercise
//     was renamed in the app) against ALL of that template's exercises,
//     including ones the user has soft-deleted. This is deliberate: it
//     stops a sheet row from resurrecting a deleted exercise as a
//     duplicate. A match against a deleted exercise is left alone
//     entirely (no override applied) rather than un-deleting it.
//   - No match found -> added as a new custom exercise (same as using the
//     app's own "add exercise" button).
//   - Match found (and not deleted) -> Sets/Reps/Weight/Equipment cells
//     that differ from the exercise's current effective values are saved
//     as an override, same shape as the app's own manual edit feature.
//     Blank cells leave that field untouched.
//
// Known limitation shared with the app's own multi-device sync: app_state
// is a single JSON blob synced last-write-wins (see SupaSync.pushState in
// training-app/script.js). If the app is open in a browser tab when this
// runs, a plan update written here can be silently overwritten the next
// time that tab calls saveState() — same caveat as commit 68ac46b noted
// for the budget-alert / sheet-budget-sync functions.
//
// This is a separate Google Sheet from the expenses budget sheet, so it
// needs its own sheet ID — see GOOGLE_TRAINING_SHEET_ID below. The
// existing service account (from sheet-budget-sync's setup) is reused,
// but the new sheet must also be shared with that service account's
// email as an Editor, same as the budget sheet was.
//
// The log tab is always the leftmost tab (index 0), same convention as
// sheet-budget-sync, and gets a header row automatically the first time
// it's empty. The plan tab is found by name ("Plan", case-insensitive) —
// see PLAN_TAB_NAME below — and is expected to already have a header row
// (Focus | Exercise | Sets | Reps | Weight | Equipment) with data starting
// on row 2; if no tab with that name exists yet, the plan-pull step is
// skipped (noted in the response) rather than treated as an error, so
// setting this up is optional.
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
const PLAN_TAB_NAME = "plan";

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

async function getTabs(accessToken: string): Promise<{ title: string; index: number }[]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties(title,index)`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`sheets.get failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.sheets ?? []).map((s: any) => s.properties);
}

async function getLeftmostTabTitle(accessToken: string): Promise<string> {
  const sheets = await getTabs(accessToken);
  if (sheets.length === 0) throw new Error("spreadsheet has no tabs");
  sheets.sort((a, b) => a.index - b.index);
  return sheets[0].title;
}

async function findTabByName(accessToken: string, name: string): Promise<string | null> {
  const sheets = await getTabs(accessToken);
  const match = sheets.find((s) => s.title.trim().toLowerCase() === name.trim().toLowerCase());
  return match ? match.title : null;
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

function numOrUndefined(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function strOrUndefined(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
  return s === "" ? undefined : s;
}

// base+custom exercises for a template, in the same stable order/indexing
// as training-app's own exercisesFor(), but read from the synced
// state.templates rather than a hardcoded constant (this function runs
// server-side with no access to script.js's TEMPLATES).
function exercisesForState(state: any, templateIdx: number): any[] {
  return (state.templates[templateIdx].exercises ?? []).concat(state.customExercises[templateIdx] ?? []);
}

function effectiveExState(state: any, templateIdx: number, exIdx: number, baseEx: any): any {
  const override = state.exerciseOverrides[`${templateIdx}-${exIdx}`];
  return override ? { ...baseEx, ...override } : baseEx;
}

function isDeletedState(state: any, templateIdx: number, exIdx: number): boolean {
  return !!state.deletedExercises[`${templateIdx}-${exIdx}`];
}

type PlanRow = { focus: string; exercise: string; sets?: number; reps?: number; weight?: string; equipment?: string };
type PlanResult = { status: "added" | "updated" | "unchanged" | "skipped"; reason?: string };

// Applies one Plan-tab row to `state` in place. See the file header comment
// for the full matching/override rules.
function applyPlanRow(state: any, row: PlanRow): PlanResult {
  if (!Array.isArray(state.templates)) return { status: "skipped", reason: "no templates in synced state yet" };

  const focusMatches = state.templates
    .map((t: any, idx: number) => ({ t, idx }))
    .filter(({ t }: any) => t && t.focus === row.focus);
  if (focusMatches.length !== 1) {
    return {
      status: "skipped",
      reason: focusMatches.length === 0 ? `no template with focus "${row.focus}"` : `focus "${row.focus}" matches multiple templates`,
    };
  }
  const templateIdx = focusMatches[0].idx;

  const all = exercisesForState(state, templateIdx);
  const wanted = row.exercise.trim().toLowerCase();
  let foundExIdx = -1;
  for (let exIdx = 0; exIdx < all.length; exIdx++) {
    const eff = effectiveExState(state, templateIdx, exIdx, all[exIdx]);
    if (String(eff.name ?? "").trim().toLowerCase() === wanted) {
      foundExIdx = exIdx;
      break;
    }
  }

  if (foundExIdx === -1) {
    const newEx: any = { name: row.exercise, sets: row.sets ?? 1, reps: row.reps ?? 1 };
    if (row.equipment) newEx.sub = row.equipment;
    if (row.weight) newEx.weight = row.weight;
    if (!state.customExercises[templateIdx]) state.customExercises[templateIdx] = [];
    state.customExercises[templateIdx].push(newEx);
    return { status: "added" };
  }

  if (isDeletedState(state, templateIdx, foundExIdx)) {
    return { status: "skipped", reason: `"${row.exercise}" is deleted in the app, leaving it alone` };
  }

  const base = all[foundExIdx];
  const key = `${templateIdx}-${foundExIdx}`;
  const nextOverride: any = { ...(state.exerciseOverrides[key] || {}) };
  let changed = false;

  if (row.sets !== undefined && row.sets !== (nextOverride.sets ?? base.sets)) {
    nextOverride.sets = row.sets;
    changed = true;
  }
  if (row.reps !== undefined && row.reps !== (nextOverride.reps ?? base.reps)) {
    nextOverride.reps = row.reps;
    changed = true;
  }
  if (row.weight !== undefined && row.weight !== (nextOverride.weight ?? base.weight ?? "")) {
    nextOverride.weight = row.weight;
    changed = true;
  }
  if (row.equipment !== undefined && row.equipment !== (nextOverride.sub ?? base.sub ?? "")) {
    nextOverride.sub = row.equipment;
    changed = true;
  }

  if (!changed) return { status: "unchanged" };

  // Keep the override minimal: drop any field that now matches the base
  // exercise again, same as the app's own manual-edit save() does.
  for (const k of ["sets", "reps", "weight", "sub"]) {
    if (nextOverride[k] === base[k]) delete nextOverride[k];
  }
  if (Object.keys(nextOverride).length === 0) delete state.exerciseOverrides[key];
  else state.exerciseOverrides[key] = nextOverride;

  return { status: "updated" };
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

  const state: any = trainingRow?.state ?? null;
  const notes: string[] = [];

  let accessToken: string;
  try {
    accessToken = await getAccessToken();
  } catch (err) {
    console.error(err);
    return new Response(`error getting Google access token: ${err}`, { status: 500 });
  }

  // ---- Pull: apply Plan-tab updates into state (in place) ----
  if (state) {
    try {
      const planTabTitle = await findTabByName(accessToken, PLAN_TAB_NAME);
      if (!planTabTitle) {
        notes.push(`no "${PLAN_TAB_NAME}" tab found, skipping plan sync`);
      } else {
        const rawRows = await getTabValues(accessToken, planTabTitle, "A2:F1000");
        let added = 0;
        let updated = 0;
        let skipped = 0;
        for (const r of rawRows) {
          const focus = strOrUndefined(r[0]);
          const exercise = strOrUndefined(r[1]);
          if (!focus || !exercise) continue;
          const row: PlanRow = {
            focus,
            exercise,
            sets: numOrUndefined(r[2]),
            reps: numOrUndefined(r[3]),
            weight: strOrUndefined(r[4]),
            equipment: strOrUndefined(r[5]),
          };
          const result = applyPlanRow(state, row);
          if (result.status === "added") added++;
          else if (result.status === "updated") updated++;
          else if (result.status === "skipped") skipped++;
        }

        if (added || updated) {
          const { error: upsertError } = await supabase
            .from("app_state")
            .upsert({ user_id: USER_ID, app: "training", state, updated_at: new Date().toISOString() });
          if (upsertError) {
            console.error(upsertError);
            notes.push(`plan sync: error writing app_state: ${upsertError.message}`);
          } else {
            notes.push(`plan: ${added} added, ${updated} updated${skipped ? `, ${skipped} skipped` : ""}`);
          }
        } else {
          notes.push(`plan: no changes${skipped ? ` (${skipped} row(s) skipped)` : ""}`);
        }
      }
    } catch (err) {
      console.error(err);
      notes.push(`plan sync failed: ${err}`);
    }
  }

  // ---- Push: append new log entries to the leftmost tab ----
  const log: any[] = state?.log ?? [];
  if (log.length === 0) {
    notes.push("no workout data yet");
    return new Response(notes.join("; "));
  }

  const { data: syncRow, error: syncError } = await supabase
    .from("training_sheet_sync_state")
    .select("synced_ids")
    .eq("id", 1)
    .maybeSingle();
  if (syncError) {
    console.error(syncError);
    notes.push("error reading training_sheet_sync_state");
    return new Response(notes.join("; "), { status: 500 });
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

  if (newEntries.length === 0) {
    notes.push("nothing new to sync");
    return new Response(notes.join("; "));
  }

  let tabTitle: string;
  try {
    tabTitle = await getLeftmostTabTitle(accessToken);
  } catch (err) {
    console.error(err);
    notes.push(`error reading sheet: ${err}`);
    return new Response(notes.join("; "), { status: 500 });
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
    notes.push(`error writing sheet: ${err}`);
    return new Response(notes.join("; "), { status: 500 });
  }

  const updatedSyncedIds = [...syncedIds, ...newEntries.map((e) => e.id)];
  const { error: upsertError } = await supabase
    .from("training_sheet_sync_state")
    .upsert({ id: 1, synced_ids: updatedSyncedIds, updated_at: new Date().toISOString() });
  if (upsertError) {
    console.error(upsertError);
    notes.push(`appended ${dataRows.length} row(s) but failed to update sync state: ${upsertError.message}`);
    return new Response(notes.join("; "), { status: 500 });
  }

  notes.push(`appended ${dataRows.length} row(s) to "${tabTitle}"`);
  return new Response(notes.join("; "));
});
