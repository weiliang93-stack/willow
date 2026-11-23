// One-way daily copy of TeoLoh Financial Planning → familyhub.state.fixedCosts.
// The sheet is the master. This function only reads it. It never writes
// to Google, and it updates only the fixedCosts key on the familyhub row.
//
// Trigger: pg_cron net.http_post, verify_jwt off, header x-webhook-secret
// equal to DB_WEBHOOK_SECRET. Schedule 0 21 * * * UTC (~05:00 Asia/Singapore).
// The cron itself is added in the dashboard or SQL editor, not in git.
//
// Before the first run, apply shared/sync-fixed-costs.sql so
// set_familyhub_fixed_costs exists. That function is jsonb_set on
// {fixedCosts} only.
//
// Required secrets, already used by the other sheet jobs:
//   GOOGLE_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
//   WILLOW_USER_ID
//   DB_WEBHOOK_SECRET
//   SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (injected)
// Reader access on the sheet is enough. The sheet id is the TeoLoh
// workbook already named in family-hub/HANDOVER.md.

import { createClient } from "npm:@supabase/supabase-js@2";
import { JWT } from "npm:google-auth-library@9";
import { parseFixedMonthlyExpense } from "./parse.ts";

const USER_ID = Deno.env.get("WILLOW_USER_ID")!;
const WEBHOOK_SECRET = Deno.env.get("DB_WEBHOOK_SECRET")!;
const SERVICE_ACCOUNT_EMAIL = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL")!;
const SERVICE_ACCOUNT_KEY = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY")!.replace(/\\n/g, "\n");

const SHEET_ID = "1JboHp21d8kCjBpLLxrCV0Q1Ok5hgbrSLYlxK3yb4tkY";
const TAB = "Saving/Spending";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

function todaySGT(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
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

async function readGrid(accessToken: string): Promise<unknown[][]> {
  const range = `'${TAB}'`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`values.get failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return Array.isArray(data.values) ? data.values : [];
}

Deno.serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  let costs;
  try {
    const accessToken = await getAccessToken();
    const grid = await readGrid(accessToken);
    costs = parseFixedMonthlyExpense(grid, todaySGT());
  } catch (err) {
    console.error(err instanceof Error ? err.message : "sheet read failed");
    return new Response(`error reading sheet: ${err instanceof Error ? err.message : err}`, { status: 500 });
  }

  const { error } = await supabase.rpc("set_familyhub_fixed_costs", {
    target_user: USER_ID,
    costs,
  });
  if (error) {
    console.error(error.message);
    return new Response(`error writing fixedCosts: ${error.message}`, { status: 500 });
  }

  return new Response(`synced ${costs.items.length} fixed costs as of ${costs.asOf}`);
});
