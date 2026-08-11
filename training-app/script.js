const WEEK = [
  {
    day: "Mon",
    full: "Monday",
    focus: "Chest / Tricep",
    exercises: [
      { name: "Incline Bench Press", sub: "Cable", sets: 5, reps: 5 },
      { name: "Triceps Extension", sub: "Cable", sets: 5, reps: 5 },
    ],
  },
  {
    day: "Tue",
    full: "Tuesday",
    focus: "Upper Back",
    exercises: [
      {
        name: "Bent Over Row",
        sub: "Barbell",
        sets: 5,
        reps: 5,
        weight: "51–52kg",
        note: "Jumped from 48kg — was under-loaded, not plateaued.",
      },
      {
        name: "Lat Pulldown",
        sub: "Cable",
        sets: 5,
        reps: 5,
        weight: "~65kg",
        note: "Deload from 71kg — rebuild clean bar path, push back up over 2–3 weeks.",
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
    day: "Wed",
    full: "Wednesday",
    focus: "Shoulder",
    exercises: [
      {
        name: "Overhead Press",
        sub: "Barbell",
        sets: 5,
        reps: 5,
        note: "Watch: dropped to 2 reps on last set (Aug 4) after 9 clean sessions.",
      },
      { name: "Lateral Raise", sub: "Cable", sets: 5, reps: 5 },
      {
        name: "Face Pull",
        sub: "Cable",
        sets: 5,
        reps: 12,
        note: "Restore full volume — dropped to 1 set on Aug 4.",
      },
    ],
  },
  { day: "Thu", full: "Thursday", focus: "Rest — Clinic", exercises: [] },
  {
    day: "Fri",
    full: "Friday",
    focus: "Legs",
    exercises: [
      { name: "Squat", sub: "Barbell", sets: 5, reps: 5 },
      { name: "Deadlift", sub: "Barbell", sets: 5, reps: 5 },
      {
        name: "Romanian Deadlift",
        sub: "Barbell",
        sets: 3,
        reps: 9,
        note: "Direct hamstring work — conventional Deadlift trains full hip+knee extension, not isolated hip-hinge.",
      },
      { name: "Standing Calf Raise", sub: "Dumbbell", sets: 5, reps: 10 },
    ],
  },
  {
    day: "Sat",
    full: "Saturday",
    focus: "Arm — short session",
    exercises: [
      {
        name: "Hammer Curl",
        sub: "Dumbbell",
        sets: 5,
        reps: 5,
        note: "Hits biceps, brachialis, and brachioradialis via neutral grip.",
      },
    ],
  },
  { day: "Sun", full: "Sunday", focus: "Rest — Clinic", exercises: [] },
];

const REST_SECONDS = 120;
const STORAGE_KEY = "trainingApp.state";

function todayIndex() {
  const jsDay = new Date().getDay(); // 0 = Sun
  return jsDay === 0 ? 6 : jsDay - 1;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { done: {}, actualWeight: {}, rpe: {} };
    const parsed = JSON.parse(raw);
    return {
      done: parsed.done || {},
      actualWeight: parsed.actualWeight || {},
      rpe: parsed.rpe || {},
    };
  } catch {
    return { done: {}, actualWeight: {}, rpe: {} };
  }
}

function saveState() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ done: state.done, actualWeight: state.actualWeight, rpe: state.rpe })
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

function key(exIdx, setIdx) {
  return `${state.dayIdx}-${exIdx}-${setIdx}`;
}

function toggleSet(exIdx, setIdx) {
  const k = key(exIdx, setIdx);
  const nowDone = !state.done[k];
  state.done[k] = nowDone;
  if (nowDone) {
    state.restRemaining = REST_SECONDS;
    startRest();
  }
  saveState();
  render();
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
  const prefix = `${state.dayIdx}-`;
  [state.done, state.actualWeight, state.rpe].forEach((obj) => {
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
  const day = WEEK[state.dayIdx];
  const isRestDay = day.exercises.length === 0;

  document.getElementById("dayFull").textContent = day.full;
  document.getElementById("dayFocus").textContent = day.focus;

  renderTabs();

  document.getElementById("restDay").style.display = isRestDay ? "flex" : "none";
  document.getElementById("progressWrap").style.display = isRestDay ? "none" : "block";
  document.getElementById("exercises").style.display = isRestDay ? "none" : "flex";

  if (!isRestDay) {
    renderProgress();
    renderExercises();
  }

  renderRestBanner();
}

function renderTabs() {
  const tabsEl = document.getElementById("dayTabs");
  tabsEl.innerHTML = "";
  WEEK.forEach((d, i) => {
    const btn = document.createElement("button");
    const active = i === state.dayIdx;
    const isRest = d.exercises.length === 0;
    btn.className = "day-tab" + (active ? " active" : "") + (isRest && !active ? " rest" : "");
    btn.textContent = d.day;
    btn.addEventListener("click", () => setDay(i));
    tabsEl.appendChild(btn);
  });
}

function renderProgress() {
  const day = WEEK[state.dayIdx];
  const totalSets = day.exercises.reduce((s, e) => s + e.sets, 0);
  const completedSets = day.exercises.reduce((s, e, exIdx) => {
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
  const day = WEEK[state.dayIdx];
  const container = document.getElementById("exercises");
  container.innerHTML = "";

  day.exercises.forEach((ex, exIdx) => {
    let exDone = 0;
    for (let i = 0; i < ex.sets; i++) if (state.done[key(exIdx, i)]) exDone++;
    const allDone = exDone === ex.sets;

    const card = document.createElement("div");
    card.className = "exercise-card" + (allDone ? " all-done" : "");

    const weightHtml = ex.weight
      ? `<div class="exercise-weight">${escapeHtml(ex.weight)}</div>`
      : "";

    card.innerHTML = `
      <div class="exercise-top">
        <div>
          <div class="exercise-name">${escapeHtml(ex.name)}</div>
          <div class="exercise-sub">${escapeHtml(ex.sub)}</div>
        </div>
        <div class="exercise-meta">
          <div class="exercise-scheme">${ex.sets}×${ex.reps}</div>
          ${weightHtml}
        </div>
      </div>
      <div class="sets-row" data-role="sets-row"></div>
      <div class="sets-caption">kg · RPE (1–10)</div>
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
        saveState();
      });

      col.appendChild(circle);
      col.appendChild(weightInput);
      col.appendChild(rpeInput);
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

document.getElementById("resetBtn").addEventListener("click", resetDay);
document.getElementById("restDismiss").addEventListener("click", stopRest);

render();
