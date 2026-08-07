const STORAGE_KEYS = {
  cards: "budgetTracker.cards",
  expenses: "budgetTracker.expenses",
  categories: "budgetTracker.categories",
};

const DEFAULT_CATEGORIES = ["Food", "Transport", "Shopping", "Bills", "Entertainment", "Other"];

let cards = load(STORAGE_KEYS.cards, []);
let expenses = load(STORAGE_KEYS.expenses, []);
let categories = load(STORAGE_KEYS.categories, DEFAULT_CATEGORIES);
let editingCardId = null;

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

// --- elements ---

const cardsListEl = document.getElementById("cards-list");
const addCardBtn = document.getElementById("add-card-btn");
const addCardForm = document.getElementById("add-card-form");
const cancelCardBtn = document.getElementById("cancel-card-btn");
const cardNameInput = document.getElementById("card-name");
const cardCapInput = document.getElementById("card-cap");

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

const thisMonth = currentMonthKey(todayStr());

monthLabelEl.textContent = new Date().toLocaleDateString(undefined, {
  month: "long",
  year: "numeric",
});
expenseDateInput.value = todayStr();

// --- rendering ---

function render() {
  renderCards();
  renderCardSelect();
  renderCategories();
  renderCategorySelect();
  renderExpenses();
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

    const spent = expenses
      .filter((e) => e.cardId === card.id && currentMonthKey(e.date) === thisMonth)
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
      <button type="button" class="edit-card-btn" data-id="${card.id}">Edit</button>
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
  form.append(nameInput, capInput, actions);
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
  for (const category of categories) {
    const chip = document.createElement("span");
    chip.className = "category-chip";
    chip.innerHTML = `${escapeHtml(category)} <button type="button" class="delete-category-btn" data-name="${escapeHtml(category)}" aria-label="Delete">&times;</button>`;
    categoriesListEl.appendChild(chip);
  }
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

function renderExpenses() {
  const monthExpenses = expenses
    .filter((e) => currentMonthKey(e.date) === thisMonth)
    .sort((a, b) => b.date.localeCompare(a.date));

  const total = monthExpenses.reduce((sum, e) => sum + e.amount, 0);
  monthTotalEl.textContent = formatMoney(total);

  expenseListEl.innerHTML = "";
  if (monthExpenses.length === 0) {
    expenseListEl.innerHTML = '<p class="empty-state">No expenses logged this month yet.</p>';
    return;
  }

  for (const expense of monthExpenses) {
    const row = document.createElement("div");
    row.className = "expense-row";
    row.innerHTML = `
      <div>
        <div>${escapeHtml(expense.category)}${expense.note ? " — " + escapeHtml(expense.note) : ""}</div>
        <div class="meta">${expense.date} · ${escapeHtml(paymentMethodLabel(expense.cardId))}</div>
      </div>
      <div style="display:flex; align-items:center;">
        <span class="amount">${formatMoney(expense.amount)}</span>
        <button class="delete-btn" data-id="${expense.id}" aria-label="Delete">&times;</button>
      </div>
    `;
    expenseListEl.appendChild(row);
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

addCardBtn.addEventListener("click", () => {
  addCardForm.classList.remove("hidden");
  cardNameInput.focus();
});

cancelCardBtn.addEventListener("click", () => {
  addCardForm.classList.add("hidden");
  addCardForm.reset();
});

addCardForm.addEventListener("submit", (event) => {
  event.preventDefault();
  cards.push({
    id: uid(),
    name: cardNameInput.value.trim(),
    cap: parseFloat(cardCapInput.value),
  });
  save();
  addCardForm.reset();
  addCardForm.classList.add("hidden");
  render();
});

cardsListEl.addEventListener("click", (event) => {
  const editBtn = event.target.closest(".edit-card-btn");
  if (editBtn) {
    editingCardId = editBtn.dataset.id;
    renderCards();
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
    const card = cards.find((c) => c.id === saveEditBtn.dataset.id);
    if (card && name && !Number.isNaN(cap)) {
      card.name = name;
      card.cap = cap;
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
  const btn = event.target.closest(".delete-category-btn");
  if (!btn) return;
  categories = categories.filter((c) => c !== btn.dataset.name);
  save();
  render();
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

expenseListEl.addEventListener("click", (event) => {
  const btn = event.target.closest(".delete-btn");
  if (!btn) return;
  expenses = expenses.filter((e) => e.id !== btn.dataset.id);
  save();
  render();
});

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
