// On-demand read of the Loh Family Google Calendar.
//
// The app calls this as the signed-in user (SupaSync.invokeFunction).
// verify_jwt stays on, and the user id is checked against WILLOW_USER_ID.
// There is no cron.
//
// The calendar's secret iCal address lives only in the function secret
// FAMILY_CAL_ICS_URL. It is never written to the repo, the response, or
// the logs. If the secret is missing, the function returns
// { connected: false } and the app says the Family calendar is not
// connected yet.
//
// Deploy (once), from a machine with the Supabase CLI logged in:
//   supabase functions deploy family-calendar --project-ref fozipnpmmjmmlthkdplf
// Then set the secret in the dashboard (Edge Functions → Secrets), not
// in git:
//   FAMILY_CAL_ICS_URL = the secret iCal URL
// WILLOW_USER_ID is already set for the other functions.

import { createClient } from "npm:@supabase/supabase-js@2";
import { parseIcs } from "./parse.ts";

const USER_ID = Deno.env.get("WILLOW_USER_ID") || "";
const ICS_URL = (Deno.env.get("FAMILY_CAL_ICS_URL") || "").trim();

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

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

function singaporeToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function allowedIcsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (parsed.hostname === "calendar.google.com" || parsed.hostname.endsWith(".calendar.google.com"));
  } catch (_err) {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return jsonResponse(401, { error: "missing Authorization header" });

  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData?.user || !USER_ID || authData.user.id !== USER_ID) {
    return jsonResponse(403, { error: "not authorized" });
  }

  if (!ICS_URL) return jsonResponse(200, { connected: false, reason: "not_configured", events: [] });
  if (!allowedIcsUrl(ICS_URL)) return jsonResponse(200, { connected: false, reason: "bad_url", events: [] });

  let from = singaporeToday();
  try {
    const body = await req.json();
    if (body && typeof body.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.from)) from = body.from;
  } catch (_err) {
    /* empty body still means "from today" */
  }

  try {
    const response = await fetch(ICS_URL, { redirect: "follow", signal: AbortSignal.timeout(8000) });
    if (!response.ok) return jsonResponse(502, { connected: false, error: "calendar fetch failed", events: [] });
    const text = await response.text();
    if (text.length > 8_000_000) return jsonResponse(502, { connected: false, error: "calendar feed is too large", events: [] });
    return jsonResponse(200, { connected: true, from, days: 14, events: parseIcs(text, from, 14) });
  } catch (_err) {
    console.error("family-calendar fetch failed");
    return jsonResponse(502, { connected: false, error: "calendar fetch failed", events: [] });
  }
});
