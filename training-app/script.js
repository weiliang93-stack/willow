const CALENDAR_DAYS = [
  { day: "Mon", full: "Monday" },
  { day: "Tue", full: "Tuesday" },
  { day: "Wed", full: "Wednesday" },
  { day: "Thu", full: "Thursday" },
  { day: "Fri", full: "Friday" },
  { day: "Sat", full: "Saturday" },
  { day: "Sun", full: "Sunday" },
];

// Workout templates. state.order[calendarSlot] = index into this array,
// so a template can be assigned to any calendar day via swapping.
const TEMPLATES = [
  {
    focus: "Chest / Tricep",
    exercises: [
      { name: "Incline Bench Press", sub: "Cable", sets: 5, reps: 5 },
      { name: "Triceps Extension", sub: "Cable", sets: 5, reps: 5 },
    ],
  },
  {
    focus: "Upper Back",
    exercises: [
      {
        name: "Bent Over Row",
        sub: "Barbell",
        sets: 5,
        reps: 5,
        weight: "51–52kg",
      },
      {
        name: "Lat Pulldown",
        sub: "Cable",
        sets: 5,
        reps: 5,
        weight: "~65kg",
        cues: [
          "Elbows down and back — not hands to chest",
          "Bar finishes at upper chest, slight arc",
          "Lead with lats, not biceps/forearms",
          "Slight backward lean from hips, chest stays up",
          "Controlled eccentric, no swing to start the pull",
        ],
      },
      { name: "Standing Cable External Rotation", sub: "Cable", sets: 3, reps: 10 },
    ],
  },
  {
    focus: "Shoulder",
    exercises: [
      { name: "Overhead Press", sub: "Barbell", sets: 5, reps: 5 },
      { name: "Lateral Raise", sub: "Cable", sets: 3, reps: 10 },
      { name: "Face Pull", sub: "Cable", sets: 3, reps: 10 },
    ],
  },
  { focus: "Rest — Clinic", exercises: [] },
  {
    focus: "Legs",
    exercises: [
      { name: "Squat", sub: "Barbell", sets: 5, reps: 5 },
      { name: "Deadlift", sub: "Barbell", sets: 5, reps: 5 },
      { name: "Lunges", sub: "Dumbbell", sets: 5, reps: 10 },
      { name: "Standing Calf Raise", sub: "Dumbbell", sets: 5, reps: 10 },
    ],
  },
  {
    focus: "Arm — short session",
    exercises: [{ name: "Hammer Curl", sub: "Dumbbell", sets: 5, reps: 5 }],
  },
  { focus: "Rest — Clinic", exercises: [] },
];

const DEFAULT_ORDER = TEMPLATES.map((_, i) => i);

const REST_SECONDS = 120;
const STORAGE_KEY = "trainingApp.state";

function todayIndex() {
  const jsDay = new Date().getDay(); // 0 = Sun
  return jsDay === 0 ? 6 : jsDay - 1;
}

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function firstOfMonthStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

// Identifies a week by the date of its Monday, so the checklist can tell
// when a new training week has started (weeks run Mon-Sun, matching the
// day tabs).
function weekKeyFor(d) {
  const day = d.getDay(); // 0 = Sun
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diffToMonday);
  const y = monday.getFullYear();
  const m = String(monday.getMonth() + 1).padStart(2, "0");
  const da = String(monday.getDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
}

function currentWeekKey() {
  return weekKeyFor(new Date());
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function loadState() {
  const empty = {
    done: {},
    actualWeight: {},
    actualReps: {},
    rpe: {},
    order: [...DEFAULT_ORDER],
    log: [],
    exerciseOverrides: {},
    customExercises: {},
    deletedExercises: {},
    weekKey: null,
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    return {
      done: parsed.done || {},
      actualWeight: parsed.actualWeight || {},
      actualReps: parsed.actualReps || {},
      rpe: parsed.rpe || {},
      order: Array.isArray(parsed.order) && parsed.order.length === 7 ? parsed.order : [...DEFAULT_ORDER],
      log: parsed.log || [],
      exerciseOverrides: parsed.exerciseOverrides || {},
      customExercises: parsed.customExercises || {},
      deletedExercises: parsed.deletedExercises || {},
      weekKey: parsed.weekKey || null,
    };
  } catch {
    return empty;
  }
}

function saveState() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      done: state.done,
      actualWeight: state.actualWeight,
      actualReps: state.actualReps,
      rpe: state.rpe,
      order: state.order,
      log: state.log,
      exerciseOverrides: state.exerciseOverrides,
      customExercises: state.customExercises,
      deletedExercises: state.deletedExercises,
      weekKey: state.weekKey,
    })
  );
}

const state = {
  dayIdx: todayIndex(),
  ...loadState(),
  restRemaining: 0,
  restActive: false,
  openCues: null,
  editingEx: null,
  addingExercise: false,
  historyOpen: false,
};

let restInterval = null;

// The exercise template currently assigned to a calendar slot.
function contentFor(slotIdx) {
  return TEMPLATES[state.order[slotIdx]];
}

// Base template exercises plus any custom ones added for that template,
// appended in order so exIdx keeps addressing a stable position.
function exercisesFor(templateIdx) {
  return TEMPLATES[templateIdx].exercises.concat(state.customExercises[templateIdx] || []);
}

// Applies any saved name/sets/reps override on top of the base exercise.
function effectiveEx(templateIdx, exIdx, baseEx) {
  const override = state.exerciseOverrides[`${templateIdx}-${exIdx}`];
  return override ? { ...baseEx, ...override } : baseEx;
}

function isExOverridden(templateIdx, exIdx) {
  return Object.prototype.hasOwnProperty.call(state.exerciseOverrides, `${templateIdx}-${exIdx}`);
}

function addExercise(templateIdx, ex) {
  if (!state.customExercises[templateIdx]) state.customExercises[templateIdx] = [];
  state.customExercises[templateIdx].push(ex);
  saveState();
}

// Deletion hides an exercise rather than removing it from the underlying
// array, so exIdx positions never shift and don't corrupt the log,
// overrides, or checklist keyed to other exercises.
function isExDeleted(templateIdx, exIdx) {
  return !!state.deletedExercises[`${templateIdx}-${exIdx}`];
}

function deleteExercise(templateIdx, exIdx) {
  state.deletedExercises[`${templateIdx}-${exIdx}`] = true;
  saveState();
}

function hasDeletedExercises(templateIdx) {
  const prefix = `${templateIdx}-`;
  return Object.keys(state.deletedExercises).some((k) => k.startsWith(prefix));
}

function restoreDeletedExercises(templateIdx) {
  const prefix = `${templateIdx}-`;
  Object.keys(state.deletedExercises).forEach((k) => {
    if (k.startsWith(prefix)) delete state.deletedExercises[k];
  });
  saveState();
  render();
}

// The exercises to actually show for a template: base + custom, minus any
// deleted, but each paired with its original (stable) exIdx.
function visibleExercises(templateIdx) {
  return exercisesFor(templateIdx)
    .map((ex, exIdx) => ({ ex, exIdx }))
    .filter(({ exIdx }) => !isExDeleted(templateIdx, exIdx));
}

function isOrderSwapped() {
  return state.order.some((v, i) => v !== i);
}

// Keyed by template id (not calendar slot) so logged progress follows the
// workout when it's swapped to a different day.
function key(exIdx, setIdx) {
  const templateIdx = state.order[state.dayIdx];
  return `${templateIdx}-${exIdx}-${setIdx}`;
}

function toggleSet(exIdx, setIdx) {
  const k = key(exIdx, setIdx);
  const nowDone = !state.done[k];
  state.done[k] = nowDone;
  if (nowDone) {
    state.restRemaining = REST_SECONDS;
    startRest();
    logSet(exIdx, setIdx);
  } else {
    unlogSet(exIdx, setIdx);
  }
  saveState();
  render();
}

function logSet(exIdx, setIdx) {
  const slotIdx = state.dayIdx;
  const cal = CALENDAR_DAYS[slotIdx];
  const content = contentFor(slotIdx);
  const ex = exercisesFor(state.order[slotIdx])[exIdx];
  const k = key(exIdx, setIdx);
  state.log.push({
    id: uid(),
    date: todayStr(),
    templateIdx: state.order[slotIdx],
    day: cal.day,
    dayFull: cal.full,
    focus: content.focus,
    exIdx,
    exercise: ex.name,
    setNumber: setIdx + 1,
    weight: state.actualWeight[k] || "",
    reps: state.actualReps[k] || "",
    rpe: state.rpe[k] || "",
  });
}

function unlogSet(exIdx, setIdx) {
  const templateIdx = state.order[state.dayIdx];
  for (let i = state.log.length - 1; i >= 0; i--) {
    const e = state.log[i];
    if (e.templateIdx === templateIdx && e.exIdx === exIdx && e.setNumber === setIdx + 1) {
      state.log.splice(i, 1);
      break;
    }
  }
}

function syncLogField(exIdx, setIdx, field, value) {
  const templateIdx = state.order[state.dayIdx];
  for (let i = state.log.length - 1; i >= 0; i--) {
    const e = state.log[i];
    if (e.templateIdx === templateIdx && e.exIdx === exIdx && e.setNumber === setIdx + 1) {
      e[field] = value;
      break;
    }
  }
}

// Pre-fills weight/reps from the previous session the first time a set is
// shown untouched this session, so today's numbers start from last time
// instead of blank. RPE is left for manual entry since it varies day to day.
// Only fills fields that have never been touched (key absent), so a
// deliberately cleared field stays cleared.
function autofillFromPrev(k, exIdx, setIdx, prevEntry) {
  if (!prevEntry) return;
  let changed = false;

  if (!(k in state.actualWeight) && prevEntry.weight) {
    state.actualWeight[k] = prevEntry.weight;
    if (state.done[k]) syncLogField(exIdx, setIdx, "weight", prevEntry.weight);
    changed = true;
  }
  if (!(k in state.actualReps) && prevEntry.reps) {
    state.actualReps[k] = prevEntry.reps;
    if (state.done[k]) syncLogField(exIdx, setIdx, "reps", prevEntry.reps);
    changed = true;
  }

  if (changed) saveState();
}

// Most recent logged entry for this set, excluding the entry for the
// currently-checked box (if any) so it shows the *previous* result, not
// what you just entered.
function prevLogEntry(exIdx, setIdx, exerciseName) {
  const templateIdx = state.order[state.dayIdx];
  const matches = state.log.filter(
    (e) =>
      e.templateIdx === templateIdx &&
      e.exIdx === exIdx &&
      e.setNumber === setIdx + 1 &&
      e.exercise === exerciseName
  );
  if (matches.length === 0) return null;
  const isDoneNow = !!state.done[key(exIdx, setIdx)];
  if (isDoneNow) {
    return matches.length >= 2 ? matches[matches.length - 2] : null;
  }
  return matches[matches.length - 1];
}

function lastExerciseDate(exIdx, numSets, exerciseName) {
  let maxDate = null;
  for (let i = 0; i < numSets; i++) {
    const e = prevLogEntry(exIdx, i, exerciseName);
    if (e && (!maxDate || e.date > maxDate)) maxDate = e.date;
  }
  return maxDate;
}

function formatDateShort(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function startRest() {
  state.restActive = true;
  clearInterval(restInterval);
  restInterval = setInterval(() => {
    state.restRemaining -= 1;
    if (state.restRemaining <= 0) {
      state.restRemaining = 0;
      state.restActive = false;
      clearInterval(restInterval);
    }
    renderRestBanner();
  }, 1000);
}

function stopRest() {
  state.restActive = false;
  state.restRemaining = 0;
  clearInterval(restInterval);
  renderRestBanner();
}

function resetDay() {
  const templateIdx = state.order[state.dayIdx];
  const prefix = `${templateIdx}-`;
  [state.done, state.actualWeight, state.actualReps, state.rpe].forEach((obj) => {
    Object.keys(obj).forEach((k) => {
      if (k.startsWith(prefix)) delete obj[k];
    });
  });
  stopRest();
  saveState();
  render();
}

// Clears the whole week's checklist (all days) the first time the app is
// opened in a new week, so it doesn't show last week's checked-off sets
// as if they were today's. History, swaps, and exercise edits are
// untouched — only the live done/weight/reps/RPE checklist resets.
// A missing weekKey (first run, or upgrading from before this existed)
// just records the current week without wiping anything, so it never
// destroys in-progress data the first time it runs.
function checkWeeklyRollover() {
  const thisWeek = currentWeekKey();
  if (state.weekKey && state.weekKey !== thisWeek) {
    state.done = {};
    state.actualWeight = {};
    state.actualReps = {};
    state.rpe = {};
  }
  state.weekKey = thisWeek;
  saveState();
}

function setDay(idx) {
  state.dayIdx = idx;
  state.openCues = null;
  state.editingEx = null;
  state.addingExercise = false;
  render();
}

function swapWith(otherSlotIdx) {
  const a = state.dayIdx;
  const tmp = state.order[a];
  state.order[a] = state.order[otherSlotIdx];
  state.order[otherSlotIdx] = tmp;
  saveState();
  render();
}

function resetOrder() {
  state.order = [...DEFAULT_ORDER];
  saveState();
  render();
}

function svgCheck() {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
}

function svgInfo() {
  return `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`;
}

function svgPencil() {
  return `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
}

function svgPlus() {
  return `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>`;
}

function svgTrash() {
  return `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function render() {
  const slotIdx = state.dayIdx;
  const cal = CALENDAR_DAYS[slotIdx];
  const content = contentFor(slotIdx);
  const templateIdx = state.order[slotIdx];
  const isRestDay = visibleExercises(templateIdx).length === 0;

  document.getElementById("dayFull").textContent = cal.full;
  document.getElementById("dayFocus").textContent = content.focus;

  renderTabs();
  renderSwapControl();

  document.getElementById("restDay").style.display = isRestDay ? "flex" : "none";
  document.getElementById("progressWrap").style.display = !isRestDay ? "block" : "none";
  document.getElementById("exercises").style.display = isRestDay ? "none" : "flex";

  if (!isRestDay) {
    renderProgress();
    renderExercises();
  }

  renderExerciseControls();
  renderRestBanner();
  renderHistory();
}

function renderSwapControl() {
  const select = document.getElementById("swapSelect");
  select.innerHTML = '<option value="">Swap with…</option>';
  CALENDAR_DAYS.forEach((cal, i) => {
    if (i === state.dayIdx) return;
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `${cal.full} — ${contentFor(i).focus}`;
    select.appendChild(opt);
  });

  document.getElementById("swapReset").style.display = isOrderSwapped() ? "inline" : "none";
}

function renderTabs() {
  const tabsEl = document.getElementById("dayTabs");
  tabsEl.innerHTML = "";
  CALENDAR_DAYS.forEach((cal, i) => {
    const btn = document.createElement("button");
    const active = i === state.dayIdx;
    const isRest = visibleExercises(state.order[i]).length === 0;
    btn.className = "day-tab" + (active ? " active" : "") + (isRest && !active ? " rest" : "");
    btn.textContent = cal.day;
    btn.addEventListener("click", () => setDay(i));
    tabsEl.appendChild(btn);
  });
}

function renderProgress() {
  const templateIdx = state.order[state.dayIdx];
  const exercises = visibleExercises(templateIdx);
  const totalSets = exercises.reduce(
    (s, { ex: baseEx, exIdx }) => s + effectiveEx(templateIdx, exIdx, baseEx).sets,
    0
  );
  const completedSets = exercises.reduce((s, { ex: baseEx, exIdx }) => {
    const e = effectiveEx(templateIdx, exIdx, baseEx);
    let c = 0;
    for (let i = 0; i < e.sets; i++) if (state.done[key(exIdx, i)]) c++;
    return s + c;
  }, 0);

  document.getElementById("progressLabel").textContent = `${completedSets} / ${totalSets} sets`;
  document.getElementById("progressBarFill").style.width = totalSets
    ? `${(completedSets / totalSets) * 100}%`
    : "0%";
}

function buildEditHeader(header, templateIdx, exIdx, baseEx, ex) {
  header.className = "exercise-edit";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "edit-name-input";
  nameInput.value = ex.name;

  const schemeRow = document.createElement("div");
  schemeRow.className = "edit-scheme-row";

  const setsInput = document.createElement("input");
  setsInput.type = "number";
  setsInput.min = "1";
  setsInput.step = "1";
  setsInput.className = "edit-scheme-input";
  setsInput.value = ex.sets;

  const x = document.createElement("span");
  x.className = "edit-x";
  x.textContent = "×";

  const repsInput = document.createElement("input");
  repsInput.type = "number";
  repsInput.min = "1";
  repsInput.step = "1";
  repsInput.className = "edit-scheme-input";
  repsInput.value = ex.reps;

  schemeRow.appendChild(setsInput);
  schemeRow.appendChild(x);
  schemeRow.appendChild(repsInput);

  const weightInput = document.createElement("input");
  weightInput.type = "text";
  weightInput.className = "add-sub-input";
  weightInput.placeholder = "Planned weight (e.g. 51–52kg)";
  weightInput.value = ex.weight || "";

  const actions = document.createElement("div");
  actions.className = "edit-actions";

  const saveBtn = document.createElement("button");
  saveBtn.className = "edit-save-btn";
  saveBtn.textContent = "Save";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "edit-cancel-btn";
  cancelBtn.textContent = "Cancel";

  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);

  if (isExOverridden(templateIdx, exIdx)) {
    const resetBtn = document.createElement("button");
    resetBtn.className = "edit-reset-btn";
    resetBtn.textContent = "reset to default";
    resetBtn.addEventListener("click", () => {
      delete state.exerciseOverrides[`${templateIdx}-${exIdx}`];
      state.editingEx = null;
      saveState();
      renderExercises();
      renderProgress();
    });
    actions.appendChild(resetBtn);
  }

  const save = () => {
    const nameVal = nameInput.value.trim();
    const setsVal = parseInt(setsInput.value, 10);
    const repsVal = parseInt(repsInput.value, 10);
    const weightVal = weightInput.value.trim();

    const override = {};
    if (nameVal && nameVal !== baseEx.name) override.name = nameVal;
    if (Number.isFinite(setsVal) && setsVal > 0 && setsVal !== baseEx.sets) override.sets = setsVal;
    if (Number.isFinite(repsVal) && repsVal > 0 && repsVal !== baseEx.reps) override.reps = repsVal;
    if (weightVal !== (baseEx.weight || "")) override.weight = weightVal;

    const k = `${templateIdx}-${exIdx}`;
    if (Object.keys(override).length > 0) {
      state.exerciseOverrides[k] = override;
    } else {
      delete state.exerciseOverrides[k];
    }
    state.editingEx = null;
    saveState();
    renderExercises();
    renderProgress();
  };

  saveBtn.addEventListener("click", save);
  cancelBtn.addEventListener("click", () => {
    state.editingEx = null;
    renderExercises();
  });
  [nameInput, setsInput, repsInput, weightInput].forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") save();
    });
  });

  header.appendChild(nameInput);
  header.appendChild(schemeRow);
  header.appendChild(weightInput);
  header.appendChild(actions);
}

function renderExercises() {
  const templateIdx = state.order[state.dayIdx];
  const exercises = visibleExercises(templateIdx);
  const container = document.getElementById("exercises");
  container.innerHTML = "";

  exercises.forEach(({ ex: baseEx, exIdx }) => {
    const ex = effectiveEx(templateIdx, exIdx, baseEx);
    const isEditing = state.editingEx === exIdx;

    let exDone = 0;
    for (let i = 0; i < ex.sets; i++) if (state.done[key(exIdx, i)]) exDone++;
    const allDone = !isEditing && exDone === ex.sets;

    const card = document.createElement("div");
    card.className = "exercise-card" + (allDone ? " all-done" : "");

    const weightHtml = ex.weight
      ? `<div class="exercise-weight">${escapeHtml(ex.weight)}</div>`
      : "";

    const lastDate = lastExerciseDate(exIdx, ex.sets, ex.name);
    const lastHtml = lastDate
      ? `<div class="exercise-last">Last: ${escapeHtml(formatDateShort(lastDate))}</div>`
      : "";

    card.innerHTML = `
      <div data-role="exercise-header"></div>
      ${
        isEditing
          ? ""
          : `
      <div class="sets-row" data-role="sets-row"></div>
      <div class="sets-caption">kg · reps · RPE (1–10)</div>
      ${ex.note ? `<div class="exercise-note">${escapeHtml(ex.note)}</div>` : ""}
      ${
        ex.cues
          ? `<button class="cues-toggle" data-role="cues-toggle">${svgInfo()} <span data-role="cues-label">${
              state.openCues === exIdx ? "Hide bar path cues" : "Bar path cues"
            }</span></button>
             <ul class="cues-list" data-role="cues-list" style="display:${
               state.openCues === exIdx ? "flex" : "none"
             }">${ex.cues.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>`
          : ""
      }
      `
      }
    `;

    const header = card.querySelector('[data-role="exercise-header"]');
    if (isEditing) {
      buildEditHeader(header, templateIdx, exIdx, baseEx, ex);
    } else {
      header.innerHTML = `
        <div class="exercise-top">
          <div>
            <div class="exercise-name-row">
              <div class="exercise-name">${escapeHtml(ex.name)}</div>
              <button class="exercise-edit-btn" data-role="exercise-edit-btn" aria-label="Edit exercise">${svgPencil()}</button>
              <button class="exercise-delete-btn" data-role="exercise-delete-btn" aria-label="Delete exercise">${svgTrash()}</button>
            </div>
            <div class="exercise-sub">${escapeHtml(ex.sub)}</div>
            ${lastHtml}
          </div>
          <div class="exercise-meta">
            <div class="exercise-scheme">${ex.sets}×${ex.reps}</div>
            ${weightHtml}
          </div>
        </div>
      `;
      header.querySelector('[data-role="exercise-edit-btn"]').addEventListener("click", () => {
        state.editingEx = exIdx;
        renderExercises();
      });
      header.querySelector('[data-role="exercise-delete-btn"]').addEventListener("click", () => {
        deleteExercise(templateIdx, exIdx);
        render();
      });
    }

    if (isEditing) {
      container.appendChild(card);
      return;
    }

    const setsRow = card.querySelector('[data-role="sets-row"]');
    for (let i = 0; i < ex.sets; i++) {
      const k = key(exIdx, i);
      const isDone = !!state.done[k];
      const prevEntry = prevLogEntry(exIdx, i, ex.name);

      autofillFromPrev(k, exIdx, i, prevEntry);

      const col = document.createElement("div");
      col.className = "set-col";

      const circle = document.createElement("button");
      circle.className = "set-circle" + (isDone ? " done" : "");
      circle.setAttribute("aria-label", `Set ${i + 1}`);
      circle.innerHTML = isDone ? svgCheck() : `<span>${i + 1}</span>`;
      circle.addEventListener("click", () => toggleSet(exIdx, i));

      const weightInput = document.createElement("input");
      weightInput.type = "number";
      weightInput.inputMode = "decimal";
      weightInput.step = "0.5";
      weightInput.placeholder = "kg";
      weightInput.className = "set-input";
      weightInput.value = state.actualWeight[k] ?? "";
      weightInput.addEventListener("input", (e) => {
        state.actualWeight[k] = e.target.value;
        if (state.done[k]) syncLogField(exIdx, i, "weight", e.target.value);
        saveState();
      });

      const repsInput = document.createElement("input");
      repsInput.type = "number";
      repsInput.inputMode = "numeric";
      repsInput.min = "0";
      repsInput.step = "1";
      repsInput.placeholder = "reps";
      repsInput.className = "set-input";
      repsInput.value = state.actualReps[k] ?? "";
      repsInput.addEventListener("input", (e) => {
        state.actualReps[k] = e.target.value;
        if (state.done[k]) syncLogField(exIdx, i, "reps", e.target.value);
        saveState();
      });

      const rpeInput = document.createElement("input");
      rpeInput.type = "number";
      rpeInput.inputMode = "decimal";
      rpeInput.min = "1";
      rpeInput.max = "10";
      rpeInput.step = "0.5";
      rpeInput.placeholder = "RPE";
      rpeInput.className = "set-input rpe";
      rpeInput.value = state.rpe[k] ?? "";
      rpeInput.addEventListener("input", (e) => {
        state.rpe[k] = e.target.value;
        if (state.done[k]) syncLogField(exIdx, i, "rpe", e.target.value);
        saveState();
      });

      const prevEl = document.createElement("div");
      prevEl.className = "set-prev";
      if (prevEntry) {
        const weightLine = prevEntry.weight ? `<div>${escapeHtml(prevEntry.weight)}kg</div>` : "";
        const repsLine = prevEntry.reps ? `<div>${escapeHtml(prevEntry.reps)} reps</div>` : "";
        const rpeLine = prevEntry.rpe ? `<div>RPE ${escapeHtml(prevEntry.rpe)}</div>` : "";
        prevEl.innerHTML = weightLine + repsLine + rpeLine;
      }

      col.appendChild(circle);
      col.appendChild(weightInput);
      col.appendChild(repsInput);
      col.appendChild(rpeInput);
      col.appendChild(prevEl);
      setsRow.appendChild(col);
    }

    const cuesToggle = card.querySelector('[data-role="cues-toggle"]');
    if (cuesToggle) {
      cuesToggle.addEventListener("click", () => {
        state.openCues = state.openCues === exIdx ? null : exIdx;
        renderExercises();
      });
    }

    container.appendChild(card);
  });

  const caption = document.createElement("div");
  caption.className = "rest-caption";
  caption.textContent = "rest 2:00 between sets";
  container.appendChild(caption);
}

// Add-exercise button/form and the "restore deleted" undo link. Rendered
// unconditionally (not just on training days) so exercises can be added
// on a rest day too, which is what turns it into a training day.
function renderExerciseControls() {
  const templateIdx = state.order[state.dayIdx];
  const container = document.getElementById("exerciseControls");
  container.innerHTML = "";

  const addWrap = document.createElement("div");
  if (state.addingExercise) {
    addWrap.className = "add-exercise-form";
    buildAddExerciseForm(addWrap, templateIdx);
  } else {
    addWrap.className = "add-exercise-row";
    const addBtn = document.createElement("button");
    addBtn.className = "add-exercise-btn";
    addBtn.innerHTML = `${svgPlus()} Add exercise`;
    addBtn.addEventListener("click", () => {
      state.addingExercise = true;
      renderExerciseControls();
    });
    addWrap.appendChild(addBtn);
  }
  container.appendChild(addWrap);

  if (hasDeletedExercises(templateIdx)) {
    const restoreBtn = document.createElement("button");
    restoreBtn.className = "restore-deleted-btn";
    restoreBtn.textContent = "restore deleted exercises";
    restoreBtn.addEventListener("click", () => restoreDeletedExercises(templateIdx));
    container.appendChild(restoreBtn);
  }
}

function buildAddExerciseForm(container, templateIdx) {
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "edit-name-input";
  nameInput.placeholder = "Exercise name";

  const subInput = document.createElement("input");
  subInput.type = "text";
  subInput.className = "add-sub-input";
  subInput.placeholder = "Equipment (e.g. Barbell)";

  const schemeRow = document.createElement("div");
  schemeRow.className = "edit-scheme-row";

  const setsInput = document.createElement("input");
  setsInput.type = "number";
  setsInput.min = "1";
  setsInput.step = "1";
  setsInput.className = "edit-scheme-input";
  setsInput.value = "3";

  const x = document.createElement("span");
  x.className = "edit-x";
  x.textContent = "×";

  const repsInput = document.createElement("input");
  repsInput.type = "number";
  repsInput.min = "1";
  repsInput.step = "1";
  repsInput.className = "edit-scheme-input";
  repsInput.value = "10";

  schemeRow.appendChild(setsInput);
  schemeRow.appendChild(x);
  schemeRow.appendChild(repsInput);

  const actions = document.createElement("div");
  actions.className = "edit-actions";

  const addBtn = document.createElement("button");
  addBtn.className = "edit-save-btn";
  addBtn.textContent = "Add";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "edit-cancel-btn";
  cancelBtn.textContent = "Cancel";

  actions.appendChild(addBtn);
  actions.appendChild(cancelBtn);

  const submit = () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }
    const sub = subInput.value.trim() || "—";
    const sets = parseInt(setsInput.value, 10);
    const reps = parseInt(repsInput.value, 10);
    addExercise(templateIdx, {
      name,
      sub,
      sets: Number.isFinite(sets) && sets > 0 ? sets : 3,
      reps: Number.isFinite(reps) && reps > 0 ? reps : 10,
    });
    state.addingExercise = false;
    render();
  };

  addBtn.addEventListener("click", submit);
  cancelBtn.addEventListener("click", () => {
    state.addingExercise = false;
    renderExerciseControls();
  });
  [nameInput, subInput, setsInput, repsInput].forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
  });

  container.appendChild(nameInput);
  container.appendChild(subInput);
  container.appendChild(schemeRow);
  container.appendChild(actions);
}

function renderRestBanner() {
  const banner = document.getElementById("restBanner");
  banner.style.display = state.restActive ? "block" : "none";
  const mm = String(Math.floor(state.restRemaining / 60)).padStart(2, "0");
  const ss = String(state.restRemaining % 60).padStart(2, "0");
  document.getElementById("restTime").textContent = `${mm}:${ss}`;
}

function csvEscape(value) {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function exportCsv() {
  const from = document.getElementById("exportFrom").value;
  const to = document.getElementById("exportTo").value;

  const rows = [["Date", "Day", "Focus", "Exercise", "Set", "Weight (kg)", "Reps", "RPE"]];
  const filtered = state.log
    .filter((e) => (!from || e.date >= from) && (!to || e.date <= to))
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.templateIdx - b.templateIdx ||
        a.exIdx - b.exIdx ||
        a.setNumber - b.setNumber
    );
  for (const e of filtered) {
    rows.push([e.date, e.dayFull, e.focus, e.exercise, e.setNumber, e.weight, e.reps || "", e.rpe]);
  }

  const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const suffix = from || to ? `${from || "start"}_to_${to || "now"}` : "all";
  a.download = `training-log-${suffix}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// Every exercise name worth offering in the history search dropdown:
// currently-planned exercises (including renames/overrides and custom
// additions) plus anything that's ever been logged, so a renamed or
// removed exercise's past history is still reachable.
function historyExerciseNames() {
  const names = new Set();
  TEMPLATES.forEach((t) => t.exercises.forEach((e) => names.add(e.name)));
  Object.values(state.customExercises).forEach((arr) => arr.forEach((e) => names.add(e.name)));
  Object.values(state.exerciseOverrides).forEach((o) => {
    if (o.name) names.add(o.name);
  });
  state.log.forEach((e) => names.add(e.exercise));
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

function populateHistorySearchOptions() {
  const select = document.getElementById("historySearch");
  const current = select.value;
  const names = historyExerciseNames();
  select.innerHTML =
    '<option value="">All exercises</option>' +
    names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
  if (names.includes(current)) select.value = current;
}

function renderHistory() {
  const toggleBtn = document.getElementById("historyToggle");
  const panel = document.getElementById("historyPanel");
  toggleBtn.classList.toggle("active", state.historyOpen);
  panel.style.display = state.historyOpen ? "block" : "none";
  if (!state.historyOpen) return;

  populateHistorySearchOptions();

  const selectedExercise = document.getElementById("historySearch").value;
  const dateFilter = document.getElementById("historyDate").value;

  const filtered = state.log.filter((e) => {
    if (dateFilter && e.date !== dateFilter) return false;
    if (selectedExercise && e.exercise !== selectedExercise) return false;
    return true;
  });

  const resultsEl = document.getElementById("historyResults");
  resultsEl.innerHTML = "";

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "No matching sets logged.";
    resultsEl.appendChild(empty);
    return;
  }

  const byDate = {};
  filtered.forEach((e) => {
    (byDate[e.date] = byDate[e.date] || []).push(e);
  });
  const dates = Object.keys(byDate).sort((a, b) => b.localeCompare(a));

  dates.forEach((date) => {
    const entries = byDate[date];
    const group = document.createElement("div");
    group.className = "history-date-group";

    const heading = document.createElement("div");
    heading.className = "history-date-heading";
    heading.textContent = `${formatDateShort(date)} — ${entries[0].dayFull} (${entries[0].focus})`;
    group.appendChild(heading);

    const byEx = {};
    entries.forEach((e) => {
      (byEx[e.exercise] = byEx[e.exercise] || []).push(e);
    });

    Object.keys(byEx).forEach((exName) => {
      const exGroup = document.createElement("div");
      exGroup.className = "history-ex-group";

      const exTitle = document.createElement("div");
      exTitle.className = "history-ex-title";
      exTitle.textContent = exName;
      exGroup.appendChild(exTitle);

      const sets = byEx[exName].sort((a, b) => a.setNumber - b.setNumber);
      sets.forEach((s) => {
        const parts = [];
        if (s.weight) parts.push(`${s.weight}kg`);
        if (s.reps) parts.push(`${s.reps} reps`);
        if (s.rpe) parts.push(`RPE ${s.rpe}`);
        const setLine = document.createElement("div");
        setLine.className = "history-sets-line";
        setLine.textContent = `Set ${s.setNumber}: ${parts.join(" · ") || "—"}`;
        exGroup.appendChild(setLine);
      });

      group.appendChild(exGroup);
    });

    resultsEl.appendChild(group);
  });
}

document.getElementById("resetBtn").addEventListener("click", resetDay);
document.getElementById("restDismiss").addEventListener("click", stopRest);

document.getElementById("swapSelect").addEventListener("change", (e) => {
  const other = e.target.value;
  if (other === "") return;
  swapWith(parseInt(other, 10));
  e.target.value = "";
});

document.getElementById("swapReset").addEventListener("click", resetOrder);

document.getElementById("exportFrom").value = firstOfMonthStr();
document.getElementById("exportTo").value = todayStr();
document.getElementById("exportBtn").addEventListener("click", exportCsv);

document.getElementById("historyToggle").addEventListener("click", () => {
  state.historyOpen = !state.historyOpen;
  renderHistory();
});
document.getElementById("historySearch").addEventListener("change", renderHistory);
document.getElementById("historyDate").addEventListener("change", renderHistory);
document.getElementById("historyClear").addEventListener("click", () => {
  document.getElementById("historySearch").value = "";
  document.getElementById("historyDate").value = "";
  renderHistory();
});

checkWeeklyRollover();
render();
