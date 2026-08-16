const STORAGE_KEYS = {
  annualExpenses: "investmentPlanner.annualExpenses",
  withdrawalRate: "investmentPlanner.withdrawalRate",
  accounts: "investmentPlanner.accounts",
  horizonMode: "investmentPlanner.horizonMode",
};

const CATEGORICAL = [
  "#2a78d6", "#eb6834", "#1baf7a", "#eda100",
  "#e87ba4", "#008300", "#4a3aa7", "#e34948",
];
const OTHER_COLOR = "#898781";
const GOOD_COLOR = "#0ca30c";
const CAP_MONTHS = 720; // 60 years

let annualExpenses = load(STORAGE_KEYS.annualExpenses, 0);
let withdrawalRate = load(STORAGE_KEYS.withdrawalRate, 4);
let accounts = load(STORAGE_KEYS.accounts, []);
let horizonMode = load(STORAGE_KEYS.horizonMode, "auto");

let editingAccountId = null;

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw !== null ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save() {
  localStorage.setItem(STORAGE_KEYS.annualExpenses, JSON.stringify(annualExpenses));
  localStorage.setItem(STORAGE_KEYS.withdrawalRate, JSON.stringify(withdrawalRate));
  localStorage.setItem(STORAGE_KEYS.accounts, JSON.stringify(accounts));
  localStorage.setItem(STORAGE_KEYS.horizonMode, JSON.stringify(horizonMode));
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
  if (m === null) return "60+ yrs";
  if (m <= 0) return "Already there";
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

function simulateCombinedSeries(accts, months) {
  const series = new Array(months + 1).fill(0);
  accts.forEach((acc) => {
    const s = simulateSeries(acc.currentBalance, acc.monthlyContribution, acc.annualReturnPct, months);
    for (let i = 0; i <= months; i++) series[i] += s[i];
  });
  return series;
}

function findCrossingMonth(series, threshold) {
  if (threshold <= 0) return 0;
  for (let i = 0; i < series.length; i++) {
    if (series[i] >= threshold) return i;
  }
  return null;
}

function computeFireNumber() {
  if (!(withdrawalRate > 0)) return 0;
  return annualExpenses / (withdrawalRate / 100);
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

// ---------- FI projection chart (area/line + reference line + milestone) ----------

function renderFireChart(container, series, horizonYears, color, { fireNumber, milestoneMonth }) {
  container.innerHTML = "";
  const months = series.length - 1;
  const width = 600, height = 240;
  const padLeft = 56, padRight = 12, padTop = 16, padBottom = 24;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  const maxVal = Math.max(...series, fireNumber || 0, 1);
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
  const xTickCount = Math.min(6, Math.max(2, Math.round(horizonYears)));
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

  // FIRE number reference line (label pinned to the left, clear of the
  // end-of-series value and the FI milestone label, which both live on the right)
  if (fireNumber > 0) {
    const refY = yForVal(fireNumber);
    svg.appendChild(svgEl("line", {
      x1: padLeft, x2: width - padRight, y1: refY, y2: refY,
      stroke: "var(--ink-muted)", "stroke-width": 1.5, "stroke-dasharray": "4 4",
    }));
    svg.appendChild(svgText("text", {
      x: padLeft + 4, y: Math.max(padTop + 8, refY - 6), class: "axis-tick", "text-anchor": "start", "font-weight": 700,
    }, `FIRE number · ${formatCompactMoney(fireNumber)}`));
  }

  // end marker + direct label
  const endX = xForMonth(months), endY = yForVal(series[months]);
  svg.appendChild(svgEl("circle", { cx: endX, cy: endY, r: 4, fill: color, stroke: "var(--surface)", "stroke-width": 2 }));
  svg.appendChild(svgText("text", {
    x: endX - 8, y: endY - 10, class: "axis-tick", "text-anchor": "end", fill: "var(--ink-primary)", "font-weight": 700, "font-size": 11,
  }, formatCompactMoney(series[months])));

  // FI milestone marker
  if (milestoneMonth !== null && milestoneMonth >= 0 && milestoneMonth <= months) {
    const mx = xForMonth(milestoneMonth), my = yForVal(series[milestoneMonth]);
    svg.appendChild(svgEl("circle", { cx: mx, cy: my, r: 5, fill: GOOD_COLOR, stroke: "var(--surface)", "stroke-width": 2 }));
    if (milestoneMonth < months * 0.92 && milestoneMonth > months * 0.08) {
      svg.appendChild(svgText("text", {
        x: mx, y: Math.max(padTop + 8, my - 12), "text-anchor": "middle", fill: GOOD_COLOR, "font-weight": 700, "font-size": 11,
      }, "FI reached"));
    }
  }

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
    const rows = [{ color, label: "Net worth", value: formatMoney(series[idx]) }];
    if (fireNumber > 0) rows.push({ color: "var(--ink-muted)", label: "FIRE number", value: formatMoney(fireNumber) });
    showTooltip(clientX, clientY, title, rows);
  }

  overlay.addEventListener("pointermove", (e) => handleMove(e.clientX, e.clientY));
  overlay.addEventListener("pointerleave", () => {
    crosshair.setAttribute("opacity", 0);
    hoverDot.setAttribute("opacity", 0);
    hideTooltip();
  });

  container.appendChild(svg);
}

// ---------- sparkline (decorative, account cards) ----------

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

const expensesInput = document.getElementById("expenses-input");
const withdrawalRateInput = document.getElementById("withdrawal-rate-input");
const fireNumberValueEl = document.getElementById("fire-number-value");
const fireNumberHintEl = document.getElementById("fire-number-hint");

const accountsListEl = document.getElementById("accounts-list");
const accountsEmptyHint = document.getElementById("accounts-empty-hint");
const addAccountBtn = document.getElementById("add-account-btn");
const addAccountForm = document.getElementById("add-account-form");
const accountNameInput = document.getElementById("account-name");
const accountBalanceInput = document.getElementById("account-balance");
const accountContributionInput = document.getElementById("account-contribution");
const accountReturnInput = document.getElementById("account-return");
const cancelAccountBtn = document.getElementById("cancel-account-btn");
const accountSubmitBtn = document.getElementById("account-submit-btn");
const statTotalBalance = document.getElementById("stat-total-balance");
const statTotalContrib = document.getElementById("stat-total-contrib");

const pathPanel = document.getElementById("path-panel");
const horizonPicker = document.getElementById("horizon-picker");
const fiProgressFill = document.getElementById("fi-progress-fill");
const fiProgressLabel = document.getElementById("fi-progress-label");
const fiProgressPct = document.getElementById("fi-progress-pct");
const statNetworthToday = document.getElementById("stat-networth-today");
const statTimeToFi = document.getElementById("stat-time-to-fi");
const pathChartEl = document.getElementById("path-chart");

const allocationPanel = document.getElementById("allocation-panel");
const allocationChartEl = document.getElementById("allocation-chart");

// ---------- FIRE target ----------

expensesInput.addEventListener("change", () => {
  annualExpenses = parseFloat(expensesInput.value) || 0;
  save();
  renderAll();
});

withdrawalRateInput.addEventListener("change", () => {
  withdrawalRate = parseFloat(withdrawalRateInput.value) || 0;
  save();
  renderAll();
});

function renderFireTarget() {
  expensesInput.value = annualExpenses || "";
  withdrawalRateInput.value = withdrawalRate || "";

  const fireNumber = computeFireNumber();
  fireNumberValueEl.textContent = formatMoney(fireNumber);
  const multiple = withdrawalRate > 0 ? (100 / withdrawalRate).toFixed(1) : "--";
  fireNumberHintEl.textContent = `${multiple}× annual expenses at a ${withdrawalRate || 0}% withdrawal rate`;
}

// ---------- accounts ----------

addAccountBtn.addEventListener("click", () => openAccountForm());
cancelAccountBtn.addEventListener("click", closeAccountForm);

function openAccountForm(account = null) {
  editingAccountId = account ? account.id : null;
  accountSubmitBtn.textContent = account ? "Save changes" : "Save account";
  accountNameInput.value = account ? account.name : "";
  accountBalanceInput.value = account ? account.currentBalance : "";
  accountContributionInput.value = account ? account.monthlyContribution : "";
  accountReturnInput.value = account ? account.annualReturnPct : "";
  addAccountForm.classList.remove("hidden");
  accountNameInput.focus();
}

function closeAccountForm() {
  editingAccountId = null;
  addAccountForm.reset();
  addAccountForm.classList.add("hidden");
}

addAccountForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = accountNameInput.value.trim();
  const currentBalance = parseFloat(accountBalanceInput.value);
  const monthlyContribution = parseFloat(accountContributionInput.value);
  const annualReturnPct = parseFloat(accountReturnInput.value);
  if (!name || !(currentBalance >= 0) || !(monthlyContribution >= 0) || !(annualReturnPct >= 0)) return;

  if (editingAccountId) {
    const account = accounts.find((a) => a.id === editingAccountId);
    Object.assign(account, { name, currentBalance, monthlyContribution, annualReturnPct });
  } else {
    accounts.push({ id: uid(), name, currentBalance, monthlyContribution, annualReturnPct });
  }
  save();
  closeAccountForm();
  renderAll();
});

function removeAccount(id) {
  accounts = accounts.filter((a) => a.id !== id);
  save();
  renderAll();
}

function renderAccounts() {
  accountsListEl.innerHTML = "";
  accountsEmptyHint.classList.toggle("hidden", accounts.length > 0);

  accounts.forEach((account) => {
    const card = document.createElement("div");
    card.className = "account-card";

    const top = document.createElement("div");
    top.className = "account-card-top";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = account.name;
    const actions = document.createElement("div");
    actions.className = "account-card-actions";
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => openAccountForm(account));
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "remove-account-btn";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => removeAccount(account.id));
    actions.appendChild(editBtn);
    actions.appendChild(removeBtn);
    top.appendChild(name);
    top.appendChild(actions);

    const meta = document.createElement("div");
    meta.className = "account-card-meta";
    const metaLeft = document.createElement("span");
    metaLeft.textContent = `${formatMoney(account.currentBalance)} balance`;
    const metaRight = document.createElement("span");
    metaRight.textContent = `${account.annualReturnPct}% / yr`;
    meta.appendChild(metaLeft);
    meta.appendChild(metaRight);

    const body = document.createElement("div");
    body.className = "account-card-body";
    const sparklineEl = document.createElement("div");
    sparklineEl.className = "sparkline";
    const stats = document.createElement("div");
    stats.className = "account-card-stats";

    const series = simulateSeries(account.currentBalance, account.monthlyContribution, account.annualReturnPct, 120);

    const contribLine = document.createElement("div");
    contribLine.append("Contributing ");
    const contribStrong = document.createElement("strong");
    contribStrong.textContent = `${formatMoney(account.monthlyContribution)}/mo`;
    contribLine.appendChild(contribStrong);

    const projectedLine = document.createElement("div");
    projectedLine.append("In 10 yrs: ");
    const projectedStrong = document.createElement("strong");
    projectedStrong.textContent = formatCompactMoney(series[120]);
    projectedLine.appendChild(projectedStrong);

    stats.appendChild(contribLine);
    stats.appendChild(projectedLine);
    body.appendChild(sparklineEl);
    body.appendChild(stats);

    card.appendChild(top);
    card.appendChild(meta);
    card.appendChild(body);
    accountsListEl.appendChild(card);

    renderSparkline(sparklineEl, series, "#2a78d6");
  });

  const totalBalance = accounts.reduce((sum, a) => sum + a.currentBalance, 0);
  const totalContribution = accounts.reduce((sum, a) => sum + a.monthlyContribution, 0);
  statTotalBalance.textContent = formatMoney(totalBalance);
  statTotalContrib.textContent = formatMoney(totalContribution);
}

// ---------- path to FI ----------

horizonPicker.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn) return;
  horizonMode = btn.dataset.mode;
  save();
  renderPath();
});

function renderPath() {
  if (accounts.length === 0) {
    pathPanel.classList.add("hidden");
    return;
  }
  pathPanel.classList.remove("hidden");

  [...horizonPicker.querySelectorAll("button")].forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === horizonMode);
  });

  const fireNumber = computeFireNumber();
  const capSeries = simulateCombinedSeries(accounts, CAP_MONTHS);
  const fiMonth = findCrossingMonth(capSeries, fireNumber);

  let displayMonths;
  if (horizonMode === "auto") {
    if (fiMonth !== null) {
      displayMonths = Math.min(CAP_MONTHS, Math.max(24, fiMonth + Math.max(24, Math.round(fiMonth * 0.15))));
    } else {
      displayMonths = CAP_MONTHS;
    }
  } else {
    displayMonths = parseInt(horizonMode, 10) * 12;
  }

  const displaySeries = displayMonths <= CAP_MONTHS
    ? capSeries.slice(0, displayMonths + 1)
    : simulateCombinedSeries(accounts, displayMonths);

  const totalBalance = accounts.reduce((sum, a) => sum + a.currentBalance, 0);
  const progressPct = fireNumber > 0 ? Math.min(100, (totalBalance / fireNumber) * 100) : 0;

  fiProgressFill.style.width = `${progressPct}%`;
  fiProgressLabel.textContent = `${formatMoney(totalBalance)} of ${formatMoney(fireNumber)}`;
  fiProgressPct.textContent = `${progressPct.toFixed(0)}%`;

  statNetworthToday.textContent = formatMoney(totalBalance);
  statTimeToFi.textContent = formatMonths(fiMonth);

  const milestoneMonth = fiMonth !== null && fiMonth <= displayMonths ? fiMonth : null;
  renderFireChart(pathChartEl, displaySeries, displayMonths / 12, "#2a78d6", { fireNumber, milestoneMonth });
}

// ---------- allocation ----------

function renderAllocation() {
  if (accounts.length < 2) {
    allocationPanel.classList.add("hidden");
    return;
  }
  allocationPanel.classList.remove("hidden");

  const sorted = [...accounts].sort((a, b) => b.monthlyContribution - a.monthlyContribution);
  const top = sorted.slice(0, 8).map((a, i) => ({
    label: a.name, value: a.monthlyContribution, color: CATEGORICAL[i % CATEGORICAL.length],
  }));
  const rest = sorted.slice(8);
  if (rest.length > 0) {
    top.push({
      label: "Other",
      value: rest.reduce((sum, a) => sum + a.monthlyContribution, 0),
      color: OTHER_COLOR,
    });
  }

  renderBarChart(allocationChartEl, top);
}

// ---------- init ----------

function renderAll() {
  renderFireTarget();
  renderAccounts();
  renderPath();
  renderAllocation();
}

renderAll();
