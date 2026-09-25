// Money shell: tab navigation between a native Dashboard and the existing
// expense-tracker / investment-planner apps, embedded unmodified as iframes.
//
// Embedding them as iframes (rather than merging their markup/CSS/JS into
// one page) is deliberate: each app keeps its own DOM ids, CSS classes and
// global JS scope, so nothing here can collide with or accidentally break
// either app's working code. Supabase's JS client persists the signed-in
// session in localStorage, which is shared across same-origin iframes, so
// signing in once here (or in either iframe) signs in everywhere — no
// separate sign-in per tab.
//
// The Dashboard tab is the one genuinely new piece: it read-only pulls
// both apps' app_state rows ("expenses", "investment") directly, the same
// way each app pulls its own on boot, and never pushes — editing still
// happens in the Spending/Investments tabs, which remain each app's own
// source of truth.

const TAB_STORAGE_KEY = "money.activeTab";

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function currentMonthKey(dateStr) {
  return dateStr.slice(0, 7); // "YYYY-MM"
}

function formatDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatMoney(n) {
  const sign = n < 0 ? "-" : "";
  return sign + "$" + Math.abs(n).toFixed(2);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Mirrors expense-tracker/script.js's clampedDate + getCardCycleRange
// exactly (same billing-cycle math budget-alert and sheet-budget-sync
// also mirror server-side) so a card's usage reads identically here.
function clampedDate(year, month, day) {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, lastDay));
}

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
    return "Statement cycle";
  }
  return "Calendar month";
}

// --- tabs ---

function setActiveTab(tab) {
  document.querySelectorAll(".tab-bar-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  document.getElementById("tab-dashboard").classList.toggle("hidden", tab !== "dashboard");
  document.getElementById("tab-spending").classList.toggle("hidden", tab !== "spending");
  document.getElementById("tab-investments").classList.toggle("hidden", tab !== "investments");
  localStorage.setItem(TAB_STORAGE_KEY, tab);
  if (tab === "dashboard") renderDashboard();
}

document.querySelector(".tab-bar").addEventListener("click", (event) => {
  const btn = event.target.closest(".tab-bar-btn");
  if (!btn) return;
  setActiveTab(btn.dataset.tab);
});

// --- dashboard ---

async function renderDashboard() {
  const [expensesRemote, investmentRemote] = await Promise.all([
    SupaSync.pullState("expenses"),
    SupaSync.pullState("investment"),
  ]);

  const expensesState = (expensesRemote && expensesRemote.state) || {};
  const investmentState = (investmentRemote && investmentRemote.state) || {};

  const cards = expensesState.cards || [];
  const expenses = expensesState.expenses || [];
  const monthlyBudget = expensesState.monthlyBudget ?? null;
  const accounts = investmentState.accounts || [];

  const thisMonth = currentMonthKey(todayStr());

  // Investments hero
  const totalInvested = accounts.reduce((sum, a) => sum + a.currentBalance, 0);
  document.getElementById("dash-total-investments").textContent = formatMoney(totalInvested);
  document.getElementById("dash-investments-hint").textContent =
    accounts.length === 0 ? "No accounts yet — add one in the Investments tab." : `${accounts.length} account${accounts.length === 1 ? "" : "s"}`;

  // Spend vs budget
  const monthSpent = expenses
    .filter((e) => currentMonthKey(e.date) === thisMonth)
    .reduce((sum, e) => sum + e.amount, 0);
  document.getElementById("dash-spent").textContent = formatMoney(monthSpent);

  const budgetFillEl = document.getElementById("dash-budget-fill");
  const budgetSubEl = document.getElementById("dash-budget-sub");
  if (monthlyBudget === null) {
    budgetFillEl.style.width = "0%";
    budgetFillEl.className = "progress-fill";
    budgetSubEl.textContent = "No budget set — set one in the Spending tab.";
  } else {
    const pct = monthlyBudget > 0 ? Math.min((monthSpent / monthlyBudget) * 100, 100) : 0;
    let fillClass = "progress-fill";
    if (monthSpent >= monthlyBudget) fillClass += " over";
    else if (monthSpent >= monthlyBudget * 0.7) fillClass += " warn";
    budgetFillEl.className = fillClass;
    budgetFillEl.style.width = `${pct}%`;
    budgetSubEl.textContent = `of ${formatMoney(monthlyBudget)} budget`;
  }

  // Monthly contributions
  const totalContribution = accounts.reduce((sum, a) => sum + a.monthlyContribution, 0);
  document.getElementById("dash-contrib").textContent = formatMoney(totalContribution);
  document.getElementById("dash-contrib-sub").textContent = "across all investment accounts";

  // Cards
  const cardsListEl = document.getElementById("dash-cards-list");
  if (cards.length === 0) {
    cardsListEl.innerHTML = '<p class="empty-state">No cards yet — add one in the Spending tab.</p>';
  } else {
    cardsListEl.innerHTML = cards
      .map((card) => {
        const { start, end } = getCardCycleRange(card, todayStr());
        const spent = expenses
          .filter((e) => e.cardId === card.id && e.date >= start && e.date <= end)
          .reduce((sum, e) => sum + e.amount, 0);
        const pct = card.cap > 0 ? Math.min((spent / card.cap) * 100, 100) : 0;
        let fillClass = "progress-fill";
        if (spent >= card.cap) fillClass += " over";
        else if (spent >= card.cap * 0.7) fillClass += " warn";
        return `
          <div class="card-item">
            <div class="card-item-top">
              <span class="name">${escapeHtml(card.name)}</span>
              <span class="amounts">${formatMoney(spent)} / ${formatMoney(card.cap)}</span>
            </div>
            <div class="progress-track">
              <div class="${fillClass}" style="width: ${pct}%"></div>
            </div>
            <span class="cycle-label">${escapeHtml(cycleLabel(card))}</span>
          </div>
        `;
      })
      .join("");
  }

  document.getElementById("dashboard-subtitle").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

document.getElementById("dash-refresh-btn").addEventListener("click", renderDashboard);

// --- boot ---

SupaSync.mountAuthGate(document.getElementById("authGate"), () => {
  document.getElementById("app-content").style.display = "";
  setActiveTab(localStorage.getItem(TAB_STORAGE_KEY) || "dashboard");
});
