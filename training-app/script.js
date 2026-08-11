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
      { name: "Torso Rotation", sub: "Machine", sets: 3, reps: 10 },
    ],
  },
  {
    focus: "Shoulder",
    exercises: [
      { name: "Overhead Press", sub: "Barbell", sets: 5, reps: 5 },
      { name: "Lateral Raise", sub: "Cable", sets: 5, reps: 5 },
      { name: "Face Pull", sub: "Cable", sets: 5, reps: 12 },
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

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw)
      return { done: {}, actualWeight: {}, actualReps: {}, rpe: {}, order: [...DEFAULT_ORDER], log: [] };
    const parsed = JSON.parse(raw);
    return {
      done: parsed.done || {},
      actualWeight: parsed.actualWeight || {},
      actualReps: parsed.actualReps || {},
      rpe: parsed.rpe || {},
      order: Array.isArray(parsed.order) && parsed.order.length === 7 ? parsed.order : [...DEFAULT_ORDER],
      log: parsed.log || [],
    };
  } catch {
    return { done: {}, actualWeight: {}, actualReps: {}, rpe: {}, order: [...DEFAULT_ORDER], log: [] };
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
    })
  );
}

const state = {
  dayIdx: todayIndex(),
  ...loadState(),
  restRemaining: 0,
  restActive: false,
  openCues: null,
};

let restInterval = null;

// The exercise template currently assigned to a calendar slot.
function contentFor(slotIdx) {
  return TEMPLATES[state.order[slotIdx]];
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
  const ex = content.exercises[exIdx];
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

// Most recent logged entry for this set, excluding the entry for the
// currently-checked box (if any) so it shows the *previous* result, not
// what you just entered.
function prevLogEntry(exIdx, setIdx) {
  const templateIdx = state.order[state.dayIdx];
  const matches = state.log.filter(
    (e) => e.templateIdx === templateIdx && e.exIdx === exIdx && e.setNumber === setIdx + 1
  );
  if (matches.length === 0) return null;
  const isDoneNow = !!state.done[key(exIdx, setIdx)];
  if (isDoneNow) {
    return matches.length >= 2 ? matches[matches.length - 2] : null;
  }
  return matches[matches.length - 1];
}

function lastExerciseDate(exIdx, numSets) {
  let maxDate = null;
  for (let i = 0; i < numSets; i++) {
    const e = prevLogEntry(exIdx, i);
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

function setDay(idx) {
  state.dayIdx = idx;
  state.openCues = null;
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

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function render() {
  const slotIdx = state.dayIdx;
  const cal = CALENDAR_DAYS[slotIdx];
  const content = contentFor(slotIdx);
  const isRestDay = content.exercises.length === 0;

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

  renderRestBanner();
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
    const isRest = contentFor(i).exercises.length === 0;
    btn.className = "day-tab" + (active ? " active" : "") + (isRest && !active ? " rest" : "");
    btn.textContent = cal.day;
    btn.addEventListener("click", () => setDay(i));
    tabsEl.appendChild(btn);
  });
}

function renderProgress() {
  const content = contentFor(state.dayIdx);
  const totalSets = content.exercises.reduce((s, e) => s + e.sets, 0);
  const completedSets = content.exercises.reduce((s, e, exIdx) => {
    let c = 0;
    for (let i = 0; i < e.sets; i++) if (state.done[key(exIdx, i)]) c++;
    return s + c;
  }, 0);

  document.getElementById("progressLabel").textContent = `${completedSets} / ${totalSets} sets`;
  document.getElementById("progressBarFill").style.width = totalSets
    ? `${(completedSets / totalSets) * 100}%`
    : "0%";
}

function renderExercises() {
  const content = contentFor(state.dayIdx);
  const container = document.getElementById("exercises");
  container.innerHTML = "";

  content.exercises.forEach((ex, exIdx) => {
    let exDone = 0;
    for (let i = 0; i < ex.sets; i++) if (state.done[key(exIdx, i)]) exDone++;
    const allDone = exDone === ex.sets;

    const card = document.createElement("div");
    card.className = "exercise-card" + (allDone ? " all-done" : "");

    const weightHtml = ex.weight
      ? `<div class="exercise-weight">${escapeHtml(ex.weight)}</div>`
      : "";

    const lastDate = lastExerciseDate(exIdx, ex.sets);
    const lastHtml = lastDate
      ? `<div class="exercise-last">Last: ${escapeHtml(formatDateShort(lastDate))}</div>`
      : "";

    card.innerHTML = `
      <div class="exercise-top">
        <div>
          <div class="exercise-name">${escapeHtml(ex.name)}</div>
          <div class="exercise-sub">${escapeHtml(ex.sub)}</div>
          ${lastHtml}
        </div>
        <div class="exercise-meta">
          <div class="exercise-scheme">${ex.sets}×${ex.reps}</div>
          ${weightHtml}
        </div>
      </div>
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
    `;

    const setsRow = card.querySelector('[data-role="sets-row"]');
    for (let i = 0; i < ex.sets; i++) {
      const k = key(exIdx, i);
      const isDone = !!state.done[k];

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

      const prevEntry = prevLogEntry(exIdx, i);
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

render();
