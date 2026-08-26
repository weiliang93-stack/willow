// Supabase Edge Function: lets teleconsult-tracker auto-detect whether the
// owner is rostered for Whitecoat TM and/or Fullerton TM on a given date,
// by reading their real Google Calendar — instead of tapping the
// "Rostered" toggles by hand every session.
//
// Called by the app itself as the signed-in user (via SupaSync.invokeFunction,
// which attaches the session's access token), not by cron — verify_jwt is
// left on, and the resolved user id is checked against WILLOW_USER_ID as a
// second layer, same reasoning as template-edit/teleconsult-end-shift.
//
// Matching mirrors the confirm-tm-income skill's own documented rules
// exactly, so a day this function calls "rostered" agrees with how the
// owner's calendar is already interpreted everywhere else in this repo:
//   - An event whose summary contains "WC TM" (case-insensitive) -> Whitecoat
//     TM rostered that day.
//   - An event whose summary contains "FHG TM" (case-insensitive) ->
//     Fullerton TM rostered that day.
//   - An event whose summary, trimmed and case-folded, is EXACTLY
//     "inspire medical" (not "INSPIRE COVER" or anything else merely
//     containing "inspire") -> today is an Inspire Medical day, which
//     changes the Whitecoat TM shift from the standard 5hr/$650 slot to a
//     4hr/$250 slot.
// The Whitecoat TM target this suggests is exactly the two values the
// owner already logs against ($650 for a normal day, $250 for an Inspire
// day) — this function never invents a third figure.
//
// Reads the target date's events with a fixed +08:00 (Asia/Singapore, no
// DST) offset on timeMin/timeMax, since the Edge Function runtime itself
// runs in UTC but the "day" being asked about is always a Singapore
// calendar day.
//
// Required secrets, beyond what the other Google-touching functions
// already use (GOOGLE_SERVICE_ACCOUNT_EMAIL/PRIVATE_KEY, WILLOW_USER_ID):
//   GOOGLE_CALENDAR_ID - the owner's calendar id, which for a personal
//                        Google Calendar is just their email address
//                        (e.g. weiliang93@gmail.com)
// The service account needs the calendar shared with it (Viewer /
// "See all event details" is enough — this only reads, never writes) and
// the Calendar API enabled on whichever Google Cloud project the service
// account belongs to (a separate one-time toggle from Sheets/Docs).

import { createClient } from "npm:@supabase/supabase-js@2";
import { JWT } from "npm:google-auth-library@9";

const USER_ID = Deno.env.get("WILLOW_USER_ID")!;
const CALENDAR_ID = Deno.env.get("GOOGLE_CALENDAR_ID")!;
const SERVICE_ACCOUNT_EMAIL = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL")!;
const SERVICE_ACCOUNT_KEY = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY")!.replace(/\\n/g, "\n");

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// Same cross-origin situation as template-edit/teleconsult-end-shift:
// called directly from the browser, so CORS preflight needs answering.
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
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error("failed to obtain Google access token");
  return token;
}

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

interface CalendarEvent {
  summary?: string;
}

async function fetchDayEvents(accessToken: string, year: number, month: number, day: number): Promise<CalendarEvent[]> {
  const dateStr = `${year}-${pad2(month)}-${pad2(day)}`;
  const timeMin = `${dateStr}T00:00:00+08:00`;
  const timeMax = `${dateStr}T23:59:59+08:00`;
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events` +
    `?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&fields=items(summary)`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`calendar events.list failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.items ?? [];
}

function norm(s: string | undefined): string {
  return (s ?? "").trim().toLowerCase();
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
      "teleconsult-check-roster auth rejected:",
      JSON.stringify({ authError: authError?.message, gotUserId: authData?.user?.id, expectedUserId: USER_ID }),
    );
    return jsonResponse(403, { error: "not authorized" });
  }

  let payload: { year?: number; month?: number; day?: number };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }

  const { year, month, day } = payload;
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return jsonResponse(400, { error: "year, month, and day must be integers" });
  }
  if (!CALENDAR_ID) return jsonResponse(500, { error: "GOOGLE_CALENDAR_ID is not set" });

  let events: CalendarEvent[];
  try {
    const accessToken = await getAccessToken();
    events = await fetchDayEvents(accessToken, year!, month!, day!);
  } catch (err) {
    return jsonResponse(500, { error: `error reading calendar: ${err}` });
  }

  let wcRostered = false;
  let fhgRostered = false;
  let isInspireDay = false;
  const matchedEvents: string[] = [];

  for (const ev of events) {
    const summary = ev.summary ?? "";
    const summaryNorm = norm(summary);
    let matched = false;
    if (summaryNorm.includes("wc tm")) {
      wcRostered = true;
      matched = true;
    }
    if (summaryNorm.includes("fhg tm")) {
      fhgRostered = true;
      matched = true;
    }
    if (summaryNorm === "inspire medical") {
      isInspireDay = true;
      matched = true;
    }
    if (matched) matchedEvents.push(summary);
  }

  const wcTarget = wcRostered ? (isInspireDay ? 250 : 650) : null;

  return jsonResponse(200, {
    ok: true,
    wcRostered,
    wcTarget,
    fhgRostered,
    isInspireDay,
    matchedEvents,
  });
});
