const STORAGE_KEYS = {
  cards: "budgetTracker.cards",
  expenses: "budgetTracker.expenses",
  categories: "budgetTracker.categories",
  monthlyBudget: "budgetTracker.monthlyBudget",
};

const DEFAULT_CATEGORIES = ["Food", "Transport", "Shopping", "Bills", "Entertainment", "Other"];

let cards = load(STORAGE_KEYS.cards, []);
let expenses = load(STORAGE_KEYS.expenses, []);
let categories = load(STORAGE_KEYS.categories, DEFAULT_CATEGORIES);
let monthlyBudget = load(STORAGE_KEYS.monthlyBudget, null);
let editingCardId = null;
let editingExpenseId = null;

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save() {
  localStorage.setItem(STORAGE_KEYS.cards, JSON.stringify(cards));
  localStorage.setItem(STORAGE_KEYS.expenses, JSON.stringify(expenses));
  localStorage.setItem(STORAGE_KEYS.categories, JSON.stringify(categories));
  localStorage.setItem(STORAGE_KEYS.monthlyBudget, JSON.stringify(monthlyBudget));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function currentMonthKey(dateStr) {
  return dateStr.slice(0, 7); // "YYYY-MM"
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function formatMoney(n) {
  return `$${n.toFixed(2)}`;
}

function formatDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Builds a date, clamping the day to the last day of the target month
// (e.g. statement day 31 in February becomes Feb 28/29).
function clampedDate(year, month, day) {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, lastDay));
}

// Returns the [start, end] (inclusive, "YYYY-MM-DD") of the billing cycle
// that `referenceDateStr` falls into, given a card's reset mode.
function getCardCycleRange(card, referenceDateStr) {
  const ref = new Date(referenceDateStr + "T00:00:00");

  if (card.resetMode === "statement" && card.statementDay) {
    const day = card.statementDay;
    let startYear = ref.getFullYear();
    let startMonth = ref.getMonth();
    if (ref.getDate() < day) {
      startMonth -= 1;
      if (startMonth < 0) {
        startMonth = 11;
        startYear -= 1;
      }
    }
    const start = clampedDate(startYear, startMonth, day);

    let endYear = startYear;
    let endMonth = startMonth + 1;
    if (endMonth > 11) {
      endMonth = 0;
      endYear += 1;
    }
    const nextStart = clampedDate(endYear, endMonth, day);
    const end = new Date(nextStart);
    end.setDate(end.getDate() - 1);

    return { start: formatDateStr(start), end: formatDateStr(end) };
  }

  const start = new Date(ref.getFullYear(), ref.getMonth(), 1);
  const end = new Date(ref.getFullYear(), ref.getMonth() + 1, 0);
  return { start: formatDateStr(start), end: formatDateStr(end) };
}

function cycleLabel(card) {
  if (card.resetMode === "statement" && card.statementDay) {
    const { start, end } = getCardCycleRange(card, todayStr());
    return `Cycle: ${formatShort(start)} – ${formatShort(end)}`;
  }
  return "Resets calendar month";
}

function formatShort(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// --- elements ---

const cardsListEl = document.getElementById("cards-list");
const addCardBtn = document.getElementById("add-card-btn");
const addCardForm = document.getElementById("add-card-form");
const cancelCardBtn = document.getElementById("cancel-card-btn");
const cardNameInput = document.getElementById("card-name");
const cardCapInput = document.getElementById("card-cap");
const cardStatementDayInput = document.getElementById("card-statement-day");
const cardResetModeRadios = document.querySelectorAll('input[name="card-reset-mode"]');

const categoriesListEl = document.getElementById("categories-list");
const addCategoryBtn = document.getElementById("add-category-btn");
const addCategoryForm = document.getElementById("add-category-form");
const cancelCategoryBtn = document.getElementById("cancel-category-btn");
const categoryNameInput = document.getElementById("category-name");

const expenseForm = document.getElementById("add-expense-form");
const expenseAmountInput = document.getElementById("expense-amount");
const expenseCategoryInput = document.getElementById("expense-category");
const expenseCardSelect = document.getElementById("expense-card");
const expenseDateInput = document.getElementById("expense-date");
const expenseNoteInput = document.getElementById("expense-note");

const expenseListEl = document.getElementById("expense-list");
const monthTotalEl = document.getElementById("month-total");
const monthLabelEl = document.getElementById("month-label");

const budgetDisplayEl = document.getElementById("budget-display");
const editBudgetBtn = document.getElementById("edit-budget-btn");
const editBudgetForm = document.getElementById("edit-budget-form");
const cancelBudgetBtn = document.getElementById("cancel-budget-btn");
const budgetInput = document.getElementById("budget-input");

const searchTextInput = document.getElementById("search-text");
const searchCategorySelect = document.getElementById("search-category");
const searchDateFromInput = document.getElementById("search-date-from");
const searchDateToInput = document.getElementById("search-date-to");
const clearSearchBtn = document.getElementById("clear-search-btn");
const searchResultsEl = document.getElementById("search-results");
const searchResultSummaryEl = document.getElementById("search-result-summary");
const searchTotalEl = document.getElementById("search-total");

const thisMonth = currentMonthKey(todayStr());

monthLabelEl.textContent = new Date().toLocaleDateString(undefined, {
  month: "long",
  year: "numeric",
});
expenseDateInput.value = todayStr();

// --- rendering ---

function render() {
  renderBudget();
  renderCards();
  renderCardSelect();
  renderCategories();
  renderCategorySelect();
  renderExpenses();
  renderSearchCategorySelect();
  renderSearchResults();
}

function monthlyTotalSpent() {
  return expenses
    .filter((e) => currentMonthKey(e.date) === thisMonth)
    .reduce((sum, e) => sum + e.amount, 0);
}

function renderBudget() {
  if (monthlyBudget === null) {
    budgetDisplayEl.innerHTML = '<p class="empty-state">No budget set yet — tap Edit to set how much you want to spend this month.</p>';
    return;
  }

  const spent = monthlyTotalSpent();
  const remaining = monthlyBudget - spent;
  const pct = monthlyBudget > 0 ? Math.min((spent / monthlyBudget) * 100, 100) : 0;
  let fillClass = "";
  if (spent >= monthlyBudget) fillClass = "over";
  else if (spent >= monthlyBudget * 0.7) fillClass = "warn";

  const remainingLabel =
    remaining >= 0 ? `${formatMoney(remaining)} left this month` : `${formatMoney(Math.abs(remaining))} over budget`;

  budgetDisplayEl.innerHTML = `
    <div class="card-item-top">
      <span class="amounts">${formatMoney(spent)} / ${formatMoney(monthlyBudget)}</span>
    </div>
    <div class="progress-track">
      <div class="progress-fill ${fillClass}" style="width: ${pct}%"></div>
    </div>
    <span class="cycle-label">${escapeHtml(remainingLabel)}</span>
  `;
}

function renderCards() {
  cardsListEl.innerHTML = "";

  if (cards.length === 0) {
    cardsListEl.innerHTML = '<p class="empty-state">No cards yet — add one to track a spending cap (or log expenses as Cash / Other below).</p>';
    return;
  }

  for (const card of cards) {
    if (editingCardId === card.id) {
      cardsListEl.appendChild(buildCardEditForm(card));
      continue;
    }

    const { start, end } = getCardCycleRange(card, todayStr());
    const spent = expenses
      .filter((e) => e.cardId === card.id && e.date >= start && e.date <= end)
      .reduce((sum, e) => sum + e.amount, 0);

    const pct = card.cap > 0 ? Math.min((spent / card.cap) * 100, 100) : 0;
    let fillClass = "";
    if (spent >= card.cap) fillClass = "over";
    else if (spent >= card.cap * 0.7) fillClass = "warn";

    const item = document.createElement("div");
    item.className = "card-item";
    item.innerHTML = `
      <div class="card-item-top">
        <span class="name">${escapeHtml(card.name)}</span>
        <span class="amounts">${formatMoney(spent)} / ${formatMoney(card.cap)}</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill ${fillClass}" style="width: ${pct}%"></div>
      </div>
      <span class="cycle-label">${escapeHtml(cycleLabel(card))}</span>
      <div class="card-actions">
        <button type="button" class="edit-card-btn" data-id="${card.id}">Edit</button>
        <button type="button" class="delete-card-btn" data-id="${card.id}">Delete</button>
      </div>
    `;
    cardsListEl.appendChild(item);
  }
}

function buildCardEditForm(card) {
  const item = document.createElement("div");
  item.className = "card-item";

  const form = document.createElement("div");
  form.className = "inline-form";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = card.name;
  nameInput.className = "edit-card-name";

  const capInput = document.createElement("input");
  capInput.type = "number";
  capInput.min = "0";
  capInput.step = "0.01";
  capInput.value = card.cap;
  capInput.className = "edit-card-cap";

  const isStatement = card.resetMode === "statement";

  const radioGroup = document.createElement("div");
  radioGroup.className = "radio-group";

  const calendarLabel = document.createElement("label");
  const calendarRadio = document.createElement("input");
  calendarRadio.type = "radio";
  calendarRadio.name = `edit-card-reset-mode-${card.id}`;
  calendarRadio.value = "calendar";
  calendarRadio.className = "edit-card-reset-mode";
  calendarRadio.checked = !isStatement;
  calendarLabel.append(calendarRadio, " Resets calendar month");

  const statementLabel = document.createElement("label");
  const statementRadio = document.createElement("input");
  statementRadio.type = "radio";
  statementRadio.name = `edit-card-reset-mode-${card.id}`;
  statementRadio.value = "statement";
  statementRadio.className = "edit-card-reset-mode";
  statementRadio.checked = isStatement;
  statementLabel.append(statementRadio, " Resets on statement date");

  radioGroup.append(calendarLabel, statementLabel);

  const statementDayInput = document.createElement("input");
  statementDayInput.type = "number";
  statementDayInput.min = "1";
  statementDayInput.max = "31";
  statementDayInput.placeholder = "Statement day (1-31)";
  statementDayInput.className = "edit-card-statement-day";
  if (card.statementDay) statementDayInput.value = card.statementDay;
  if (!isStatement) statementDayInput.classList.add("hidden");

  radioGroup.addEventListener("change", (event) => {
    if (event.target.classList.contains("edit-card-reset-mode")) {
      statementDayInput.classList.toggle("hidden", event.target.value !== "statement");
    }
  });

  const actions = document.createElement("div");
  actions.className = "form-actions";

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = "Save";
  saveBtn.className = "save-card-edit";
  saveBtn.dataset.id = card.id;

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.className = "secondary cancel-card-edit";

  actions.append(saveBtn, cancelBtn);
  form.append(nameInput, capInput, radioGroup, statementDayInput, actions);
  item.appendChild(form);
  return item;
}

function renderCardSelect() {
  const currentValue = expenseCardSelect.value;
  expenseCardSelect.innerHTML =
    '<option value="" disabled selected>Payment method</option><option value="cash">Cash / Other</option>';
  for (const card of cards) {
    const opt = document.createElement("option");
    opt.value = card.id;
    opt.textContent = card.name;
    expenseCardSelect.appendChild(opt);
  }
  if (currentValue === "cash" || cards.some((c) => c.id === currentValue)) {
    expenseCardSelect.value = currentValue;
  }
}

function renderCategories() {
  categoriesListEl.innerHTML = "";
  if (categories.length === 0) {
    categoriesListEl.innerHTML = '<p class="empty-state">No categories yet — add one below.</p>';
    return;
  }
  categories.forEach((category, index) => {
    const chip = document.createElement("span");
    chip.className = "category-chip";
    chip.innerHTML = `
      <button type="button" class="move-category-btn" data-name="${escapeHtml(category)}" data-direction="-1" aria-label="Move earlier" ${index === 0 ? "disabled" : ""}>&#8249;</button>
      ${escapeHtml(category)}
      <button type="button" class="move-category-btn" data-name="${escapeHtml(category)}" data-direction="1" aria-label="Move later" ${index === categories.length - 1 ? "disabled" : ""}>&#8250;</button>
      <button type="button" class="delete-category-btn" data-name="${escapeHtml(category)}" aria-label="Delete">&times;</button>
    `;
    categoriesListEl.appendChild(chip);
  });
}

function renderCategorySelect() {
  const currentValue = expenseCategoryInput.value;
  expenseCategoryInput.innerHTML = '<option value="" disabled selected>Category</option>';
  for (const category of categories) {
    const opt = document.createElement("option");
    opt.value = category;
    opt.textContent = category;
    expenseCategoryInput.appendChild(opt);
  }
  if (categories.includes(currentValue)) {
    expenseCategoryInput.value = currentValue;
  }
}

function buildExpenseRow(expense) {
  if (editingExpenseId === expense.id) {
    return buildExpenseEditForm(expense);
  }

  const row = document.createElement("div");
  row.className = "expense-row";
  row.innerHTML = `
    <div>
      <div>${escapeHtml(expense.category)}${expense.note ? " — " + escapeHtml(expense.note) : ""}</div>
      <div class="meta">${expense.date} · ${escapeHtml(paymentMethodLabel(expense.cardId))}</div>
    </div>
    <div style="display:flex; align-items:center;">
      <span class="amount">${formatMoney(expense.amount)}</span>
      <button class="edit-expense-btn" data-id="${expense.id}" aria-label="Edit">&#9998;</button>
      <button class="delete-btn" data-id="${expense.id}" aria-label="Delete">&times;</button>
    </div>
  `;
  return row;
}

function buildExpenseEditForm(expense) {
  const row = document.createElement("div");
  row.className = "expense-row expense-edit-row";

  const form = document.createElement("div");
  form.className = "inline-form";

  const amountInput = document.createElement("input");
  amountInput.type = "number";
  amountInput.min = "0";
  amountInput.step = "0.01";
  amountInput.value = expense.amount;
  amountInput.className = "edit-expense-amount";

  const categorySelect = document.createElement("select");
  categorySelect.className = "edit-expense-category";
  const categoryOptions = categories.includes(expense.category)
    ? categories
    : [...categories, expense.category];
  for (const category of categoryOptions) {
    const opt = document.createElement("option");
    opt.value = category;
    opt.textContent = category;
    categorySelect.appendChild(opt);
  }
  categorySelect.value = expense.category;

  const paymentSelect = document.createElement("select");
  paymentSelect.className = "edit-expense-card";
  const cashOpt = document.createElement("option");
  cashOpt.value = "cash";
  cashOpt.textContent = "Cash / Other";
  paymentSelect.appendChild(cashOpt);
  for (const card of cards) {
    const opt = document.createElement("option");
    opt.value = card.id;
    opt.textContent = card.name;
    paymentSelect.appendChild(opt);
  }
  if (expense.cardId === "cash" || cards.some((c) => c.id === expense.cardId)) {
    paymentSelect.value = expense.cardId;
  }

  const dateInput = document.createElement("input");
  dateInput.type = "date";
  dateInput.value = expense.date;
  dateInput.className = "edit-expense-date";

  const noteInput = document.createElement("input");
  noteInput.type = "text";
  noteInput.placeholder = "Note (optional)";
  noteInput.value = expense.note || "";
  noteInput.className = "edit-expense-note";

  const actions = document.createElement("div");
  actions.className = "form-actions";

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = "Save";
  saveBtn.className = "save-expense-edit";
  saveBtn.dataset.id = expense.id;

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.className = "secondary cancel-expense-edit";

  actions.append(saveBtn, cancelBtn);
  form.append(amountInput, categorySelect, paymentSelect, dateInput, noteInput, actions);
  row.appendChild(form);
  return row;
}

function renderExpenses() {
  const monthExpenses = expenses
    .filter((e) => currentMonthKey(e.date) === thisMonth)
    .sort((a, b) => b.date.localeCompare(a.date));

  monthTotalEl.textContent = formatMoney(monthlyTotalSpent());

  expenseListEl.innerHTML = "";
  if (monthExpenses.length === 0) {
    expenseListEl.innerHTML = '<p class="empty-state">No expenses logged this month yet.</p>';
    return;
  }

  for (const expense of monthExpenses) {
    expenseListEl.appendChild(buildExpenseRow(expense));
  }
}

function renderSearchCategorySelect() {
  const currentValue = searchCategorySelect.value;
  searchCategorySelect.innerHTML = '<option value="">All categories</option>';
  for (const category of categories) {
    const opt = document.createElement("option");
    opt.value = category;
    opt.textContent = category;
    searchCategorySelect.appendChild(opt);
  }
  if (categories.includes(currentValue)) {
    searchCategorySelect.value = currentValue;
  }
}

function renderSearchResults() {
  const text = searchTextInput.value.trim().toLowerCase();
  const category = searchCategorySelect.value;
  const dateFrom = searchDateFromInput.value;
  const dateTo = searchDateToInput.value;
  const hasFilter = text || category || dateFrom || dateTo;

  const results = expenses
    .filter((e) => {
      if (text && !(e.note || "").toLowerCase().includes(text)) return false;
      if (category && e.category !== category) return false;
      if (dateFrom && e.date < dateFrom) return false;
      if (dateTo && e.date > dateTo) return false;
      return true;
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  const total = results.reduce((sum, e) => sum + e.amount, 0);
  searchTotalEl.textContent = results.length ? formatMoney(total) : "";
  searchResultSummaryEl.textContent = hasFilter
    ? `${results.length} match${results.length === 1 ? "" : "es"}`
    : "Use the filters above to search all expenses";

  searchResultsEl.innerHTML = "";
  if (!hasFilter) return;
  if (results.length === 0) {
    searchResultsEl.innerHTML = '<p class="empty-state">No matching expenses.</p>';
    return;
  }

  for (const expense of results) {
    searchResultsEl.appendChild(buildExpenseRow(expense));
  }
}

function paymentMethodLabel(cardId) {
  if (cardId === "cash") return "Cash / Other";
  const card = cards.find((c) => c.id === cardId);
  return card ? card.name : "Unknown";
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// --- events ---

editBudgetBtn.addEventListener("click", () => {
  budgetInput.value = monthlyBudget === null ? "" : monthlyBudget;
  editBudgetForm.classList.remove("hidden");
  budgetDisplayEl.classList.add("hidden");
  budgetInput.focus();
});

cancelBudgetBtn.addEventListener("click", () => {
  editBudgetForm.classList.add("hidden");
  budgetDisplayEl.classList.remove("hidden");
  editBudgetForm.reset();
});

editBudgetForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = parseFloat(budgetInput.value);
  if (!Number.isNaN(value)) {
    monthlyBudget = value;
    save();
  }
  editBudgetForm.classList.add("hidden");
  budgetDisplayEl.classList.remove("hidden");
  render();
});

addCardBtn.addEventListener("click", () => {
  addCardForm.classList.remove("hidden");
  cardNameInput.focus();
});

cancelCardBtn.addEventListener("click", () => {
  addCardForm.classList.add("hidden");
  addCardForm.reset();
  cardStatementDayInput.classList.add("hidden");
});

for (const radio of cardResetModeRadios) {
  radio.addEventListener("change", () => {
    cardStatementDayInput.classList.toggle("hidden", radio.value !== "statement" || !radio.checked);
  });
}

addCardForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const resetMode = document.querySelector('input[name="card-reset-mode"]:checked').value;
  cards.push({
    id: uid(),
    name: cardNameInput.value.trim(),
    cap: parseFloat(cardCapInput.value),
    resetMode,
    statementDay: resetMode === "statement" ? parseInt(cardStatementDayInput.value, 10) : null,
  });
  save();
  addCardForm.reset();
  addCardForm.classList.add("hidden");
  cardStatementDayInput.classList.add("hidden");
  render();
});

cardsListEl.addEventListener("click", (event) => {
  const editBtn = event.target.closest(".edit-card-btn");
  if (editBtn) {
    editingCardId = editBtn.dataset.id;
    renderCards();
    return;
  }

  const deleteBtn = event.target.closest(".delete-card-btn");
  if (deleteBtn) {
    const card = cards.find((c) => c.id === deleteBtn.dataset.id);
    const hasExpenses = expenses.some((e) => e.cardId === deleteBtn.dataset.id);
    const message = hasExpenses
      ? `Delete "${card.name}"? Past expenses logged on it will stay in your history but show as "Unknown".`
      : `Delete "${card.name}"?`;
    if (!window.confirm(message)) return;
    cards = cards.filter((c) => c.id !== deleteBtn.dataset.id);
    save();
    render();
    return;
  }

  const cancelEditBtn = event.target.closest(".cancel-card-edit");
  if (cancelEditBtn) {
    editingCardId = null;
    renderCards();
    return;
  }

  const saveEditBtn = event.target.closest(".save-card-edit");
  if (saveEditBtn) {
    const item = saveEditBtn.closest(".card-item");
    const name = item.querySelector(".edit-card-name").value.trim();
    const cap = parseFloat(item.querySelector(".edit-card-cap").value);
    const resetMode = item.querySelector(".edit-card-reset-mode:checked").value;
    const statementDayRaw = item.querySelector(".edit-card-statement-day").value;
    const statementDay = resetMode === "statement" ? parseInt(statementDayRaw, 10) : null;
    const card = cards.find((c) => c.id === saveEditBtn.dataset.id);
    if (card && name && !Number.isNaN(cap) && (resetMode !== "statement" || !Number.isNaN(statementDay))) {
      card.name = name;
      card.cap = cap;
      card.resetMode = resetMode;
      card.statementDay = statementDay;
      save();
    }
    editingCardId = null;
    render();
  }
});

addCategoryBtn.addEventListener("click", () => {
  addCategoryForm.classList.remove("hidden");
  categoryNameInput.focus();
});

cancelCategoryBtn.addEventListener("click", () => {
  addCategoryForm.classList.add("hidden");
  addCategoryForm.reset();
});

addCategoryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = categoryNameInput.value.trim();
  if (name && !categories.includes(name)) {
    categories.push(name);
    save();
  }
  addCategoryForm.reset();
  addCategoryForm.classList.add("hidden");
  render();
});

categoriesListEl.addEventListener("click", (event) => {
  const deleteBtn = event.target.closest(".delete-category-btn");
  if (deleteBtn) {
    categories = categories.filter((c) => c !== deleteBtn.dataset.name);
    save();
    render();
    return;
  }

  const moveBtn = event.target.closest(".move-category-btn");
  if (moveBtn) {
    const index = categories.indexOf(moveBtn.dataset.name);
    const newIndex = index + parseInt(moveBtn.dataset.direction, 10);
    if (index === -1 || newIndex < 0 || newIndex >= categories.length) return;
    [categories[index], categories[newIndex]] = [categories[newIndex], categories[index]];
    save();
    render();
  }
});

expenseForm.addEventListener("submit", (event) => {
  event.preventDefault();
  expenses.push({
    id: uid(),
    amount: parseFloat(expenseAmountInput.value),
    category: expenseCategoryInput.value,
    cardId: expenseCardSelect.value,
    date: expenseDateInput.value,
    note: expenseNoteInput.value.trim(),
  });
  save();
  expenseForm.reset();
  expenseDateInput.value = todayStr();
  render();
});

function onExpenseRowClick(event) {
  const editBtn = event.target.closest(".edit-expense-btn");
  if (editBtn) {
    editingExpenseId = editBtn.dataset.id;
    render();
    return;
  }

  const cancelBtn = event.target.closest(".cancel-expense-edit");
  if (cancelBtn) {
    editingExpenseId = null;
    render();
    return;
  }

  const saveBtn = event.target.closest(".save-expense-edit");
  if (saveBtn) {
    const row = saveBtn.closest(".expense-row");
    const amount = parseFloat(row.querySelector(".edit-expense-amount").value);
    const category = row.querySelector(".edit-expense-category").value;
    const cardId = row.querySelector(".edit-expense-card").value;
    const date = row.querySelector(".edit-expense-date").value;
    const note = row.querySelector(".edit-expense-note").value.trim();
    const expense = expenses.find((e) => e.id === saveBtn.dataset.id);
    if (expense && !Number.isNaN(amount) && category && cardId && date) {
      expense.amount = amount;
      expense.category = category;
      expense.cardId = cardId;
      expense.date = date;
      expense.note = note;
      save();
    }
    editingExpenseId = null;
    render();
    return;
  }

  const deleteBtn = event.target.closest(".delete-btn");
  if (deleteBtn) {
    expenses = expenses.filter((e) => e.id !== deleteBtn.dataset.id);
    save();
    render();
  }
}

expenseListEl.addEventListener("click", onExpenseRowClick);

searchTextInput.addEventListener("input", renderSearchResults);
searchCategorySelect.addEventListener("change", renderSearchResults);
searchDateFromInput.addEventListener("change", renderSearchResults);
searchDateToInput.addEventListener("change", renderSearchResults);

clearSearchBtn.addEventListener("click", () => {
  searchTextInput.value = "";
  searchCategorySelect.value = "";
  searchDateFromInput.value = "";
  searchDateToInput.value = "";
  renderSearchResults();
});

searchResultsEl.addEventListener("click", onExpenseRowClick);

document.getElementById("export-csv-btn").addEventListener("click", exportCsv);

function exportCsv() {
  const rows = [["Date", "Category", "Payment method", "Amount", "Note"]];
  const sorted = [...expenses].sort((a, b) => a.date.localeCompare(b.date));
  for (const e of sorted) {
    rows.push([e.date, e.category, paymentMethodLabel(e.cardId), e.amount.toFixed(2), e.note || ""]);
  }

  const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `expenses-${todayStr()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

render();
