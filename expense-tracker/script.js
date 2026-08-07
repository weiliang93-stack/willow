const STORAGE_KEYS = {
  cards: "budgetTracker.cards",
  expenses: "budgetTracker.expenses",
};

let cards = load(STORAGE_KEYS.cards, []);
let expenses = load(STORAGE_KEYS.expenses, []);

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

const expenseForm = document.getElementById("add-expense-form");
const expenseAmountInput = document.getElementById("expense-amount");
const expenseCategoryInput = document.getElementById("expense-category");
const expenseCardSelect = document.getElementById("expense-card");
const expenseDateInput = document.getElementById("expense-date");
const expenseNoteInput = document.getElementById("expense-note");
const noCardsHint = document.getElementById("no-cards-hint");

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
  renderExpenses();
}

function renderCards() {
  cardsListEl.innerHTML = "";

  if (cards.length === 0) {
    cardsListEl.innerHTML = '<p class="empty-state">No cards yet — add one to start tracking.</p>';
    noCardsHint.classList.remove("hidden");
    expenseForm.classList.add("hidden");
    return;
  }

  noCardsHint.classList.add("hidden");
  expenseForm.classList.remove("hidden");

  for (const card of cards) {
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
    `;
    cardsListEl.appendChild(item);
  }
}

function renderCardSelect() {
  const currentValue = expenseCardSelect.value;
  expenseCardSelect.innerHTML = '<option value="" disabled selected>Card</option>';
  for (const card of cards) {
    const opt = document.createElement("option");
    opt.value = card.id;
    opt.textContent = card.name;
    expenseCardSelect.appendChild(opt);
  }
  if (cards.some((c) => c.id === currentValue)) {
    expenseCardSelect.value = currentValue;
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
    const card = cards.find((c) => c.id === expense.cardId);
    const row = document.createElement("div");
    row.className = "expense-row";
    row.innerHTML = `
      <div>
        <div>${escapeHtml(expense.category)}${expense.note ? " — " + escapeHtml(expense.note) : ""}</div>
        <div class="meta">${expense.date} · ${card ? escapeHtml(card.name) : "Unknown card"}</div>
      </div>
      <div style="display:flex; align-items:center;">
        <span class="amount">${formatMoney(expense.amount)}</span>
        <button class="delete-btn" data-id="${expense.id}" aria-label="Delete">&times;</button>
      </div>
    `;
    expenseListEl.appendChild(row);
  }
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
  const rows = [["Date", "Category", "Card", "Amount", "Note"]];
  const sorted = [...expenses].sort((a, b) => a.date.localeCompare(b.date));
  for (const e of sorted) {
    const card = cards.find((c) => c.id === e.cardId);
    rows.push([e.date, e.category, card ? card.name : "Unknown", e.amount.toFixed(2), e.note || ""]);
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
