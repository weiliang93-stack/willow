// Loh Family Hub. Hub edits are saved only to app_state "familyhub",
// and only after a fresh pull. Expense rows are read to render Money
// and are never written from this file.

const L = window.FamilyHubLogic;
const SEED = window.FAMILY_HUB_SEED;
const LOCAL_KEY = "familyhub.cache";
const TAB_KEY = "familyhub.activeTab";
const CHILD_KEY = "familyhub.activeChild";
const TABS = ["home", "calendar", "money", "anya", "docs"];
const MONEY_URL = "https://weiliang93-stack.github.io/willow/money/";
const HOUSEHOLD_SHEET_URL = "https://docs.google.com/spreadsheets/d/13JBXgENPoin92lAHq7BAHTcvV2YMqEY9a-_wtywoLY0/edit";
const TEOLOH_SHEET_URL = "https://docs.google.com/spreadsheets/d/1JboHp21d8kCjBpLLxrCV0Q1Ok5hgbrSLYlxK3yb4tkY/edit";
const CALENDAR_URL = "https://calendar.google.com";
const MEMBER_COLOR = { wl: "#3f6b4f", zl: "#2c3b4d", anya: "#d2652e" };
const BAR_COLORS = ["#6e8f78", "#d07a56", "#6d88a8", "#d2a24e", "#7f9a72", "#b9837a", "#8b7eaa"];
const DOC_ORDER = ["d-car", "d-insurance", "d-home", "d-archive", "d-archive-sheet"];

const ui = { tab: "home", child: "anya", homeDay: null, calWeek: null, calDay: null, showCancelled: false };
let state = null;
let currentUser = null;
let editsPaused = false;
let seededThisSession = false;
let saveChain = Promise.resolve();
let moneyStatus = "loading";
let expensesState = null;
let autoState = null;
let familyEvents = [];
let familyStatus = "loading";
let familyFrom = "";
let familyLoadingFrom = "";
let toastTimer = 0;

const editor = { mode: "", id: "", listId: "" };

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function uid() {
  return `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function clone(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function flash(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 4600);
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

function persistLocal() {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
  } catch (err) {
    /* private mode can refuse storage; the cloud copy still matters */
  }
}

function normalize(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  if (!s.version) s.version = 1;
  if (!s.family || typeof s.family !== "object") s.family = clone(SEED.family);
  if (!Array.isArray(s.family.members)) s.family.members = clone(SEED.family.members);
  for (const key of ["trips", "keyDates", "recurring", "lists", "docs"]) {
    if (!Array.isArray(s[key])) s[key] = [];
  }
  if (!s.anya || typeof s.anya !== "object") s.anya = {};
  if (!s.anya.born) s.anya.born = SEED.anya.born;
  if (!s.anya.sleep || typeof s.anya.sleep !== "object") s.anya.sleep = clone(SEED.anya.sleep);
  if (!Array.isArray(s.anya.milestones)) s.anya.milestones = [];
  if (!Array.isArray(s.anya.vaccines)) s.anya.vaccines = [];
  if (typeof s.anya.notes !== "string") s.anya.notes = "";
  if (!s.baby2 || typeof s.baby2 !== "object") s.baby2 = { due: SEED.baby2.due, prep: [] };
  if (!s.baby2.due) s.baby2.due = SEED.baby2.due;
  if (!Array.isArray(s.baby2.prep)) s.baby2.prep = [];
  L.normalizeKids(s);
  return s;
}

function activeChildId() {
  const kids = (state && state.kids) || [];
  if (kids.some((kid) => kid.id === ui.child)) return ui.child;
  return kids[0] ? kids[0].id : "anya";
}

function kidOf(draft, id) {
  const kids = (draft && draft.kids) || [];
  return kids.find((kid) => kid && kid.id === (id || activeChildId())) || null;
}

function writeKid(draft, fn) {
  const kid = kidOf(draft);
  if (!kid) return null;
  fn(kid);
  if (kid.id === "anya" && draft.anya) {
    if (kid.bornDate) draft.anya.born = kid.bornDate;
    draft.anya.sleep = kid.sleep;
    draft.anya.milestones = kid.milestones;
    draft.anya.vaccines = kid.vaccines;
    draft.anya.notes = kid.notes || "";
  }
  return kid;
}

function today() {
  return L.sgToday(new Date());
}

function readAccessToken() {
  try {
    const key = Object.keys(localStorage).find((name) => name.startsWith("sb-") && name.endsWith("-auth-token"));
    if (!key) return "";
    const parsed = JSON.parse(localStorage.getItem(key) || "null");
    return (parsed && (parsed.access_token || (parsed.currentSession && parsed.currentSession.access_token))) || "";
  } catch (err) {
    return "";
  }
}

// A failed pullState looks the same as "no row". Confirm with a read
// before writing the seed, so a blip cannot replace a real hub.
async function confirmNoFamilyHubRow() {
  const token = readAccessToken();
  if (!token || typeof SUPABASE_URL !== "string" || typeof SUPABASE_ANON_KEY !== "string") return false;
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/app_state?app=eq.familyhub&select=app`, {
      method: "GET",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) return false;
    const rows = await response.json();
    return Array.isArray(rows) && rows.length === 0;
  } catch (err) {
    return false;
  }
}

function revealApp() {
  const brand = document.getElementById("gateBrand");
  if (brand) brand.hidden = true;
  const app = document.getElementById("app-content");
  app.hidden = false;
  app.style.display = "";
}

async function boot(user) {
  currentUser = user || null;
  revealApp();
  const saved = localStorage.getItem(TAB_KEY);
  if (TABS.includes(saved)) ui.tab = saved;
  const savedChild = localStorage.getItem(CHILD_KEY);
  if (savedChild) ui.child = savedChild;
  ui.calWeek = L.weekStart(today());

  if (!window.SupaSync || !SupaSync.configured || !user) {
    state = normalize(loadLocal() || clone(SEED));
    editsPaused = false;
    moneyStatus = "signed-out";
    familyStatus = "signed-out";
    familyFrom = today();
    persistLocal();
    render();
    return;
  }

  const remote = await SupaSync.pullState("familyhub");
  if (remote && remote.state) {
    state = normalize(remote.state);
    editsPaused = false;
    persistLocal();
  } else if (loadLocal()) {
    state = normalize(loadLocal());
    editsPaused = true;
    flash("Couldn't refresh the hub. Showing the last copy on this phone. Edits are paused until a reload succeeds.");
  } else if (await confirmNoFamilyHubRow()) {
    state = normalize(clone(SEED));
    const ok = await SupaSync.pushStateNow("familyhub", state);
    seededThisSession = Boolean(ok);
    editsPaused = !ok;
    if (ok) persistLocal();
    else flash("Couldn't save the starting list yet. Edits are paused.");
  } else {
    state = normalize(clone(SEED));
    editsPaused = true;
    flash("Couldn't read the hub, so nothing was saved. Reload to try again.");
  }
  render();
  loadMoney();
  loadFamily(today());
}

async function loadMoney() {
  if (!window.SupaSync || !SupaSync.configured || !currentUser) {
    moneyStatus = "signed-out";
    expensesState = null;
    autoState = null;
    render();
    return;
  }
  moneyStatus = "loading";
  render();
  const [expensesRemote, autoRemote] = await Promise.all([
    SupaSync.pullState("expenses"),
    SupaSync.pullState("expenses_automation"),
  ]);
  if (!expensesRemote && !autoRemote) {
    moneyStatus = "unavailable";
    expensesState = null;
    autoState = null;
  } else {
    expensesState = expensesRemote && expensesRemote.state ? expensesRemote.state : null;
    autoState = autoRemote && autoRemote.state ? autoRemote.state : null;
    moneyStatus = "ready";
  }
  render();
}

function commit(mutator) {
  saveChain = saveChain
    .then(() => commitNow(mutator))
    .catch((err) => {
      console.error(err);
      flash("Couldn't save that change.");
    });
  return saveChain;
}

async function commitNow(mutator) {
  if (!state) return;
  if (editsPaused) {
    flash("Edits are paused until the hub can be read from the cloud.");
    render();
    return;
  }
  if (!window.SupaSync || !SupaSync.configured || !currentUser) {
    mutator(state);
    state = normalize(state);
    persistLocal();
    render();
    return;
  }
  const remote = await SupaSync.pullState("familyhub");
  if ((!remote || !remote.state) && !seededThisSession) {
    flash("Couldn't read the latest copy, so this change was not saved.");
    render();
    return;
  }
  const next = normalize(remote && remote.state ? clone(remote.state) : clone(state));
  mutator(next);
  const ok = await SupaSync.pushStateNow("familyhub", next);
  if (!ok) {
    flash("Couldn't save. Check your connection and try again.");
    render();
    return;
  }
  state = normalize(next);
  persistLocal();
  render();
}

function sectionHead(title, aside, extra) {
  return `<div class="section-head"><h2>${esc(title)}</h2><div class="section-actions">${aside || ""}${extra || ""}</div></div>`;
}

function plusButton(action, extra) {
  return `<button type="button" class="plus" data-add="${esc(action)}" ${extra || ""} aria-label="Add">+</button>`;
}

function pencilButton(mode, id, extra) {
  return `<button type="button" class="icon-hit" data-edit="${esc(mode)}" data-id="${esc(id)}" ${extra || ""} aria-label="Edit">${pencilSvg()}</button>`;
}

function pencilSvg() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l11-11-4-4L4 16v4Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
}

function dotColor(kind) {
  const colors = {
    routine: "#e0a15a",
    family: "#6d88a8",
    clinic: "#7f8cc4",
    birthday: "#e0a15a",
    trip: "#6e9a78",
    home: "#d2a24e",
    bill: "#d07a56",
    renewal: "#6e9a78",
    subscription: "#6d88a8",
    family: "#b9837a",
    task: "#8a8178",
    professional: "#2c3b4d",
    document: "#8a8178",
    car: "#d07a56",
  };
  return colors[kind] || "#c4b8a8";
}

function weekStrip(start, selected) {
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const iso = L.addDays(start, i);
    const dt = L.parseISO(iso);
    const label = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i];
    const dots = [];
    const seen = new Set();
    for (const event of L.eventsOn(state, iso, familyEvents)) {
      const color = dotColor(event.kind);
      if (seen.has(color)) continue;
      seen.add(color);
      dots.push(`<i style="background:${color}"></i>`);
      if (dots.length === 3) break;
    }
    days.push(`
      <button type="button" class="day${iso === selected ? " is-selected" : ""}" data-day="${iso}" aria-pressed="${iso === selected}">
        <span class="day-wd">${label}</span>
        <span class="day-num">${dt.getUTCDate()}</span>
        <span class="dots">${dots.join("")}</span>
      </button>`);
  }
  return `<div class="week" role="group" aria-label="Week">${days.join("")}</div>`;
}

function whenBlock(iso, day) {
  const dt = L.parseISO(iso);
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getUTCDay()];
  if (iso === day) return `<span class="when"><b>Today</b><small>${wd}</small></span>`;
  return `<span class="when"><b>${wd}</b><small>${dt.getUTCDate()}</small></span>`;
}

function pillFor(event, day) {
  if (event.kind === "family") return ["family", "Family"];
  if (event.kind === "routine") return ["today", event.date === day ? "Today" : "Drop-off"];
  if (event.kind === "clinic") return ["clinic", "Clinic"];
  if (event.kind === "birthday") return ["birthday", "Birthday"];
  if (event.kind === "trip") return ["trip", "Trip"];
  if (event.kind === "home") return ["home", "Home"];
  if (event.kind === "bill" || event.kind === "renewal" || event.kind === "subscription") return ["bill", "Due"];
  return ["note", "Note"];
}

function agendaCard(events, day) {
  if (!events.length) return '<div class="card empty-card">Nothing scheduled.</div>';
  return `<div class="card list-card">${events
    .map((event) => {
      const [pillClass, pillLabel] = pillFor(event, day);
      return `<div class="agenda-row">
        ${whenBlock(event.date, day)}
        <span class="agenda-copy"><b>${esc(event.title)}</b>${event.subtitle ? `<small>${esc(event.subtitle)}</small>` : ""}</span>
        <span class="pill ${pillClass}">${esc(pillLabel)}</span>
      </div>`;
    })
    .join("")}</div>`;
}

function checkRows(items, kind, listId) {
  if (!items.length) return `<p class="empty-line">${kind === "kidprep" ? "No prep items yet." : "Nothing here yet."}</p>`;
  return items
    .map((item) => {
      const extra = listId ? `data-list="${esc(listId)}"` : "";
      return `<div class="check-row${item.done ? " is-done" : ""}">
        <input type="checkbox" data-check="${esc(kind)}" data-id="${esc(item.id)}" ${extra} ${item.done ? "checked" : ""} aria-label="${esc(item.text)}">
        <span>${esc(item.text)}</span>
        ${pencilButton(kind === "prep" || kind === "kidprep" || kind === "milestone" ? kind : "list", item.id, extra)}
      </div>`;
    })
    .join("");
}

function inlineAdd(kind, listId, placeholder) {
  const extra = listId ? `data-list="${esc(listId)}"` : "";
  return `<form class="inline-add" data-inline="${esc(kind)}" ${extra}>
    <input name="text" type="text" maxlength="140" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}">
    <button type="submit">Add</button>
  </form>`;
}

function membersHtml() {
  return `<div class="pills">${(state.family.members || [])
    .map((member) => {
      const color = MEMBER_COLOR[member.id] || "#6f675f";
      return `<span class="person" style="background:${color}" title="${esc(member.name)}">${esc(member.short || member.name.slice(0, 1))}</span>`;
    })
    .join("")}</div>`;
}

function moneyLine(label, amount) {
  if (amount === null || amount === undefined) return "";
  return `<p class="aside-line"><span>${esc(label)}</span><b>${esc(L.formatMoney(amount))}</b></p>`;
}

function condoHtml(day) {
  const view = L.homeCondoView(state.home, day);
  if (!view) {
    return `<section class="card budget-card"><h2>Condo (MCST)</h2><p class="empty-copy">Condo details not loaded yet.</p><p class="empty-copy">No warranties loaded yet.</p><p class="empty-copy">No home facts loaded yet.</p></section>`;
  }
  const period = view.currentPeriod && view.currentPeriod.start ? `${L.formatDayMonth(view.currentPeriod.start)} – ${view.currentPeriod.end ? L.formatDayMonth(view.currentPeriod.end) : ""}` : "";
  const warranties = !view.warrantiesLoaded
    ? `<p class="empty-copy">No warranties loaded yet.</p>`
    : view.warranties.length
      ? view.warranties.map((item) => `<div class="check-row"><span><b>${esc(item.item)}</b><small class="aside">${item.until ? `Until ${esc(L.formatDayMonthYear(item.until))}` : esc(item.note)}</small></span></div>`).join("")
      : `<p class="empty-copy">No active warranties.</p>`;
  const facts = !view.factsLoaded
    ? `<p class="empty-copy">No home facts loaded yet.</p>`
    : view.facts.length
      ? view.facts.map((fact) => `<p class="aside-line"><span>${esc(fact.label)}</span><b>${esc(fact.value)}</b></p>`).join("")
      : `<p class="empty-copy">No home facts loaded yet.</p>`;
  return `<section class="card budget-card">
    <h2>Condo (MCST)</h2>
    ${view.hasMcst ? "" : `<p class="empty-copy">Condo details not loaded yet.</p>`}
    ${view.agent ? `<p class="lede">${esc(view.agent)}</p>` : ""}
    ${view.mcstNo ? `<p class="aside-line"><span>MCST</span><b>${esc(view.mcstNo)}</b></p>` : ""}
    ${moneyLine("Quarterly total", view.quarterlyTotal)}
    ${moneyLine("Management", view.breakdown.management)}
    ${moneyLine("Sinking fund", view.breakdown.sinking)}
    ${moneyLine("GST", view.breakdown.gst)}
    ${period ? `<p class="lede">This period ${esc(period)}</p>` : ""}
    ${view.nextDue ? `<p class="lede">Next due ${esc(L.formatDayMonthYear(view.nextDue))}</p>` : ""}
    ${view.folderUrl ? sheetLink(view.folderUrl, "Open folder") : ""}
    <h3 class="subhead">Warranties</h3>
    ${warranties}
    <h3 class="subhead">Facts</h3>
    ${facts}
  </section>`;
}

function carHtml(day) {
  const view = L.carView(state.car, day);
  if (!view) return `<section class="card budget-card"><h2>Car</h2><p class="empty-copy">Car details not loaded yet.</p></section>`;
  const flag = view.roadTaxCheck || view.insuranceCheck ? `<p class="flag">Renewal not on file — check</p>` : "";
  return `<section class="card budget-card">
    <h2>Car</h2>
    <p class="lede">${esc(view.model)}</p>
    ${view.registered ? `<p class="aside-line"><span>Registered</span><b>${esc(view.registered)}</b></p>` : ""}
    ${view.owner ? `<p class="aside-line"><span>Owner</span><b>${esc(view.owner)}</b></p>` : ""}
    ${view.coeExpiry ? `<p class="aside-line"><span>COE expires</span><b>${esc(L.formatDayMonthYear(view.coeExpiry))}</b></p>` : ""}
    ${view.loan ? `<p class="aside-line"><span>${esc(view.loan.lender || "Loan")}</span><b>${view.loan.monthly === null ? "" : esc(L.formatMoney(view.loan.monthly))}</b></p>${view.loan.method ? `<p class="lede">${esc(view.loan.method)}</p>` : ""}` : ""}
    ${view.roadTax ? `<p class="aside-line"><span>Road tax</span><b>${view.roadTax.amount === null ? "" : esc(L.formatMoney(view.roadTax.amount))}</b></p><p class="lede">${view.roadTax.start ? esc(L.formatDayMonth(view.roadTax.start)) : ""} – ${view.roadTax.end ? esc(L.formatDayMonthYear(view.roadTax.end)) : ""}</p>` : ""}
    ${view.insurance ? `<p class="aside-line"><span>${esc(view.insurance.insurer || "Insurance")}</span><b>${view.insurance.premium === null ? "" : esc(L.formatMoney(view.insurance.premium))}</b></p><p class="lede">${view.insurance.ncd ? `NCD ${esc(view.insurance.ncd)} · ` : ""}${view.insurance.end ? `until ${esc(L.formatDayMonthYear(view.insurance.end))}` : ""}</p>` : ""}
    ${flag}
    ${view.folderUrl ? `<p>${sheetLink(view.folderUrl, "Open folder")}</p>` : ""}
  </section>`;
}

function childcareHtml(day, kid) {
  const source = (kid && kid.childcare) || (kid && kid.id === "anya" ? state.childcare : null);
  const view = L.childcareView(source, day);
  if (!view) return `<section class="card budget-card"><h2>Childcare</h2><p class="empty-copy">Childcare details not loaded yet.</p></section>`;
  return `<section class="card budget-card">
    <h2>Childcare</h2>
    <p class="lede">${esc(view.centre)}${view.className ? ` · ${esc(view.className)}` : ""}</p>
    ${moneyLine("Monthly fee", view.monthlyFee)}
    <h3 class="subhead">Upcoming closures</h3>
    ${view.closures.length ? view.closures.map((item) => `<p class="aside-line"><span>${esc(L.formatDayMonthYear(item.date))}</span><b>${esc(item.reason)}</b></p>`).join("") : `<p class="empty-copy">No upcoming closures.</p>`}
    ${view.folderUrl ? `<p>${sheetLink(view.folderUrl, "Open folder")}</p>` : ""}
  </section>`;
}

function netWorthHtml() {
  const view = L.netWorthView(state.netWorth);
  if (!view) return `<section class="card budget-card"><h2>Household net worth</h2><p class="empty-copy">Net worth not loaded yet.</p></section>`;
  return `<section class="card budget-card">
    <div class="section-head"><h2>Household net worth</h2>${view.sourceUrl ? sheetLink(view.sourceUrl, "Open Household Ledger Data") : ""}</div>
    ${view.asOf ? `<p class="lede">As of ${esc(L.formatDayMonthYear(view.asOf))}</p>` : ""}
    ${view.total === null ? "" : `<div class="figure">${esc(L.formatMoney(view.total))}</div>`}
    ${view.byPerson.map((person) => moneyLine(person.name, person.amount)).join("")}
  </section>`;
}

function docLinksHtml() {
  const groups = L.docLinkGroups(state.docLinks);
  if (!groups.length) return `${sectionHead("Folder links", "")}<div class="card empty-card">No extra folder links yet.</div>`;
  return `${sectionHead("Folder links", "")}<div class="card list-card">${groups
    .map(
      (group) => `<h3 class="subhead">${esc(group.group)}</h3>${group.links
        .map((link) => link.url ? `<a class="date-row" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer"><span class="date-title">${esc(link.label)}</span></a>` : `<div class="date-row"><span class="date-title">${esc(link.label)}</span></div>`)
        .join("")}`
    )
    .join("")}</div>`;
}

function renderHome(day) {
  const week = L.weekStart(day);
  const selected = ui.homeDay || day;
  const events = ui.homeDay ? L.eventsOn(state, ui.homeDay, familyEvents) : L.homeAgenda(state, day, familyEvents);
  const hero = L.tripHero(L.featuredTrip(state, day), day);
  const dates = L.upcomingKeyDates(state, day, 6);
  const list = L.shoppingList(state);
  const heroHtml = hero
    ? `<section class="hero hero-trip">
        <div class="hero-top"><p class="hero-kicker">${esc(hero.kicker)}</p>
          <div class="count-badge"><b>${esc(hero.badge)}</b><span>${esc(hero.badgeLabel)}</span></div>
        </div>
        <h2>${esc(hero.headline)}</h2>
        <p>${esc(hero.range)}</p>
      </section>`
    : "";
  const datesHtml = dates.length
    ? `<div class="card list-card">${dates
        .map(
          (item) => dateButton(item, false)
        )
        .join("")}</div>`
    : '<div class="card empty-card">No other dates in the next few months.</div>';
  const listHtml = list
    ? `<div class="card list-card">${checkRows(list.items || [], "list", list.id)}${inlineAdd("list", list.id, "Add to the list")}</div>`
    : '<div class="card empty-card">No list yet.</div>';
  const filterNote = ui.homeDay
    ? `<button type="button" class="text-btn" data-action="clear-home">Full week</button>`
    : `<span class="aside">${esc(L.formatWeekSpan(week))}</span>`;
  return `
    <header class="top">
      <p class="kicker">Loh Family Hub</p>
      <div class="title-row"><h1>This week</h1>${membersHtml()}</div>
    </header>
    ${heroHtml}
    ${weekStrip(week, selected)}
    ${familyNote()}
    ${sectionHead(ui.homeDay ? L.formatWeekdayDayMonth(ui.homeDay) : "Today & coming up", filterNote)}
    ${agendaCard(events, day)}
    ${sectionHead("Key dates", '<span class="aside">Upcoming</span>', plusButton("keyDate"))}
    ${datesHtml}
    ${sectionHead("Shopping list", list && list.shared ? '<span class="aside">Shared</span>' : "")}
    ${listHtml}
    ${condoHtml(day)}`;
}

function renderCalendar(day) {
  const start = ui.calWeek || L.weekStart(day);
  const weekEndForFetch = L.addDays(start, 6);
  if (!familyWindowCovers(familyFrom, start, weekEndForFetch)) loadFamily(start);
  const selected = ui.calDay;
  const events = [];
  for (let i = 0; i < 7; i += 1) {
    const iso = L.addDays(start, i);
    if (selected && iso !== selected) continue;
    events.push(...L.eventsOn(state, iso, familyEvents));
  }
  const weekEnd = L.addDays(start, 6);
  const later = L.remindersAfter(state, weekEnd);
  const soon = later.filter((item) => L.diffDays(day, item.date) <= 400).slice(0, 8);
  const far = later.filter((item) => !soon.includes(item));
  const dateCard = (items) =>
    items.length
      ? `<div class="card list-card">${items
          .map(
            (item) => dateButton(item, true)
          )
          .join("")}</div>`
      : "";
  return `
    <header class="top">
      <p class="kicker">Loh Family Hub</p>
      <div class="title-row"><h1>Calendar</h1></div>
    </header>
    <div class="week-nav">
      <button type="button" class="nav-arrow" data-week="-1" aria-label="Previous week">‹</button>
      <button type="button" class="text-btn" data-week="0">${esc(L.formatWeekSpan(start))}</button>
      <button type="button" class="nav-arrow" data-week="1" aria-label="Next week">›</button>
    </div>
    ${weekStrip(start, selected || (day >= start && day <= weekEnd ? day : ""))}
    <a class="calendar-link" href="${CALENDAR_URL}" target="_blank" rel="noopener noreferrer">Open Google Calendar</a>
    ${familyNote()}
    ${sectionHead(selected ? L.formatWeekdayDayMonth(selected) : "This week", selected ? '<button type="button" class="text-btn" data-action="clear-cal">Whole week</button>' : "")}
    ${agendaCard(events, day)}
    ${sectionHead("Key dates", "", plusButton("keyDate"))}
    ${dateCard(soon) || '<div class="card empty-card">Nothing further in the next year.</div>'}
    ${far.length ? `${sectionHead("Further ahead", "")}${dateCard(far)}` : ""}`;
}

function familyWindowCovers(from, start, end) {
  if (!from) return false;
  return start >= from && end <= L.addDays(from, 13);
}

function familyNote() {
  if (familyStatus === "ready") return "";
  const text =
    familyStatus === "loading"
      ? "Checking the Family calendar…"
      : familyStatus === "unavailable"
        ? "Couldn't reach the Family calendar."
        : "Family calendar not connected yet.";
  return `<p class="family-note">${esc(text)}</p>`;
}

async function loadFamily(from) {
  if (!from) return;
  if (familyLoadingFrom === from) return;
  if (familyFrom === from && (familyStatus === "ready" || familyStatus === "disconnected" || familyStatus === "signed-out")) return;
  familyLoadingFrom = from;
  if (!window.SupaSync || !SupaSync.configured || !currentUser) {
    familyStatus = "signed-out";
    familyEvents = [];
    familyFrom = from;
    familyLoadingFrom = "";
    render();
    return;
  }
  familyStatus = "loading";
  const result = await SupaSync.invokeFunction("family-calendar", { from });
  if (familyLoadingFrom !== from && familyFrom && familyFrom !== from) return;
  const data = result && result.ok ? result.data : null;
  if (!result || !result.ok) {
    familyStatus = "unavailable";
    familyEvents = [];
  } else if (!data || data.connected === false) {
    familyStatus = "disconnected";
    familyEvents = [];
  } else {
    familyStatus = "ready";
    familyEvents = Array.isArray(data.events) ? data.events : [];
  }
  familyFrom = from;
  familyLoadingFrom = "";
  render();
}

function sheetLink(href, label) {
  return `<a class="text-btn" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
}

function dateButton(item, long) {
  const when = long ? L.formatDayMonthYear(item.date) : L.formatDayMonth(item.date);
  const inner = `<i class="dot" style="background:${dotColor(item.kind)}"></i>
    <span class="date-title">${esc(item.title)}${item.subtitle ? `<small>${esc(item.subtitle)}</small>` : ""}</span>
    <span class="date-when">${esc(when)}</span>`;
  if (item.source === "snapshot") return `<div class="date-row">${inner}</div>`;
  const mode = item.source === "insurance" ? "insurance" : "keyDate";
  return `<button type="button" class="date-row" data-edit="${mode}" data-id="${esc(item.id)}">${inner}</button>`;
}

function moneyMessage() {
  if (moneyStatus === "loading") return "Loading the household expense log…";
  if (moneyStatus === "signed-out") return "Sign in to load the household expense log. Nothing here is estimated.";
  return "Couldn't read the household expense log just now. Nothing here is estimated.";
}

function fixedCostsHtml() {
  const view = L.fixedCostView(state.fixedCosts);
  const link = sheetLink(TEOLOH_SHEET_URL, "Open TeoLoh Financial Planning");
  if (!view) {
    return `<section class="card budget-card">
      <div class="section-head"><h2>Fixed monthly costs</h2>${link}</div>
      <p class="empty-copy">Fixed costs not loaded yet.</p>
    </section>`;
  }
  const lines = [
    view.monthlyContribution === null ? "" : `<p class="aside-line"><span>Monthly contribution</span><b>${esc(L.formatMoney(view.monthlyContribution))}</b></p>`,
    view.householdFixedCosts === null ? "" : `<p class="aside-line"><span>Household fixed costs</span><b>${esc(L.formatMoney(view.householdFixedCosts))}</b></p>`,
    ...view.allocations.map((row) => `<p class="aside-line"><span>${esc(row.name)}</span><b>${esc(L.formatMoney(row.amount))}</b></p>`),
  ].join("");
  const synced = view.asOf ? `Synced from sheet ${L.formatDayMonthYear(view.asOf)}` : "Synced from sheet";
  return `<section class="card budget-card">
    <div class="section-head"><h2>Fixed monthly costs</h2>${link}</div>
    <p class="lede">${esc(synced)}</p>
    <div class="list-card">${view.items
      .map(
        (item) => `<div class="check-row">
          <span><b>${esc(item.name)}</b>${item.note ? `<small class="aside">${esc(item.note)}</small>` : ""}</span>
          <b>${item.amount === null ? "" : esc(L.formatMoney(item.amount))}</b>
        </div>`
      )
      .join("")}</div>
    <p class="track-meta">Total ${esc(L.formatMoney(view.total))}</p>
    ${lines}
  </section>`;
}

function insuranceHtml(day) {
  const view = L.insuranceView(state.insurance, day, ui.showCancelled);
  const link = sheetLink(TEOLOH_SHEET_URL, "Open TeoLoh Financial Planning");
  if (!view) {
    return `<section class="card budget-card">
      <div class="section-head"><h2>Insurance</h2>${link}</div>
      <p class="empty-copy">Insurance not loaded yet.</p>
      <button type="button" class="text-btn" data-add="insurance">Add a cover</button>
    </section>`;
  }
  const renewals = view.renewals.length
    ? `<h3 class="subhead">Renewals in next 60 days</h3><div class="list-card">${view.renewals
        .map(
          (item) => `<button type="button" class="date-row" data-edit="insurance" data-id="${esc(item.id)}">
            <i class="dot" style="background:${dotColor("renewal")}"></i>
            <span class="date-title">${esc(item.title)}<small>${esc(item.subtitle)}</small></span>
            <span class="date-when">${esc(L.formatDayMonth(item.date))}</span>
          </button>`
        )
        .join("")}</div>`
    : `<p class="empty-copy">No renewals in the next 60 days.</p>`;
  const groups = view.groups
    .map(
      (group) => `<h3 class="subhead">${esc(group.person)}</h3><div class="list-card">${group.policies
        .map((policy) => {
          const meta = [policy.category, policy.frequency, policy.payment].filter(Boolean).join(" · ");
          const premium = policy.premium === null ? "" : L.formatMoney(policy.premium);
          return `<div class="check-row${policy.status === "cancelled" ? " is-done" : ""}">
            <span><b>${esc(policy.name)}</b><small class="aside">${esc(meta)}${policy.cover ? ` · ${esc(policy.cover)}` : ""}</small></span>
            <b>${esc(premium)}</b>
            ${pencilButton("insurance", policy.id)}
          </div>`;
        })
        .join("")}</div>`
    )
    .join("");
  return `<section class="card budget-card">
    <div class="section-head"><h2>Insurance</h2>${link}</div>
    <p class="lede">${view.asOf ? `As of ${esc(L.formatDayMonthYear(view.asOf))}` : "No as-of date"}</p>
    ${view.cancelledCount ? `<button type="button" class="text-btn" data-action="toggle-cancelled">${ui.showCancelled ? "Hide cancelled" : "Show cancelled"}</button>` : ""}
    ${renewals}
    ${groups}
    <button type="button" class="text-btn" data-add="insurance">Add a cover</button>
  </section>`;
}

function renderMoney(day) {
  const summary = moneyStatus === "ready" ? L.summarizeMoney(expensesState, autoState, day, state) : null;
  const bills = (summary || L.summarizeMoney({ monthlyBudget: null, expenses: [] }, { excludedExpenses: [] }, day, state)).bills;
  let budgetHtml;
  if (!summary || !summary.foundAutomation) {
    budgetHtml = `<section class="card budget-card"><div class="section-head"><h2>Variable household spend</h2>${sheetLink(HOUSEHOLD_SHEET_URL, "Open Household Expenses sheet")}</div><p class="lede">${esc(L.monthTitle(day))} · trip spend kept separate</p><p class="empty-copy">${esc(moneyMessage())}</p></section>`;
  } else if (summary.budget === null) {
    budgetHtml = `<section class="card budget-card">
      <div class="section-head"><h2>Variable household spend</h2>${sheetLink(HOUSEHOLD_SHEET_URL, "Open Household Expenses sheet")}</div>
      <p class="lede">${esc(summary.monthTitle)} · trip spend kept separate</p>
      <div class="figure">${esc(L.formatMoney(summary.spent))}</div>
      <p class="empty-copy">No combined budget is set. Spent ${esc(L.formatMoney(summary.spent))} of combined expenses so far this month.</p>
    </section>`;
  } else {
    const pct = summary.budget > 0 ? Math.min(100, (summary.spent / summary.budget) * 100) : 0;
    const tone = summary.spent >= summary.budget ? "over" : summary.spent >= summary.budget * 0.7 ? "warn" : "";
    const left = summary.remaining >= 0 ? `${L.formatMoney(summary.remaining)} left` : `${L.formatMoney(Math.abs(summary.remaining))} over`;
    budgetHtml = `<section class="card budget-card">
      <div class="section-head"><h2>Variable household spend</h2>${sheetLink(HOUSEHOLD_SHEET_URL, "Open Household Expenses sheet")}</div>
      <p class="lede">${esc(summary.monthTitle)} · trip spend kept separate</p>
      <div class="figure">${esc(L.formatMoney(summary.spent))}</div>
      <p class="figure-sub">spent of ${esc(L.formatMoney(summary.budget))}</p>
      <div class="track"><span class="${tone}" style="width:${pct}%"></span></div>
      <p class="track-meta">${esc(left)}</p>
    </section>`;
  }

  let bars = "";
  if (summary && summary.foundAutomation) {
    bars = summary.categories.length
      ? `<div class="card bars">${summary.categories
          .map((row, index) => {
            const color = BAR_COLORS[index % BAR_COLORS.length];
            return `<div class="bar-row">
              <div class="bar-top"><span>${esc(row.name)}</span><b>${esc(L.formatMoney(row.amount))}</b></div>
              <div class="track slim"><span style="width:${Math.max(4, row.width * 100)}%;background:${color}"></span></div>
            </div>`;
          })
          .join("")}</div>`
      : '<div class="card empty-card">No combined expenses logged this month yet.</div>';
  }

  let tripHtml = "";
  if (!summary || (!summary.foundAutomation && summary.trip.count === 0)) {
    tripHtml = `<section class="hero hero-trip"><p class="hero-kicker">Trip spend</p><p class="hero-note">Trip-type rows show here once the household expense log loads. Nothing is estimated.</p></section>`;
  } else if (summary.trip.emptyMessage && !summary.foundAutomation) {
    tripHtml = `<section class="hero hero-trip"><p class="hero-kicker">${esc(summary.trip.title)}</p><p class="hero-note">Couldn't read trip rows, so nothing is shown for them.</p></section>`;
  } else if (summary.trip.emptyMessage) {
    tripHtml = `<section class="hero hero-trip"><p class="hero-kicker">${esc(summary.trip.title)}</p><h2>${esc(summary.trip.emptyMessage)}</h2><p>${esc(summary.trip.note)}</p></section>`;
  } else {
    const overlap = summary.trip.lines.filter((line) => line.inPersonalBudget).length;
    tripHtml = `<section class="hero hero-trip">
      <p class="hero-kicker">${esc(summary.trip.title)}</p>
      <h2>${esc(L.formatMoney(summary.trip.total))}</h2>
      <p>${esc(summary.trip.note)}</p>
      <ul class="trip-lines">${summary.trip.lines
        .map(
          (line) => `<li><span>${esc(L.formatDayMonth(line.date))} · ${esc(line.category)}</span><b>${esc(L.formatMoney(line.amount))}</b></li>`
        )
        .join("")}</ul>
      ${overlap ? `<p class="hero-note">${overlap} of these are still on the personal expenses list. They are not part of the household budget above.</p>` : ""}
    </section>`;
  }

  const others =
    summary && summary.otherTrips.length
      ? `<div class="card quiet-card"><h3>Other trip tags</h3><p>Also kept out of the monthly budget, and not included in the card above.</p><ul class="plain">${summary.otherTrips
          .map((row) => `<li><span>${esc(row.label)}</span><b>${esc(L.formatMoney(row.total))}</b></li>`)
          .join("")}</ul></div>`
      : "";

  const billHtml = `<div class="card list-card">${
    bills.length
      ? bills
          .map((bill) => {
            const amount = bill.charge ? `<b>${esc(L.formatMoney(bill.charge.amount))}</b>` : "";
            const when = bill.date ? L.formatDayMonth(bill.date) : bill.note || "Monthly";
            const seen = bill.charge && bill.charge.date ? `<small>Last charged ${esc(L.formatDayMonth(bill.charge.date))}</small>` : "";
            const editable = (state.keyDates || []).some((row) => row.id === bill.id);
            const tag = editable ? "button" : "div";
            const attrs = editable ? `type="button" data-edit="keyDate" data-id="${esc(bill.id)}"` : "";
            return `<${tag} class="date-row bill-row" ${attrs}>
              <i class="dot" style="background:${dotColor(bill.kind)}"></i>
              <span class="date-title">${esc(bill.title)}${seen}</span>
              <span class="date-when">${amount}<small>${esc(when)}</small></span>
            </${tag}>`;
          })
          .join("")
      : '<p class="empty-line">No bills or renewals in the next ten weeks.</p>'
  }</div>`;

  return `
    <header class="top">
      <p class="kicker">Loh Family Hub</p>
      <div class="title-row"><h1>Money</h1>
        <button type="button" class="text-btn" data-action="refresh-money">Refresh</button>
      </div>
    </header>
    ${netWorthHtml()}
    ${budgetHtml}
    ${bars}
    ${fixedCostsHtml()}
    ${insuranceHtml(day)}
    ${tripHtml}
    ${others}
    ${sectionHead("Upcoming bills & renewals", "", plusButton("keyDate"))}
    ${billHtml}
    <p class="footnote">Figures synced from the household expense log. <a href="${MONEY_URL}">Edit variable spend in Money</a></p>`;
}

function kidSwitch() {
  const current = activeChildId();
  const kids = state.kids || [];
  return `<div class="kid-switch" role="tablist" aria-label="Child">${kids
    .map((kid) => {
      const on = kid.id === current;
      return `<button type="button" data-child="${esc(kid.id)}" role="tab" aria-selected="${on}" class="${on ? "is-on" : ""}">${esc(kid.name || kid.id)}</button>`;
    })
    .join("")}</div>`;
}

function bornChildHtml(day, kid) {
  const born = kid.bornDate;
  const age = L.ageParts(born, day);
  const birthday = L.nextBirthday(born, day);
  const showBanner = birthday.days <= 21;
  const weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][L.parseISO(birthday.date).getUTCDay()];
  const kicker = birthday.days === 0 ? "Today" : birthday.days <= 7 ? `Coming up ${weekday}` : "Coming up";
  const headline = birthday.days === 0 ? `${birthday.label} today` : `${birthday.label} in ${birthday.days} day${birthday.days === 1 ? "" : "s"}`;
  const banner = showBanner
    ? `<section class="hero hero-birthday">
        <p class="hero-kicker">${esc(kicker)}</p>
        <h2>${esc(headline)}</h2>
        <p>${esc(L.formatLong(birthday.date))}</p>
      </section>`
    : "";
  const sleep = kid.sleep || {};
  const vaccines = kid.vaccines || [];
  const letter = (kid.name || "?").slice(0, 1);
  return `
    ${kidSwitch()}
    <header class="top anya-top">
      <span class="avatar">${esc(letter)}</span>
      <div>
        <p class="kicker">Daughter</p>
        <h1>${esc(kid.name)}</h1>
        <p class="lede">Born ${esc(L.formatDayMonthYear(born))} · ${esc(age.label)}</p>
      </div>
    </header>
    ${banner}
    ${childcareHtml(day, kid)}
    ${sectionHead("Milestones", "", plusButton("milestone"))}
    <div class="card list-card">${checkRows(kid.milestones || [], "milestone")}${inlineAdd("milestone", "", "Add a milestone")}</div>
    <button type="button" class="note-card" data-edit="notes">${esc(kid.notes || "Add a note")}</button>
    ${sectionHead("Next vaccinations", '<span class="aside">Per NCIS schedule</span>', plusButton("vaccine"))}
    <div class="card list-card">${
      vaccines.length
        ? vaccines
            .map((item) => {
              const done = item.status === "done";
              return `<div class="vax-row${done ? " is-done" : ""}">
                <button type="button" class="vax-toggle" data-vax="${esc(item.id)}" aria-pressed="${done}" aria-label="${done ? "Mark due" : "Mark done"}">${done ? "✓" : syringeSvg()}</button>
                <span class="agenda-copy"><b>${esc(item.name)}</b>${item.notes ? `<small>${esc(item.notes)}</small>` : ""}</span>
                ${pencilButton("vaccine", item.id)}
              </div>`;
            })
            .join("")
        : '<p class="empty-line">No vaccinations listed.</p>'
    }</div>
    ${sectionHead("Sleep", '<span class="aside">Usual rhythm</span>', `<button type="button" class="text-btn" data-edit="sleep">Edit</button>`)}
    <div class="sleep-grid">
      <div class="sleep-tile naps"><span>Naps</span><b>${esc(sleep.napsPerDay ?? "—")} a day</b><small>${esc(sleep.napNote || "")}</small></div>
      <div class="sleep-tile bed"><span>Bedtime</span><b>${esc(L.formatBedtime(sleep.bedtime))}</b><small>${esc(sleep.bedtimeNote || "")}</small></div>
    </div>`;
}

function unbornChildHtml(day, kid) {
  const countdown = L.dueCountdown(kid.dueDate, day) || "Due date not set";
  const appointments = L.antenatalFor(state, kid, familyEvents);
  const letter = (kid.name || "?").slice(0, 1);
  const appointmentHtml = appointments.length
    ? appointments
        .map((item) => {
          const when = item.date ? L.formatDayMonthYear(item.date) : "";
          const where = item.where ? `<small>${esc(item.where)}</small>` : "";
          return `<div class="date-row"><span class="date-title">${esc(item.title)}${where}</span><span class="date-when">${esc(when)}</span></div>`;
        })
        .join("")
    : '<p class="empty-line">No antenatal appointments tagged to her yet.</p>';
  return `
    ${kidSwitch()}
    <header class="top anya-top">
      <span class="avatar">${esc(letter)}</span>
      <div>
        <p class="kicker">On the way</p>
        <h1>${esc(kid.name)}</h1>
        <p class="lede">${kid.dueDate ? `Due ${esc(L.formatDayMonthYear(kid.dueDate))}` : "Due date not set"}</p>
      </div>
    </header>
    <section class="hero hero-baby">
      <p class="hero-kicker">Due date</p>
      <h2>${esc(countdown)}</h2>
      <p>${kid.dueDate ? esc(L.formatLong(kid.dueDate)) : ""}</p>
    </section>
    ${sectionHead("Antenatal appointments", "")}
    <div class="card list-card">${appointmentHtml}</div>
    ${sectionHead("Baby prep", "", plusButton("kidprep"))}
    <div class="card list-card">${checkRows(kid.prep || [], "kidprep")}${inlineAdd("kidprep", "", "Add a prep item")}</div>
    <button type="button" class="text-btn" data-edit="born">Set birth date</button>`;
}

function renderKids(day) {
  const kid = kidOf(state);
  if (!kid) return `<header class="top"><h1>Kids</h1></header><p class="empty-copy">No children on file.</p>`;
  if (kid.bornDate) return bornChildHtml(day, kid);
  return unbornChildHtml(day, kid);
}

function syringeSvg() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5l5 5M7 12l5 5M9 10l5 5M5 15l4 4M16 4l4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
}

function docIcon(id) {
  if (id === "d-car") {
    return '<span class="doc-icon car"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 14h16l-1.2-4.2a2 2 0 0 0-1.9-1.4H7.1a2 2 0 0 0-1.9 1.4L4 14Z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="7.5" cy="16.5" r="1.3" fill="currentColor"/><circle cx="16.5" cy="16.5" r="1.3" fill="currentColor"/></svg></span>';
  }
  if (id === "d-insurance") {
    return '<span class="doc-icon insurance"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 19 6.5v5.2c0 4.2-2.8 7.2-7 8.8-4.2-1.6-7-4.6-7-8.8V6.5L12 3.5Z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg></span>';
  }
  if (id === "d-home") {
    return '<span class="doc-icon home"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11.2 12 4l8 7.2V20H4v-8.8Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></span>';
  }
  return '<span class="doc-icon archive"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16v4H4zM6 11v8h12v-8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></span>';
}

function renderDocs(day) {
  const pregnancy = L.pregnancy(state.baby2.due, day);
  const due = L.parseISO(state.baby2.due);
  const dueMonth = `${L.MONTHS_SHORT[due.getUTCMonth()]} ${due.getUTCFullYear()}`;
  let title = pregnancy.week < 1 ? "Before week 1" : `Week ${pregnancy.week}`;
  let sub = `Due ${L.formatDayMonthYear(state.baby2.due)}`;
  if (pregnancy.daysUntil < 0) {
    title = "Due date has passed";
    sub = `${Math.abs(pregnancy.daysUntil)} days past ${L.formatDayMonthYear(state.baby2.due)}`;
  } else if (pregnancy.extraDays) {
    sub += ` · ${pregnancy.weeksToGo} weeks ${pregnancy.extraDays} days to go`;
  } else {
    sub += ` · ${pregnancy.weeksToGo} weeks to go`;
  }
  const left = pregnancy.daysUntil < 0 ? "40 of 40 weeks" : `${Math.max(0, Math.min(40, pregnancy.week))} of 40 weeks`;
  const docs = (state.docs || []).slice().sort((a, b) => {
    const ai = DOC_ORDER.indexOf(a.id);
    const bi = DOC_ORDER.indexOf(b.id);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  const before = `Before ${L.MONTHS[due.getUTCMonth()]}`;
  return `
    <header class="top">
      <p class="kicker">Loh Family Hub</p>
      <div class="title-row"><h1>Baby #2 &amp; home</h1></div>
    </header>
    <section class="hero hero-baby">
      <p class="hero-kicker">Zhen Ling · ${esc(pregnancy.trimester)} trimester</p>
      <h2>${esc(title)}</h2>
      <p>${esc(sub)}</p>
      <div class="track light"><span style="width:${Math.round(pregnancy.progress * 100)}%"></span></div>
      <div class="hero-foot"><span>${esc(left)}</span><span>${esc(dueMonth)}</span></div>
    </section>
    ${carHtml(day)}
    ${sectionHead("Prep checklist", `<span class="aside">${esc(before)}</span>`)}
    <div class="card list-card">${checkRows(state.baby2.prep || [], "prep")}${inlineAdd("prep", "", "Add a prep item")}</div>
    ${sectionHead("Documents", '<span class="aside">Quick links</span>', plusButton("doc"))}
    <div class="doc-grid">${docs
      .map((doc) => {
        const href = L.safeUrl(doc.url);
        const inner = `${docIcon(doc.id)}<strong>${esc(doc.title)}</strong><span>${esc(doc.subtitle || (href ? "Open" : "Add a link"))}</span>`;
        const edit = pencilButton("doc", doc.id);
        if (!href) {
          return `<div class="doc-card">${inner}<button type="button" class="text-btn" data-edit="doc" data-id="${esc(doc.id)}">Add link</button></div>`;
        }
        return `<div class="doc-card"><a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>${edit}</div>`;
      })
      .join("")}</div>
    ${docLinksHtml()}`;
}

function render() {
  if (!state) return;
  if (state.kids && state.kids.length) ui.child = activeChildId();
  const day = today();
  const main = document.getElementById("main");
  const pages = { home: renderHome, calendar: renderCalendar, money: renderMoney, anya: renderKids, docs: renderDocs };
  const banner = editsPaused ? '<p class="banner">Edits are paused until the hub can be read. <button type="button" data-action="reload">Reload</button></p>' : "";
  main.innerHTML = banner + pages[ui.tab](day);
  document.querySelectorAll(".tabbar button").forEach((button) => {
    const on = button.dataset.tab === ui.tab;
    button.classList.toggle("is-on", on);
    if (on) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  try {
    localStorage.setItem(TAB_KEY, ui.tab);
    localStorage.setItem(CHILD_KEY, activeChildId());
  } catch (err) {
    /* ignore */
  }
}

function onClick(event) {
  const tab = event.target.closest(".tabbar button");
  if (tab && tab.dataset.tab) {
    ui.tab = tab.dataset.tab;
    render();
    return;
  }
  const root = event.target.closest("#main");
  if (!root) return;
  const childBtn = event.target.closest("[data-child]");
  if (childBtn && childBtn.dataset.child) {
    ui.child = childBtn.dataset.child;
    render();
    return;
  }
  const actionEl = event.target.closest("[data-action], [data-day], [data-week], [data-add], [data-edit], [data-vax]");
  if (!actionEl) return;
  if (actionEl.dataset.action === "reload") {
    location.reload();
    return;
  }
  if (actionEl.dataset.action === "refresh-money") {
    loadMoney();
    return;
  }
  if (actionEl.dataset.action === "toggle-cancelled") {
    ui.showCancelled = !ui.showCancelled;
    render();
    return;
  }
  if (actionEl.dataset.action === "clear-home") {
    ui.homeDay = null;
    render();
    return;
  }
  if (actionEl.dataset.action === "clear-cal") {
    ui.calDay = null;
    render();
    return;
  }
  if (actionEl.dataset.day) {
    if (ui.tab === "calendar") ui.calDay = ui.calDay === actionEl.dataset.day ? null : actionEl.dataset.day;
    else ui.homeDay = ui.homeDay === actionEl.dataset.day ? null : actionEl.dataset.day;
    render();
    return;
  }
  if (actionEl.dataset.week != null && actionEl.dataset.week !== "") {
    const step = Number(actionEl.dataset.week);
    const base = ui.calWeek || L.weekStart(today());
    ui.calWeek = step === 0 ? L.weekStart(today()) : L.addDays(base, step * 7);
    ui.calDay = null;
    render();
    return;
  }
  if (actionEl.dataset.vax) {
    const id = actionEl.dataset.vax;
    commit((draft) => {
      writeKid(draft, (kid) => {
        const item = (kid.vaccines || []).find((row) => row.id === id);
        if (item) item.status = item.status === "done" ? "due" : "done";
      });
    });
    return;
  }
  if (actionEl.dataset.add) {
    const mode = actionEl.dataset.add === "milestone" ? "milestone" : actionEl.dataset.add;
    if (mode === "fixedItem") return;
    if (mode === "milestone" || mode === "kidprep") {
      document.querySelector(`.inline-add[data-inline="${mode}"] input`)?.focus();
      return;
    }
    openEditor(mode, "", actionEl.dataset.list || "");
    return;
  }
  if (actionEl.dataset.edit) {
    openEditor(actionEl.dataset.edit, actionEl.dataset.id || "", actionEl.dataset.list || "");
  }
}

function onChange(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.dataset.check) return;
  const id = input.dataset.id;
  const listId = input.dataset.list;
  const done = input.checked;
  const kind = input.dataset.check;
  commit((draft) => {
    if (kind === "list") {
      const list = draft.lists.find((row) => row.id === listId);
      const item = list && (list.items || []).find((row) => row.id === id);
      if (item) item.done = done;
    } else if (kind === "milestone") {
      writeKid(draft, (kid) => {
        const item = (kid.milestones || []).find((row) => row.id === id);
        if (item) item.done = done;
      });
    } else if (kind === "prep") {
      const item = draft.baby2.prep.find((row) => row.id === id);
      if (item) item.done = done;
    } else if (kind === "kidprep") {
      writeKid(draft, (kid) => {
        const item = (kid.prep || []).find((row) => row.id === id);
        if (item) item.done = done;
      });
    }
  });
}

function onSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.dataset.inline) return;
  event.preventDefault();
  const input = form.querySelector("input");
  const text = input.value.trim();
  if (!text) return;
  const kind = form.dataset.inline;
  const listId = form.dataset.list;
  input.value = "";
  commit((draft) => {
    if (kind === "list") {
      const list = draft.lists.find((row) => row.id === listId);
      if (!list) return;
      list.items = list.items || [];
      list.items.push({ id: uid(), text, done: false });
    } else if (kind === "milestone") {
      writeKid(draft, (kid) => {
        kid.milestones = kid.milestones || [];
        kid.milestones.push({ id: uid(), text, done: false });
      });
    } else if (kind === "prep") {
      draft.baby2.prep.push({ id: uid(), text, done: false });
    } else if (kind === "kidprep") {
      writeKid(draft, (kid) => {
        kid.prep = kid.prep || [];
        kid.prep.push({ id: uid(), text, done: false });
      });
    }
  });
}

function field(name, type, label, value) {
  const wrap = document.createElement("label");
  wrap.className = "field";
  const span = document.createElement("span");
  span.textContent = label;
  const input = document.createElement("input");
  input.name = name;
  input.type = type;
  input.value = value == null ? "" : String(value);
  if (type === "number") {
    input.min = "0";
    input.step = name === "napsPerDay" ? "1" : "0.01";
    if (name === "napsPerDay") input.max = "8";
  }
  wrap.append(span, input);
  return wrap;
}

function area(name, label, value) {
  const wrap = document.createElement("label");
  wrap.className = "field";
  const span = document.createElement("span");
  span.textContent = label;
  const input = document.createElement("textarea");
  input.name = name;
  input.rows = 4;
  input.value = value || "";
  wrap.append(span, input);
  return wrap;
}

function selectField(name, label, value, options) {
  const wrap = document.createElement("label");
  wrap.className = "field";
  const span = document.createElement("span");
  span.textContent = label;
  const input = document.createElement("select");
  input.name = name;
  for (const [optionValue, optionLabel] of options) {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = optionLabel;
    if (optionValue === value) option.selected = true;
    input.append(option);
  }
  wrap.append(span, input);
  return wrap;
}

function findItem(mode, id, listId) {
  if (!id) return null;
  if (mode === "list") {
    const list = state.lists.find((row) => row.id === listId) || L.shoppingList(state);
    return list && (list.items || []).find((row) => row.id === id);
  }
  if (mode === "milestone") {
    const kid = kidOf(state);
    return kid && (kid.milestones || []).find((row) => row.id === id);
  }
  if (mode === "prep") return state.baby2.prep.find((row) => row.id === id);
  if (mode === "kidprep") {
    const kid = kidOf(state);
    return kid && (kid.prep || []).find((row) => row.id === id);
  }
  if (mode === "vaccine") {
    const kid = kidOf(state);
    return kid && (kid.vaccines || []).find((row) => row.id === id);
  }
  if (mode === "keyDate") return state.keyDates.find((row) => row.id === id);
  if (mode === "doc") return state.docs.find((row) => row.id === id);
  if (mode === "insurance" && state.insurance) return policyById(state.insurance, id);
  return null;
}

function policyById(insurance, id) {
  const policies = (insurance && insurance.policies) || [];
  const found = policies.find((policy) => policy && policy.id === id);
  if (found) return found;
  const index = /^ins:(\d+):/.exec(id);
  return index ? policies[Number(index[1])] || null : null;
}

function ensureInsurance(draft) {
  if (!draft.insurance || typeof draft.insurance !== "object") draft.insurance = { asOf: today(), policies: [] };
  if (!Array.isArray(draft.insurance.policies)) draft.insurance.policies = [];
  if (!draft.insurance.asOf) draft.insurance.asOf = today();
  return draft.insurance;
}

function openEditor(mode, id, listId) {
  if (mode === "fixedItem") return;
  editor.mode = mode;
  editor.id = id || "";
  editor.listId = listId || "";
  const dialog = document.getElementById("editor");
  const fields = document.getElementById("editor-fields");
  const title = document.getElementById("editor-title");
  const del = document.getElementById("editor-delete");
  fields.replaceChildren();
  del.hidden = !id || mode === "notes" || mode === "sleep" || mode === "born";
  del.textContent = "Delete";
  del.dataset.armed = "";
  const item = findItem(mode, id, listId);
  if (mode === "list" || mode === "milestone" || mode === "prep" || mode === "kidprep") {
    title.textContent = id ? "Edit item" : "Add item";
    fields.append(field("text", "text", "Item", item ? item.text : ""));
  } else if (mode === "vaccine") {
    title.textContent = id ? "Edit vaccination" : "Add vaccination";
    fields.append(field("name", "text", "Name", item ? item.name : ""));
    fields.append(field("notes", "text", "Note", item ? item.notes || "" : "Per NCIS schedule"));
    fields.append(selectField("status", "Status", item ? item.status || "due" : "due", [["due", "Due"], ["done", "Done"]]));
  } else if (mode === "keyDate") {
    title.textContent = id ? "Edit date" : "Add a date";
    fields.append(field("title", "text", "Title", item ? item.title : ""));
    fields.append(field("date", "date", "Date", item ? item.date : today()));
    fields.append(
      selectField("kind", "Kind", item ? item.kind || "task" : "task", [
        ["bill", "Bill"],
        ["renewal", "Renewal"],
        ["subscription", "Subscription"],
        ["birthday", "Birthday"],
        ["home", "Home"],
        ["family", "Family"],
        ["task", "Task"],
        ["professional", "Professional"],
        ["document", "Document"],
        ["car", "Car"],
        ["trip", "Trip"],
      ])
    );
    fields.append(field("notes", "text", "Note (optional)", item ? item.notes || "" : ""));
    fields.append(selectField("child", "Child (optional)", item && item.child ? item.child : "", [["", "None"], ["anya", "Anya"], ["yuna", "Yuna"]]));
  } else if (mode === "insurance") {
    title.textContent = id ? "Edit cover" : "Add cover";
    fields.append(selectField("person", "Person", item ? item.person : "Wei Liang", [["Wei Liang", "Wei Liang"], ["Zhen Ling", "Zhen Ling"], ["Anya", "Anya"], ["Yuna", "Yuna"]]));
    fields.append(selectField("category", "Category", item ? item.category : "Health", [["Life", "Life"], ["Health", "Health"], ["Extras", "Extras"]]));
    fields.append(field("name", "text", "Name", item ? item.name : ""));
    fields.append(field("cover", "text", "What it covers", item ? item.cover || "" : ""));
    fields.append(field("premium", "number", "Premium", item && item.premium != null ? item.premium : ""));
    fields.append(selectField("frequency", "Frequency", item ? item.frequency || "yearly" : "yearly", [["monthly", "Monthly"], ["yearly", "Yearly"]]));
    fields.append(field("payment", "text", "How it is paid", item ? item.payment || "" : ""));
    fields.append(field("nextDue", "date", "Next due", item && item.nextDue ? item.nextDue : ""));
    fields.append(selectField("status", "Status", item ? item.status || "active" : "active", [["active", "Active"], ["cancelled", "Cancelled"]]));
  } else if (mode === "doc") {
    title.textContent = id ? "Edit document" : "Add a document";
    fields.append(field("title", "text", "Title", item ? item.title : ""));
    fields.append(field("subtitle", "text", "Subtitle", item ? item.subtitle || "" : ""));
    fields.append(field("url", "url", "Link", item ? item.url || "" : ""));
  } else if (mode === "notes") {
    const kid = kidOf(state);
    title.textContent = kid ? `${kid.name}'s note` : "Note";
    fields.append(area("notes", "Note", kid ? kid.notes || "" : ""));
  } else if (mode === "born") {
    const kid = kidOf(state);
    title.textContent = "Birth date";
    del.hidden = true;
    fields.append(field("bornDate", "date", "Born", kid && kid.bornDate ? kid.bornDate : today()));
  } else if (mode === "sleep") {
    title.textContent = "Sleep";
    const kid = kidOf(state);
    const sleep = (kid && kid.sleep) || {};
    fields.append(field("napsPerDay", "number", "Naps a day", sleep.napsPerDay ?? 2));
    fields.append(field("napNote", "text", "Nap note", sleep.napNote || ""));
    fields.append(field("bedtime", "time", "Bedtime", sleep.bedtime || "19:00"));
    fields.append(field("bedtimeNote", "text", "Bedtime note", sleep.bedtimeNote || ""));
  }
  if (typeof dialog.showModal === "function") dialog.showModal();
  const first = fields.querySelector("input, textarea, select");
  if (first) first.focus();
}

function onEditorSubmit(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const text = (name) => String(data.get(name) || "").trim();
  const mode = editor.mode;
  const id = editor.id;
  const listId = editor.listId;
  if (mode === "fixedItem") {
    document.getElementById("editor").close();
    return;
  }
  commit((draft) => {
    if (mode === "list" || mode === "milestone" || mode === "prep" || mode === "kidprep") {
      if (!text("text")) return;
      const apply = (list) => {
        if (id) {
          const item = list.find((row) => row.id === id);
          if (item) item.text = text("text");
        } else list.push({ id: uid(), text: text("text"), done: false });
      };
      if (mode === "list") {
        const list = draft.lists.find((row) => row.id === listId) || draft.lists[0];
        if (!list) return;
        list.items = list.items || [];
        apply(list.items);
      } else if (mode === "milestone") {
        writeKid(draft, (kid) => {
          kid.milestones = kid.milestones || [];
          apply(kid.milestones);
        });
      } else if (mode === "kidprep") {
        writeKid(draft, (kid) => {
          kid.prep = kid.prep || [];
          apply(kid.prep);
        });
      } else apply(draft.baby2.prep);
    } else if (mode === "vaccine") {
      if (!text("name")) return;
      writeKid(draft, (kid) => {
        kid.vaccines = kid.vaccines || [];
        if (id) {
          const item = kid.vaccines.find((row) => row.id === id);
          if (!item) return;
          item.name = text("name");
          item.notes = text("notes");
          item.status = text("status") === "done" ? "done" : "due";
        } else {
          kid.vaccines.push({ id: uid(), name: text("name"), notes: text("notes"), status: text("status") === "done" ? "done" : "due" });
        }
      });
    } else if (mode === "keyDate") {
      if (!text("title") || !text("date")) return;
      const next = { title: text("title"), date: text("date"), kind: text("kind") || "task", notes: text("notes"), child: text("child") };
      if (id) {
        const item = draft.keyDates.find((row) => row.id === id);
        if (item) Object.assign(item, next);
      } else draft.keyDates.push({ id: uid(), ...next });
    } else if (mode === "insurance") {
      if (!text("name")) return;
      const book = ensureInsurance(draft);
      const premium = Number(text("premium"));
      const next = {
        person: text("person") || "Wei Liang",
        category: text("category") || "Health",
        name: text("name"),
        cover: text("cover"),
        premium: Number.isFinite(premium) ? premium : 0,
        frequency: text("frequency") === "monthly" ? "monthly" : "yearly",
        payment: text("payment"),
        nextDue: text("nextDue") || null,
        status: text("status") === "cancelled" ? "cancelled" : "active",
      };
      const current = id ? policyById(book, id) : null;
      if (current) {
        const keepId = current.id || uid();
        Object.keys(current).forEach((key) => delete current[key]);
        Object.assign(current, next, { id: keepId });
      } else book.policies.push({ id: uid(), ...next });
    } else if (mode === "doc") {
      if (!text("title")) return;
      const next = { title: text("title"), subtitle: text("subtitle"), url: text("url") };
      if (id) {
        const item = draft.docs.find((row) => row.id === id);
        if (item) Object.assign(item, next);
      } else draft.docs.push({ id: uid(), ...next });
    } else if (mode === "notes") {
      writeKid(draft, (kid) => {
        kid.notes = text("notes");
      });
    } else if (mode === "born") {
      const born = text("bornDate");
      if (!born) return;
      writeKid(draft, (kid) => {
        kid.bornDate = born;
      });
    } else if (mode === "sleep") {
      const naps = Number(text("napsPerDay"));
      writeKid(draft, (kid) => {
        kid.sleep = kid.sleep || {};
        if (Number.isFinite(naps)) kid.sleep.napsPerDay = naps;
        kid.sleep.napNote = text("napNote");
        kid.sleep.bedtime = text("bedtime") || kid.sleep.bedtime;
        kid.sleep.bedtimeNote = text("bedtimeNote");
      });
    }
  });
  document.getElementById("editor").close();
}

function onEditorDelete() {
  const del = document.getElementById("editor-delete");
  if (del.dataset.armed !== "1") {
    del.dataset.armed = "1";
    del.textContent = "Tap again to delete";
    return;
  }
  const mode = editor.mode;
  const id = editor.id;
  if (mode === "fixedItem") {
    document.getElementById("editor").close();
    return;
  }
  commit((draft) => {
    if (mode === "list") {
      const list = draft.lists.find((row) => row.id === editor.listId) || draft.lists[0];
      if (list) list.items = (list.items || []).filter((row) => row.id !== id);
    } else if (mode === "milestone") {
      writeKid(draft, (kid) => {
        kid.milestones = (kid.milestones || []).filter((row) => row.id !== id);
      });
    } else if (mode === "prep") draft.baby2.prep = draft.baby2.prep.filter((row) => row.id !== id);
    else if (mode === "kidprep") {
      writeKid(draft, (kid) => {
        kid.prep = (kid.prep || []).filter((row) => row.id !== id);
      });
    } else if (mode === "vaccine") {
      writeKid(draft, (kid) => {
        kid.vaccines = (kid.vaccines || []).filter((row) => row.id !== id);
      });
    } else if (mode === "keyDate") draft.keyDates = draft.keyDates.filter((row) => row.id !== id);
    else if (mode === "insurance" && draft.insurance) {
      draft.insurance.policies = (draft.insurance.policies || []).filter((policy, index) => {
        if (policy && policy.id === id) return false;
        return `ins:${index}:${policy.person || ""}:${policy.name || ""}:${policy.nextDue || ""}` !== id;
      });
    } else if (mode === "doc") draft.docs = draft.docs.filter((row) => row.id !== id);
  });
  document.getElementById("editor").close();
}

document.getElementById("main").addEventListener("click", onClick);
document.getElementById("tabbar").addEventListener("click", onClick);
document.getElementById("main").addEventListener("change", onChange);
document.getElementById("main").addEventListener("submit", onSubmit);
document.getElementById("editor-form").addEventListener("submit", onEditorSubmit);
document.getElementById("editor-delete").addEventListener("click", onEditorDelete);
document.getElementById("editor-cancel").addEventListener("click", () => document.getElementById("editor").close());

if (window.SupaSync) {
  SupaSync.mountAuthGate(document.getElementById("authGate"), (user) => {
    boot(user);
  });
} else {
  const gate = document.getElementById("authGate");
  if (gate) gate.hidden = true;
  boot(null);
}

window.FamilyHubApp = { boot, render };
