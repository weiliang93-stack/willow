const STORAGE_KEYS = {
  income: "investmentPlanner.income",
  expenses: "investmentPlanner.expenses",
  goals: "investmentPlanner.goals",
  horizonYears: "investmentPlanner.horizonYears",
};

const CATEGORICAL = [
  "#2a78d6", "#eb6834", "#1baf7a", "#eda100",
  "#e87ba4", "#008300", "#4a3aa7", "#e34948",
];
const OTHER_COLOR = "#898781";

let monthlyIncome = load(STORAGE_KEYS.income, 0);
let expenses = load(STORAGE_KEYS.expenses, []);
let goals = load(STORAGE_KEYS.goals, []);
let horizonYears = load(STORAGE_KEYS.horizonYears, 10);

let editingGoalId = null;

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw !== null ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save() {
  localStorage.setItem(STORAGE_KEYS.income, JSON.stringify(monthlyIncome));
  localStorage.setItem(STORAGE_KEYS.expenses, JSON.stringify(expenses));
  localStorage.setItem(STORAGE_KEYS.goals, JSON.stringify(goals));
  localStorage.setItem(STORAGE_KEYS.horizonYears, JSON.stringify(horizonYears));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---------- formatting ----------

function formatMoney(n) {
  const sign = n < 0 ? "-" : "";
  return sign + "$" + Math.abs(Math.round(n)).toLocaleString();
}

function formatCompactMoney(n) {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  let val, suffix;
  if (abs >= 1e9) { val = abs / 1e9; suffix = "B"; }
  else if (abs >= 1e6) { val = abs / 1e6; suffix = "M"; }
  else if (abs >= 1e3) { val = abs / 1e3; suffix = "K"; }
  else return formatMoney(n);
  const decimals = val < 10 ? 1 : 0;
  return sign + "$" + val.toFixed(decimals) + suffix;
}

function formatMonths(m) {
  if (m === null) return "50+ yrs";
  if (m <= 0) return "Goal reached";
  const years = Math.floor(m / 12);
  const months = m % 12;
  if (years === 0) return `${months} mo`;
  if (months === 0) return `${years} yr`;
  return `${years} yr ${months} mo`;
}

// ---------- projection math ----------

function monthlyRate(annualPct) {
  return annualPct / 100 / 12;
}

function simulateSeries(current, contribution, annualPct, months) {
  const r = monthlyRate(annualPct);
  const series = new Array(months + 1);
  series[0] = current;
  let balance = current;
  for (let m = 1; m <= months; m++) {
    balance = balance * (1 + r) + contribution;
    series[m] = balance;
  }
  return series;
}

function monthsToReachGoal(goal, capMonths = 600) {
  if (goal.currentAmount >= goal.targetAmount) return 0;
  if (goal.monthlyContribution <= 0 && goal.annualReturnPct <= 0) return null;
  const r = monthlyRate(goal.annualReturnPct);
  let balance = goal.currentAmount;
  for (let m = 1; m <= capMonths; m++) {
    balance = balance * (1 + r) + goal.monthlyContribution;
    if (balance >= goal.targetAmount) return m;
  }
  return null;
}

function niceStep(maxVal, targetTicks = 4) {
  if (maxVal <= 0) return 1;
  const rough = maxVal / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  let step;
  if (norm < 1.5) step = 1;
  else if (norm < 3) step = 2;
  else if (norm < 7) step = 5;
  else step = 10;
  return step * mag;
}

// ---------- svg helpers ----------

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function svgText(tag, attrs, text) {
  const el = svgEl(tag, attrs);
  el.textContent = text;
  return el;
}

// ---------- tooltip ----------

const tooltipEl = document.getElementById("tooltip");

function showTooltip(x, y, title, rows) {
  tooltipEl.innerHTML = "";
  const titleEl = document.createElement("div");
  titleEl.className = "tt-title";
  titleEl.textContent = title;
  tooltipEl.appendChild(titleEl);
  rows.forEach(({ color, label, value }) => {
    const row = document.createElement("div");
    row.className = "tt-row";
    if (color) {
      const key = document.createElement("span");
      key.className = "tt-key";
      key.style.background = color;
      row.appendChild(key);
    }
    if (label) {
      const labelEl = document.createElement("span");
      labelEl.textContent = label;
      row.appendChild(labelEl);
    }
    const valueEl = document.createElement("span");
    valueEl.className = "tt-value";
    valueEl.textContent = value;
    row.appendChild(valueEl);
    tooltipEl.appendChild(row);
  });

  const pad = 14;
  let left = x + 14;
  let top = y - 14;
  tooltipEl.classList.remove("hidden");
  const rect = tooltipEl.getBoundingClientRect();
  if (left + rect.width > window.innerWidth - pad) left = x - rect.width - 14;
  if (top < pad) top = pad;
  if (top + rect.height > window.innerHeight - pad) top = window.innerHeight - rect.height - pad;
  tooltipEl.style.left = `${left}px`;
  tooltipEl.style.top = `${top}px`;
}

function hideTooltip() {
  tooltipEl.classList.add("hidden");
}

// ---------- area/line chart with crosshair ----------

function renderAreaChart(container, series, horizonYears, color) {
  container.innerHTML = "";
  const months = series.length - 1;
  const width = 600, height = 220;
  const padLeft = 56, padRight = 12, padTop = 16, padBottom = 24;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  const maxVal = Math.max(...series, 1);
  const step = niceStep(maxVal, 4);
  const maxTick = Math.max(step, Math.ceil(maxVal / step) * step);
  const tickCount = Math.round(maxTick / step);

  const xForMonth = (m) => padLeft + (months === 0 ? 0 : (m / months) * plotWidth);
  const yForVal = (v) => padTop + plotHeight - (v / maxTick) * plotHeight;
  const baselineY = padTop + plotHeight;

  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, class: "chart-svg" });

  // gridlines + y labels
  for (let i = 0; i <= tickCount; i++) {
    const val = i * step;
    const y = yForVal(val);
    svg.appendChild(svgEl("line", {
      x1: padLeft, x2: width - padRight, y1: y, y2: y,
      class: i === 0 ? "baseline" : "gridline",
    }));
    svg.appendChild(svgText("text", {
      x: padLeft - 8, y: y + 3, class: "axis-tick", "text-anchor": "end",
    }, formatCompactMoney(val)));
  }

  // x labels
  const xTickCount = Math.min(5, Math.max(2, horizonYears));
  for (let i = 0; i <= xTickCount; i++) {
    const yearFrac = i / xTickCount;
    const m = Math.round(yearFrac * months);
    const x = xForMonth(m);
    const yearLabel = Math.round(yearFrac * horizonYears);
    const anchor = i === 0 ? "start" : i === xTickCount ? "end" : "middle";
    svg.appendChild(svgText("text", {
      x, y: height - 6, class: "axis-tick", "text-anchor": anchor,
    }, yearLabel === 0 ? "Today" : `${yearLabel}y`));
  }

  // area + line paths
  let linePath = "";
  for (let m = 0; m <= months; m++) {
    const cmd = m === 0 ? "M" : "L";
    linePath += `${cmd}${xForMonth(m).toFixed(2)},${yForVal(series[m]).toFixed(2)} `;
  }
  const areaPath = `${linePath}L${xForMonth(months).toFixed(2)},${baselineY} L${xForMonth(0).toFixed(2)},${baselineY} Z`;

  svg.appendChild(svgEl("path", { d: areaPath, fill: color, "fill-opacity": 0.1, stroke: "none" }));
  svg.appendChild(svgEl("path", { d: linePath.trim(), fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));

  // end marker + direct label
  const endX = xForMonth(months), endY = yForVal(series[months]);
  svg.appendChild(svgEl("circle", { cx: endX, cy: endY, r: 4, fill: color, stroke: "var(--surface)", "stroke-width": 2 }));
  svg.appendChild(svgText("text", {
    x: endX - 8, y: endY - 10, class: "axis-tick", "text-anchor": "end", fill: "var(--ink-primary)", "font-weight": 700, "font-size": 11,
  }, formatCompactMoney(series[months])));

  // interaction layer
  const crosshair = svgEl("line", { x1: 0, x2: 0, y1: padTop, y2: baselineY, stroke: "var(--ink-muted)", "stroke-width": 1, opacity: 0 });
  const hoverDot = svgEl("circle", { r: 5, fill: color, stroke: "var(--surface)", "stroke-width": 2, opacity: 0 });
  svg.appendChild(crosshair);
  svg.appendChild(hoverDot);

  const overlay = svgEl("rect", {
    x: padLeft, y: padTop, width: plotWidth, height: plotHeight,
    fill: "transparent", style: "cursor: crosshair",
  });
  svg.appendChild(overlay);

  function handleMove(clientX, clientY) {
    const rect = svg.getBoundingClientRect();
    const scale = width / rect.width;
    const localX = (clientX - rect.left) * scale;
    const frac = Math.min(1, Math.max(0, (localX - padLeft) / plotWidth));
    const idx = Math.round(frac * months);
    const x = xForMonth(idx), y = yForVal(series[idx]);
    crosshair.setAttribute("x1", x);
    crosshair.setAttribute("x2", x);
    crosshair.setAttribute("opacity", 1);
    hoverDot.setAttribute("cx", x);
    hoverDot.setAttribute("cy", y);
    hoverDot.setAttribute("opacity", 1);
    const years = idx / 12;
    const title = idx === 0 ? "Today" : years < 1 ? `${idx} mo` : `Year ${years.toFixed(years % 1 === 0 ? 0 : 1)}`;
    showTooltip(clientX, clientY, title, [{ color, value: formatMoney(series[idx]) }]);
  }

  overlay.addEventListener("pointermove", (e) => handleMove(e.clientX, e.clientY));
  overlay.addEventListener("pointerleave", () => {
    crosshair.setAttribute("opacity", 0);
    hoverDot.setAttribute("opacity", 0);
    hideTooltip();
  });

  container.appendChild(svg);
}

// ---------- sparkline (decorative, goal cards) ----------

function renderSparkline(container, series, color) {
  container.innerHTML = "";
  const width = 90, height = 32;
  const maxVal = Math.max(...series, 1);
  const minVal = Math.min(...series, 0);
  const range = maxVal - minVal || 1;
  const xForIdx = (i) => (i / (series.length - 1)) * width;
  const yForVal = (v) => height - ((v - minVal) / range) * height;

  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}` });
  let linePath = "";
  series.forEach((v, i) => {
    const cmd = i === 0 ? "M" : "L";
    linePath += `${cmd}${xForIdx(i).toFixed(2)},${yForVal(v).toFixed(2)} `;
  });
  const areaPath = `${linePath}L${width},${height} L0,${height} Z`;
  svg.appendChild(svgEl("path", { d: areaPath, fill: color, "fill-opacity": 0.12, stroke: "none" }));
  svg.appendChild(svgEl("path", { d: linePath.trim(), fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
  const lastIdx = series.length - 1;
  svg.appendChild(svgEl("circle", { cx: xForIdx(lastIdx), cy: yForVal(series[lastIdx]), r: 3, fill: color }));
  container.appendChild(svg);
}

// ---------- horizontal bar chart (allocation) ----------

function renderBarChart(container, items) {
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "bar-chart";
  const maxVal = Math.max(...items.map((i) => i.value), 1);

  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "bar-row";
    row.tabIndex = 0;

    const top = document.createElement("div");
    top.className = "bar-row-top";
    const label = document.createElement("span");
    label.className = "bar-label";
    label.textContent = item.label;
    const value = document.createElement("span");
    value.className = "bar-value";
    value.textContent = formatMoney(item.value) + "/mo";
    top.appendChild(label);
    top.appendChild(value);

    const track = document.createElement("div");
    track.className = "bar-track";
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = `${Math.max(2, (item.value / maxVal) * 100)}%`;
    fill.style.background = item.color;
    track.appendChild(fill);

    row.appendChild(top);
    row.appendChild(track);

    const onEnter = (e) => {
      const cx = e.clientX ?? row.getBoundingClientRect().right;
      const cy = e.clientY ?? row.getBoundingClientRect().top;
      showTooltip(cx, cy, item.label, [{ color: item.color, value: formatMoney(item.value) + "/mo" }]);
    };
    row.addEventListener("pointermove", onEnter);
    row.addEventListener("pointerenter", onEnter);
    row.addEventListener("pointerleave", hideTooltip);
    row.addEventListener("focus", () => {
      const r = row.getBoundingClientRect();
      showTooltip(r.right, r.top, item.label, [{ color: item.color, value: formatMoney(item.value) + "/mo" }]);
    });
    row.addEventListener("blur", hideTooltip);

    wrap.appendChild(row);
  });

  container.appendChild(wrap);
}

// ---------- elements ----------

const incomeInput = document.getElementById("income-input");
const expensesListEl = document.getElementById("expenses-list");
const addExpenseBtn = document.getElementById("add-expense-btn");
const addExpenseForm = document.getElementById("add-expense-form");
const cancelExpenseBtn = document.getElementById("cancel-expense-btn");
const expenseNameInput = document.getElementById("expense-name");
const expenseAmountInput = document.getElementById("expense-amount");
const statMonthlySavings = document.getElementById("stat-monthly-savings");
const statUnallocated = document.getElementById("stat-unallocated");

const overviewPanel = document.getElementById("overview-panel");
const horizonPicker = document.getElementById("horizon-picker");
const statInvestedToday = document.getElementById("stat-invested-today");
const statMonthlyContrib = document.getElementById("stat-monthly-contrib");
const statProjectedLabel = document.getElementById("stat-projected-label");
const statProjected = document.getElementById("stat-projected");
const overviewChartEl = document.getElementById("overview-chart");

const goalsListEl = document.getElementById("goals-list");
const goalsEmptyHint = document.getElementById("goals-empty-hint");
const addGoalBtn = document.getElementById("add-goal-btn");
const addGoalForm = document.getElementById("add-goal-form");
const goalNameInput = document.getElementById("goal-name");
const goalTargetInput = document.getElementById("goal-target");
const goalCurrentInput = document.getElementById("goal-current");
const goalContributionInput = document.getElementById("goal-contribution");
const goalReturnInput = document.getElementById("goal-return");
const cancelGoalBtn = document.getElementById("cancel-goal-btn");
const goalSubmitBtn = document.getElementById("goal-submit-btn");

const allocationPanel = document.getElementById("allocation-panel");
const allocationChartEl = document.getElementById("allocation-chart");

// ---------- income & expenses ----------

incomeInput.addEventListener("change", () => {
  monthlyIncome = parseFloat(incomeInput.value) || 0;
  save();
  renderCashflow();
});

addExpenseBtn.addEventListener("click", () => {
  addExpenseForm.classList.remove("hidden");
  expenseNameInput.focus();
});

cancelExpenseBtn.addEventListener("click", () => {
  addExpenseForm.reset();
  addExpenseForm.classList.add("hidden");
});

addExpenseForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = expenseNameInput.value.trim();
  const amount = parseFloat(expenseAmountInput.value);
  if (!name || !(amount >= 0)) return;
  expenses.push({ id: uid(), name, amount });
  save();
  addExpenseForm.reset();
  addExpenseForm.classList.add("hidden");
  renderCashflow();
});

function removeExpense(id) {
  expenses = expenses.filter((e) => e.id !== id);
  save();
  renderCashflow();
}

function renderCashflow() {
  incomeInput.value = monthlyIncome || "";

  expensesListEl.innerHTML = "";
  expenses.forEach((exp) => {
    const row = document.createElement("div");
    row.className = "expense-item";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = exp.name;
    const amountWrap = document.createElement("span");
    amountWrap.className = "amount";
    const amountText = document.createElement("span");
    amountText.textContent = formatMoney(exp.amount);
    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-btn";
    removeBtn.type = "button";
    removeBtn.textContent = "×";
    removeBtn.setAttribute("aria-label", `Remove ${exp.name}`);
    removeBtn.addEventListener("click", () => removeExpense(exp.id));
    amountWrap.appendChild(amountText);
    amountWrap.appendChild(removeBtn);
    row.appendChild(name);
    row.appendChild(amountWrap);
    expensesListEl.appendChild(row);
  });

  const monthlyExpensesTotal = expenses.reduce((sum, e) => sum + e.amount, 0);
  const monthlySavings = monthlyIncome - monthlyExpensesTotal;
  const allocated = goals.reduce((sum, g) => sum + g.monthlyContribution, 0);
  const unallocated = monthlySavings - allocated;

  statMonthlySavings.textContent = formatMoney(monthlySavings);
  statMonthlySavings.classList.toggle("negative", monthlySavings < 0);
  statUnallocated.textContent = formatMoney(unallocated);
  statUnallocated.classList.toggle("negative", unallocated < 0);
}

// ---------- goals ----------

addGoalBtn.addEventListener("click", () => openGoalForm());
cancelGoalBtn.addEventListener("click", closeGoalForm);

function openGoalForm(goal = null) {
  editingGoalId = goal ? goal.id : null;
  goalSubmitBtn.textContent = goal ? "Save changes" : "Save goal";
  goalNameInput.value = goal ? goal.name : "";
  goalTargetInput.value = goal ? goal.targetAmount : "";
  goalCurrentInput.value = goal ? goal.currentAmount : "";
  goalContributionInput.value = goal ? goal.monthlyContribution : "";
  goalReturnInput.value = goal ? goal.annualReturnPct : "";
  addGoalForm.classList.remove("hidden");
  goalNameInput.focus();
}

function closeGoalForm() {
  editingGoalId = null;
  addGoalForm.reset();
  addGoalForm.classList.add("hidden");
}

addGoalForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = goalNameInput.value.trim();
  const targetAmount = parseFloat(goalTargetInput.value);
  const currentAmount = parseFloat(goalCurrentInput.value);
  const monthlyContribution = parseFloat(goalContributionInput.value);
  const annualReturnPct = parseFloat(goalReturnInput.value);
  if (!name || !(targetAmount >= 0) || !(currentAmount >= 0) || !(monthlyContribution >= 0) || !(annualReturnPct >= 0)) return;

  if (editingGoalId) {
    const goal = goals.find((g) => g.id === editingGoalId);
    Object.assign(goal, { name, targetAmount, currentAmount, monthlyContribution, annualReturnPct });
  } else {
    goals.push({ id: uid(), name, targetAmount, currentAmount, monthlyContribution, annualReturnPct });
  }
  save();
  closeGoalForm();
  renderAll();
});

function removeGoal(id) {
  goals = goals.filter((g) => g.id !== id);
  save();
  renderAll();
}

function renderGoals() {
  goalsListEl.innerHTML = "";
  goalsEmptyHint.classList.toggle("hidden", goals.length > 0);

  goals.forEach((goal) => {
    const card = document.createElement("div");
    card.className = "goal-card";

    const top = document.createElement("div");
    top.className = "goal-card-top";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = goal.name;
    const actions = document.createElement("div");
    actions.className = "goal-card-actions";
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => openGoalForm(goal));
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "remove-goal-btn";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => removeGoal(goal.id));
    actions.appendChild(editBtn);
    actions.appendChild(removeBtn);
    top.appendChild(name);
    top.appendChild(actions);

    const track = document.createElement("div");
    track.className = "progress-track";
    const fill = document.createElement("div");
    fill.className = "progress-fill";
    const pct = goal.targetAmount > 0 ? Math.min(100, (goal.currentAmount / goal.targetAmount) * 100) : 0;
    fill.style.width = `${pct}%`;
    track.appendChild(fill);

    const meta = document.createElement("div");
    meta.className = "goal-card-meta";
    const metaLeft = document.createElement("span");
    metaLeft.textContent = `${formatMoney(goal.currentAmount)} of ${formatMoney(goal.targetAmount)}`;
    const metaRight = document.createElement("span");
    metaRight.textContent = `${pct.toFixed(0)}%`;
    meta.appendChild(metaLeft);
    meta.appendChild(metaRight);

    const body = document.createElement("div");
    body.className = "goal-card-body";
    const sparklineEl = document.createElement("div");
    sparklineEl.className = "sparkline";
    const stats = document.createElement("div");
    stats.className = "goal-card-stats";

    const months = monthsToReachGoal(goal);
    const chartMonths = Math.min(months ?? 600, 600) || 12;
    const series = simulateSeries(goal.currentAmount, goal.monthlyContribution, goal.annualReturnPct, Math.max(chartMonths, 1));

    const contribLine = document.createElement("div");
    contribLine.innerHTML = "";
    contribLine.append("Contributing ");
    const contribStrong = document.createElement("strong");
    contribStrong.textContent = `${formatMoney(goal.monthlyContribution)}/mo`;
    contribLine.appendChild(contribStrong);
    contribLine.append(` at ${goal.annualReturnPct}% / yr`);

    const etaLine = document.createElement("div");
    etaLine.append("Reaches goal in ");
    const etaStrong = document.createElement("strong");
    etaStrong.textContent = formatMonths(months);
    etaLine.appendChild(etaStrong);

    stats.appendChild(contribLine);
    stats.appendChild(etaLine);
    body.appendChild(sparklineEl);
    body.appendChild(stats);

    card.appendChild(top);
    card.appendChild(track);
    card.appendChild(meta);
    card.appendChild(body);
    goalsListEl.appendChild(card);

    renderSparkline(sparklineEl, series, "#2a78d6");
  });
}

// ---------- overview ----------

horizonPicker.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-years]");
  if (!btn) return;
  horizonYears = parseInt(btn.dataset.years, 10);
  save();
  renderOverview();
});

function renderOverview() {
  if (goals.length === 0) {
    overviewPanel.classList.add("hidden");
    return;
  }
  overviewPanel.classList.remove("hidden");

  [...horizonPicker.querySelectorAll("button")].forEach((btn) => {
    btn.classList.toggle("active", parseInt(btn.dataset.years, 10) === horizonYears);
  });

  const months = horizonYears * 12;
  const combined = new Array(months + 1).fill(0);
  goals.forEach((g) => {
    const series = simulateSeries(g.currentAmount, g.monthlyContribution, g.annualReturnPct, months);
    for (let i = 0; i <= months; i++) combined[i] += series[i];
  });

  const investedToday = goals.reduce((sum, g) => sum + g.currentAmount, 0);
  const monthlyContrib = goals.reduce((sum, g) => sum + g.monthlyContribution, 0);
  const projected = combined[months];

  statInvestedToday.textContent = formatMoney(investedToday);
  statMonthlyContrib.textContent = formatMoney(monthlyContrib);
  statProjectedLabel.textContent = `Projected in ${horizonYears}y`;
  statProjected.textContent = formatCompactMoney(projected);

  renderAreaChart(overviewChartEl, combined, horizonYears, "#2a78d6");
}

// ---------- allocation ----------

function renderAllocation() {
  if (goals.length < 2) {
    allocationPanel.classList.add("hidden");
    return;
  }
  allocationPanel.classList.remove("hidden");

  const sorted = [...goals].sort((a, b) => b.monthlyContribution - a.monthlyContribution);
  const top = sorted.slice(0, 8).map((g, i) => ({
    label: g.name, value: g.monthlyContribution, color: CATEGORICAL[i % CATEGORICAL.length],
  }));
  const rest = sorted.slice(8);
  if (rest.length > 0) {
    top.push({
      label: "Other",
      value: rest.reduce((sum, g) => sum + g.monthlyContribution, 0),
      color: OTHER_COLOR,
    });
  }

  renderBarChart(allocationChartEl, top);
}

// ---------- init ----------

function renderAll() {
  renderCashflow();
  renderOverview();
  renderGoals();
  renderAllocation();
}

renderAll();
