// Supabase Edge Function: lets a Home Screen widget (Scriptable, personal
// device script — see money/'s and the widget's own comments) read
// today's planned workout and log a set directly, without opening
// training-app or the Telegram bot. Called by the widget's companion
// script as the signed-in user (SupaSync-style: Authorization: Bearer
// <access token>), same auth pattern as template-edit and
// teleconsult-end-shift — verify_jwt stays on, and the resolved user id
// is checked against WILLOW_USER_ID as a second layer, since the
// service-role client this function uses bypasses RLS.
//
// Two actions, one endpoint:
//   { action: "today" }
//     Resolves today's planned exercises (mirroring training-app's own
//     schedule/override/deletion logic — same mirror telegram-poll's
//     resolveTodayExercises already keeps, duplicated here rather than
//     imported, matching this repo's existing convention of each
//     function carrying its own copy of small shared logic, e.g.
//     budget-alert's copy of getCardCycleRange) and returns one row per
//     not-yet-done set: which exercise/set it is, its planned
//     weight/reps, and the most recent logged weight/reps/RPE for that
//     exact exercise+set ("same as last time"). The widget renders
//     these read-only — no schedule logic lives in the widget itself.
//   { action: "log", templateIdx, exIdx, setNumber, weight, reps, rpe }
//     or { action: "log", adhoc: true, exerciseName, weight, reps, rpe }
//     Logs exactly one set, mirroring telegram-poll's finishSet /
//     finishAdhocSet: reads the current training app_state fresh,
//     writes done/actualWeight/actualReps/rpe for that slot (templated
//     sets only) and appends a `log` entry (day: "Widget"), then
//     upserts the whole row back — same whole-state read-then-write
//     telegram-poll already uses, which is what keeps this safe against
//     a stale widget read: today's plan is always re-resolved fresh on
//     each "today" call, and the actual write reads the row again
//     immediately before mutating it, rather than trusting whatever the
//     widget cached from its last refresh.
//
// Required secrets: none new — reuses WILLOW_USER_ID, SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, already set for the other functions.

import { createClient } from "npm:@supabase/supabase-js@2";

const USER_ID = Deno.env.get("WILLOW_USER_ID")!;
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

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Singapore local time — same reasoning as every other date-sensitive
// function in this repo (Edge Functions run in UTC).
function todayStr() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function todaySlotIndex() {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Singapore", weekday: "short" }).format(new Date());
  const order = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return order.indexOf(weekday);
}

const DEFAULT_TRAINING_STATE = {
  order: [0, 1, 2, 3, 4, 5, 6],
  log: [],
  done: {},
  actualWeight: {},
  actualReps: {},
  rpe: {},
  exerciseOverrides: {},
  customExercises: {},
  deletedExercises: {},
  weekKey: null,
  restEndTime: null,
  templates: null,
};

async function getAppState(app: string): Promise<any> {
  const { data, error } = await supabase.from("app_state").select("state").eq("user_id", USER_ID).eq("app", app).maybeSingle();
  if (error) throw error;
  return data?.state ?? null;
}

async function setAppState(app: string, state: unknown) {
  const { error } = await supabase
    .from("app_state")
    .upsert({ user_id: USER_ID, app, state, updated_at: new Date().toISOString() });
  if (error) throw error;
}

function resolveTodayExercises(state: any) {
  const templates = state.templates;
  if (!Array.isArray(templates) || templates.length !== 7) return null; // not synced yet

  const order: number[] = Array.isArray(state.order) && state.order.length === 7 ? state.order : [0, 1, 2, 3, 4, 5, 6];
  const slotIdx = todaySlotIndex();
  const templateIdx = order[slotIdx];
  const template = templates[templateIdx];
  const focus = template?.focus ?? "Workout";

  const base = template?.exercises ?? [];
  const custom = state.customExercises?.[templateIdx] ?? [];
  const combined = [...base, ...custom];

  const overrides = state.exerciseOverrides || {};
  const deleted = state.deletedExercises || {};

  const exercises = combined
    .map((baseEx: any, exIdx: number) => {
      const override = overrides[`${templateIdx}-${exIdx}`];
      const ex = override ? { ...baseEx, ...override } : baseEx;
      return { exIdx, name: ex.name, sets: ex.sets, reps: ex.reps, weight: ex.weight || null };
    })
    .filter((_: any, exIdx: number) => !deleted[`${templateIdx}-${exIdx}`]);

  return { templateIdx, focus, exercises };
}

function trainingKey(templateIdx: number, exIdx: number, setIdx: number) {
  return `${templateIdx}-${exIdx}-${setIdx}`;
}

function findLastLogged(state: any, exerciseName: string, setNumber: number) {
  const log: any[] = state.log || [];
  const matches = log
    .filter((e) => e.exercise === exerciseName && e.setNumber === setNumber && e.weight)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return matches.length ? matches[matches.length - 1] : null;
}

async function handleToday() {
  const state = (await getAppState("training")) ?? { ...DEFAULT_TRAINING_STATE };
  const resolved = resolveTodayExercises(state);

  if (!resolved) {
    return jsonResponse(200, { ok: true, synced: false, focus: null, sets: [] });
  }

  if (resolved.exercises.length === 0) {
    return jsonResponse(200, { ok: true, synced: true, restDay: true, focus: resolved.focus, sets: [] });
  }

  const done = state.done || {};
  const sets: Record<string, unknown>[] = [];
  for (const ex of resolved.exercises) {
    for (let setNumber = 1; setNumber <= ex.sets; setNumber++) {
      const k = trainingKey(resolved.templateIdx, ex.exIdx, setNumber - 1);
      if (done[k]) continue; // already logged today — nothing left for the widget to offer
      const last = findLastLogged(state, ex.name, setNumber);
      sets.push({
        templateIdx: resolved.templateIdx,
        exIdx: ex.exIdx,
        setNumber,
        exercise: ex.name,
        plannedWeight: ex.weight,
        plannedReps: ex.reps,
        lastWeight: last?.weight ?? null,
        lastReps: last?.reps ?? null,
        lastRpe: last?.rpe ?? null,
      });
    }
  }

  return jsonResponse(200, { ok: true, synced: true, restDay: false, focus: resolved.focus, sets });
}

async function handleLog(payload: any) {
  const { weight, reps, rpe } = payload;
  if (!weight || !reps) return jsonResponse(400, { error: "weight and reps are required" });

  const state = (await getAppState("training")) ?? { ...DEFAULT_TRAINING_STATE };
  state.log = state.log || [];

  if (payload.adhoc) {
    const { exerciseName } = payload;
    if (!exerciseName) return jsonResponse(400, { error: "exerciseName is required for an adhoc log" });
    state.log.push({
      id: uid(),
      date: todayStr(),
      templateIdx: -1,
      day: "Widget",
      dayFull: "Logged via widget",
      focus: "Quick log",
      exIdx: -1,
      exercise: exerciseName,
      setNumber: 1,
      weight,
      reps,
      rpe: rpe || "",
    });
    await setAppState("training", state);
    return jsonResponse(200, { ok: true, exercise: exerciseName, setNumber: 1, weight, reps, rpe: rpe || "" });
  }

  const { templateIdx, exIdx, setNumber } = payload;
  if (
    typeof templateIdx !== "number" ||
    typeof exIdx !== "number" ||
    typeof setNumber !== "number"
  ) {
    return jsonResponse(400, { error: "templateIdx, exIdx, and setNumber are required" });
  }

  const resolved = resolveTodayExercises(state);
  const ex = resolved?.exercises.find((e) => e.exIdx === exIdx);
  if (!resolved || resolved.templateIdx !== templateIdx || !ex) {
    return jsonResponse(409, { error: "today's plan changed since this was loaded — refresh and try again" });
  }

  const k = trainingKey(templateIdx, exIdx, setNumber - 1);
  state.done = state.done || {};
  state.actualWeight = state.actualWeight || {};
  state.actualReps = state.actualReps || {};
  state.rpe = state.rpe || {};

  state.done[k] = true;
  state.actualWeight[k] = weight;
  state.actualReps[k] = reps;
  if (rpe) state.rpe[k] = rpe;

  state.log.push({
    id: uid(),
    date: todayStr(),
    templateIdx,
    day: "Widget",
    dayFull: "Logged via widget",
    focus: resolved.focus,
    exIdx,
    exercise: ex.name,
    setNumber,
    weight,
    reps,
    rpe: rpe || "",
  });

  await setAppState("training", state);
  return jsonResponse(200, { ok: true, exercise: ex.name, setNumber, weight, reps, rpe: rpe || "" });
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
      "widget-log-set auth rejected:",
      JSON.stringify({ authError: authError?.message, gotUserId: authData?.user?.id, expectedUserId: USER_ID }),
    );
    return jsonResponse(403, { error: "not authorized" });
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }

  if (payload.action === "today") return await handleToday();
  if (payload.action === "log") return await handleLog(payload);
  return jsonResponse(400, { error: `unknown action "${payload.action}"` });
});
