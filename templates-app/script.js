// Search/browse/copy UI for consult-note templates, synced from two
// separate Google Docs by two Edge Functions: WILLOW (in-clinic
// templates, sheet-templates-sync -> app_state app "templates") and
// WILLOW TM (teleconsult templates, sheet-teletemplates-sync ->
// app_state app "teletemplates"). The mode toggle switches which of the
// two data sets is active; each has its own templates, categories, and
// starred list. Mostly read-only — the templates themselves only ever
// come from a pull, this app never edits or reorders them — except for
// one thing it does own per mode: which templates are starred. Starring
// pushes {templates, starred} back to Supabase under that mode's app key
// so starred templates follow the account across devices; each sync
// function preserves its own starred list (matched by template id)
// across its daily overwrite of `templates`, so a re-sync never wipes
// it. Caches everything locally so it still works offline in clinic.

const MODE_KEY = "willow_templates_mode";

const MODES = {
  clinic: {
    app: "templates",
    label: "In-Clinic",
    dataKey: "willow_templates_data",
    updatedAtKey: "willow_templates_updated_at",
    starredKey: "willow_templates_starred",
    categoryOrder: [
      "General", "Neuro", "PSY", "Eye", "ENT", "Chest", "Abdomen",
      "Uro/Gynae", "Dermatology", "MSK/Ortho", "Procedures", "Chronic Conditions Follow-up",
    ],
  },
  tele: {
    app: "teletemplates",
    label: "Teleconsult",
    dataKey: "willow_teletemplates_data",
    updatedAtKey: "willow_teletemplates_updated_at",
    starredKey: "willow_teletemplates_starred",
    categoryOrder: [
      "Standard Blocks", "General / Systemic", "Musculoskeletal", "Neurology",
      "Eye", "ENT / Oral", "Abdomen", "Urology / Gynaecology", "Dermatology",
    ],
  },
};

const CATEGORY_ICONS = {
  "General": `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><line x1="5" y1="7" x2="19" y2="7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><line x1="5" y1="17" x2="14" y2="17" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`,
  "General / Systemic": `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><line x1="5" y1="7" x2="19" y2="7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><line x1="5" y1="17" x2="14" y2="17" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`,
  "Neuro": `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M6 10a6 6 0 1112 0c0 3-1.4 4-1.4 6.2 0 1-.8 1.8-1.8 1.8h-5.6c-1 0-1.8-.8-1.8-1.8C7.4 14 6 13 6 10z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M10 20h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  "Neurology": `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M6 10a6 6 0 1112 0c0 3-1.4 4-1.4 6.2 0 1-.8 1.8-1.8 1.8h-5.6c-1 0-1.8-.8-1.8-1.8C7.4 14 6 13 6 10z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M10 20h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  "PSY": `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M6 18l3-3h9a2 2 0 002-2V8a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
  "Eye": `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.4" stroke="currentColor" stroke-width="1.6"/></svg>`,
  "ENT": `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M8 5c-2.5 1-4 3.6-4 6.4C4 15.6 7 19 12 19c1.6 0 2.6-1 2.6-2.2 0-1-.7-1.4-.7-2.4 0-1.2 1.1-1.6 1.1-3 0-2.6-2.4-4-2.4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  "ENT / Oral": `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M8 5c-2.5 1-4 3.6-4 6.4C4 15.6 7 19 12 19c1.6 0 2.6-1 2.6-2.2 0-1-.7-1.4-.7-2.4 0-1.2 1.1-1.6 1.1-3 0-2.6-2.4-4-2.4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  "Chest": `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M3 13h3l2-5 3 9 2.5-6 1.5 2h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  "Abdomen": `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M7 5c-2 2-3 4.6-3 7.4C4 16.8 7.4 20 12 20s8-3.2 8-7.6c0-2.8-1-5.4-3-7.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><line x1="8.5" y1="12.5" x2="15.5" y2="12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  "Uro/Gynae": `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 4c-2.6 0-4.6 2.4-4.6 5.4 0 2.4 1.2 3.4 1.2 5.4 0 2.4 1.5 4.2 3.4 4.2s3.4-1.8 3.4-4.2c0-2 1.2-3 1.2-5.4C16.6 6.4 14.6 4 12 4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
  "Urology / Gynaecology": `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 4c-2.6 0-4.6 2.4-4.6 5.4 0 2.4 1.2 3.4 1.2 5.4 0 2.4 1.5 4.2 3.4 4.2s3.4-1.8 3.4-4.2c0-2 1.2-3 1.2-5.4C16.6 6.4 14.6 4 12 4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
  "Dermatology": `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="5" y="6" width="14" height="12" rx="3" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/></svg>`,
  "MSK/Ortho": `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="4" y="10" width="4.4" height="4.4" rx="1.4" transform="rotate(-45 6.2 12.2)" stroke="currentColor" stroke-width="1.6"/><rect x="15.4" y="10" width="4.4" height="4.4" rx="1.4" transform="rotate(-45 17.6 12.2)" stroke="currentColor" stroke-width="1.6"/><line x1="9" y1="12.2" x2="15" y2="12.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  "Musculoskeletal": `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="4" y="10" width="4.4" height="4.4" rx="1.4" transform="rotate(-45 6.2 12.2)" stroke="currentColor" stroke-width="1.6"/><rect x="15.4" y="10" width="4.4" height="4.4" rx="1.4" transform="rotate(-45 17.6 12.2)" stroke="currentColor" stroke-width="1.6"/><line x1="9" y1="12.2" x2="15" y2="12.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  "Procedures": `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="8.5" cy="8.5" r="3.2" stroke="currentColor" stroke-width="1.6"/><circle cx="15.5" cy="15.5" r="3.2" stroke="currentColor" stroke-width="1.6"/><line x1="10.8" y1="10.8" x2="13.2" y2="13.2" stroke="currentColor" stroke-width="1.6"/></svg>`,
  "Chronic Conditions Follow-up": `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M4 12a8 8 0 0113.7-5.7M20 12a8 8 0 01-13.7 5.7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M17.7 4.6v3.4h-3.4M6.3 19.4V16h3.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  "Standard Blocks": `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="6" y="4" width="12" height="16" rx="2" stroke="currentColor" stroke-width="1.6"/><line x1="9" y1="9" x2="15" y2="9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><line x1="9" y1="13" x2="15" y2="13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><line x1="9" y1="17" x2="12.5" y2="17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
};

const CHEVRON_SVG = `<svg class="row-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const STAR_ICON_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 3.5l2.55 5.6 6.15.65-4.6 4.2 1.25 6.05L12 16.9l-5.35 3.1 1.25-6.05-4.6-4.2 6.15-.65z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

const COPY_ICON = `<rect x="8" y="8" width="11" height="12" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M15 8V6.5A1.5 1.5 0 0013.5 5h-8A1.5 1.5 0 004 6.5v9A1.5 1.5 0 005.5 17H8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;
const COPIED_ICON = `<path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`;

const savedMode = localStorage.getItem(MODE_KEY);
let mode = MODES[savedMode] ? savedMode : "clinic";
const data = {
  clinic: { templates: [], updatedAt: null, starredIds: new Set() },
  tele: { templates: [], updatedAt: null, starredIds: new Set() },
};

let query = "";
let activeCategory = null;
let view = "list"; // "list" | "detail"
let activeTemplate = null;
let copyResetTimer = null;

const modeToggle = document.getElementById("modeToggle");
const searchBoxes = [
  { box: document.getElementById("searchBox"), input: document.getElementById("searchInput"), clearBtn: document.getElementById("clearSearchBtn") },
  { box: document.getElementById("searchBoxBottom"), input: document.getElementById("searchInputBottom"), clearBtn: document.getElementById("clearSearchBtnBottom") },
];
const listView = document.getElementById("listView");
const listMeta = document.getElementById("listMeta");
const listRows = document.getElementById("listRows");
const detailView = document.getElementById("detailView");
const backBtn = document.getElementById("backBtn");
const detailCategory = document.getElementById("detailCategory");
const detailTitle = document.getElementById("detailTitle");
const detailBody = document.getElementById("detailBody");
const copyBtn = document.getElementById("copyBtn");
const copyIcon = document.getElementById("copyIcon");
const copyLabel = document.getElementById("copyLabel");
const copyBtnTop = document.getElementById("copyBtnTop");
const copyIconTop = document.getElementById("copyIconTop");
const copyLabelTop = document.getElementById("copyLabelTop");
const starBtn = document.getElementById("starBtn");

function activeData() {
  return data[mode];
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function highlightTitle(title, q) {
  if (!q) return escapeHtml(title);
  const idx = title.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return escapeHtml(title);
  const before = title.slice(0, idx);
  const match = title.slice(idx, idx + q.length);
  const after = title.slice(idx + q.length);
  return `${escapeHtml(before)}<mark>${escapeHtml(match)}</mark>${escapeHtml(after)}`;
}

function filterTemplates(list, q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return list;
  return list.filter((t) => t.title.toLowerCase().includes(needle));
}

function groupByCategory(list) {
  const order = MODES[mode].categoryOrder;
  const counts = {};
  list.forEach((t) => {
    counts[t.category] = (counts[t.category] || 0) + 1;
  });
  const known = order.filter((c) => counts[c]).map((c) => ({ name: c, count: counts[c] }));
  const extra = Object.keys(counts)
    .filter((c) => !order.includes(c))
    .map((c) => ({ name: c, count: counts[c] }));
  return known.concat(extra);
}

function formatSyncedAt(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? `Synced today at ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
    : `Synced ${d.toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

function render() {
  if (view === "detail" && activeTemplate) {
    renderDetail();
  } else {
    renderList();
  }
}

function renderList() {
  detailView.classList.add("hidden");
  listView.classList.remove("hidden");
  listRows.innerHTML = "";

  const { templates } = activeData();
  const q = query.trim();

  if (!q && !activeCategory) {
    renderCategories();
    return;
  }

  let list = templates;
  if (activeCategory) list = list.filter((t) => t.category === activeCategory);
  if (q) list = filterTemplates(list, q);

  if (activeCategory && !q) {
    listMeta.innerHTML = `<button class="list-back-btn" id="toCategoriesBtn" type="button">‹ Categories</button><span>${escapeHtml(activeCategory)} &middot; ${list.length}</span>`;
    document.getElementById("toCategoriesBtn").addEventListener("click", () => {
      activeCategory = null;
      render();
    });
  } else {
    listMeta.textContent = `${list.length} result${list.length === 1 ? "" : "s"}`;
  }

  if (list.length === 0) {
    listRows.innerHTML = `<div class="empty-state">No matching templates.</div>`;
    return;
  }

  list.forEach((t) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "row";
    row.innerHTML = `
      <div class="row-body">
        <div class="row-title">${highlightTitle(t.title, q)}</div>
        <div class="row-sub">${escapeHtml(t.category)}</div>
      </div>
      ${CHEVRON_SVG}
    `;
    row.addEventListener("click", () => openTemplate(t));
    listRows.appendChild(row);
  });
}

function renderCategories() {
  const { templates, starredIds, updatedAt } = activeData();
  const cats = groupByCategory(templates);
  listMeta.textContent = `${cats.length} categories · ${templates.length} templates`;

  if (templates.length === 0) {
    listRows.innerHTML = `<div class="empty-state">No templates synced yet. Check back after the next daily sync.</div>`;
    return;
  }

  const starred = templates.filter((t) => starredIds.has(t.id));
  if (starred.length > 0) {
    const section = document.createElement("div");
    section.className = "starred-section";

    const label = document.createElement("div");
    label.className = "list-meta";
    label.textContent = "Starred";
    section.appendChild(label);

    const rows = document.createElement("div");
    rows.className = "list-rows";
    starred.forEach((t) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "row";
      row.innerHTML = `
        <div class="row-icon star">${STAR_ICON_SVG}</div>
        <div class="row-body">
          <div class="row-title">${escapeHtml(t.title)}</div>
          <div class="row-sub">${escapeHtml(t.category)}</div>
        </div>
        ${CHEVRON_SVG}
      `;
      row.addEventListener("click", () => openTemplate(t));
      rows.appendChild(row);
    });
    section.appendChild(rows);
    listRows.appendChild(section);
  }

  cats.forEach((cat) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "row";
    row.innerHTML = `
      <div class="row-icon">${CATEGORY_ICONS[cat.name] || CATEGORY_ICONS["General"]}</div>
      <div class="row-body"><div class="row-title">${escapeHtml(cat.name)}</div></div>
      <div class="row-count">${cat.count}</div>
      ${CHEVRON_SVG}
    `;
    row.addEventListener("click", () => {
      activeCategory = cat.name;
      render();
    });
    listRows.appendChild(row);
  });

  const synced = formatSyncedAt(updatedAt);
  if (synced) {
    const note = document.createElement("div");
    note.className = "stale-note";
    note.textContent = synced;
    listRows.appendChild(note);
  }
}

function renderDetail() {
  listView.classList.add("hidden");
  detailView.classList.remove("hidden");
  detailCategory.textContent = activeTemplate.category;
  detailTitle.textContent = activeTemplate.title;
  detailBody.textContent = activeTemplate.body;
  starBtn.classList.toggle("starred", activeData().starredIds.has(activeTemplate.id));
  setCopied(false);
}

function toggleStar(t) {
  const { starredIds, templates } = activeData();
  if (starredIds.has(t.id)) {
    starredIds.delete(t.id);
  } else {
    starredIds.add(t.id);
  }
  localStorage.setItem(MODES[mode].starredKey, JSON.stringify(Array.from(starredIds)));
  SupaSync.pushState(MODES[mode].app, { templates, starred: Array.from(starredIds) });
  render();
}

function openTemplate(t) {
  activeTemplate = t;
  view = "detail";
  render();
}

function closeDetail() {
  view = "list";
  activeTemplate = null;
  render();
}

function setCopied(copied) {
  copyBtn.classList.toggle("copied", copied);
  copyLabel.textContent = copied ? "Copied to clipboard" : "Copy template";
  copyIcon.innerHTML = copied ? COPIED_ICON : COPY_ICON;

  copyBtnTop.classList.toggle("copied", copied);
  copyLabelTop.textContent = copied ? "Copied" : "Copy";
  copyIconTop.innerHTML = copied ? COPIED_ICON : COPY_ICON;
}

async function handleCopy() {
  if (!activeTemplate) return;
  const text = activeTemplate.body;
  let copied = false;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch (err) {
      copied = false;
    }
  }
  if (!copied) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      copied = document.execCommand("copy");
    } catch (err) {
      copied = false;
    }
    document.body.removeChild(ta);
  }
  if (!copied) return;
  setCopied(true);
  clearTimeout(copyResetTimer);
  copyResetTimer = setTimeout(() => setCopied(false), 1800);
}

// Keeps the top and bottom search boxes in sync with each other and
// with `query` — whichever one the user is typing in, both should
// reflect the same value.
function setQuery(next, { fromInput } = {}) {
  query = next;
  activeCategory = null;
  view = "list";
  activeTemplate = null;
  searchBoxes.forEach(({ box, input, clearBtn }) => {
    if (input !== fromInput) input.value = query;
    clearBtn.classList.toggle("hidden", !query);
    box.classList.toggle("active", !!query);
  });
  render();
}

function clearQuery() {
  setQuery("");
  searchBoxes[0].input.focus();
}

function switchMode(next) {
  if (next === mode) return;
  mode = next;
  localStorage.setItem(MODE_KEY, mode);
  setQuery("");
  renderModeToggle();
}

function renderModeToggle() {
  modeToggle.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
}

function bindEvents() {
  modeToggle.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchMode(btn.dataset.mode));
  });

  searchBoxes.forEach(({ input, clearBtn }) => {
    input.addEventListener("input", () => setQuery(input.value, { fromInput: input }));
    input.addEventListener("focus", () => {
      if (view === "detail") setQuery(query);
    });
    clearBtn.addEventListener("click", clearQuery);
  });

  backBtn.addEventListener("click", closeDetail);
  copyBtn.addEventListener("click", handleCopy);
  copyBtnTop.addEventListener("click", handleCopy);
  starBtn.addEventListener("click", () => {
    if (activeTemplate) toggleStar(activeTemplate);
  });
}

async function loadMode(key) {
  const cfg = MODES[key];
  const bucket = data[key];
  const remote = await SupaSync.pullState(cfg.app);
  if (remote && Array.isArray(remote.state && remote.state.templates)) {
    bucket.templates = remote.state.templates;
    bucket.updatedAt = remote.updatedAt;
    bucket.starredIds = new Set(Array.isArray(remote.state.starred) ? remote.state.starred : []);
    localStorage.setItem(cfg.dataKey, JSON.stringify(bucket.templates));
    localStorage.setItem(cfg.updatedAtKey, bucket.updatedAt || "");
    localStorage.setItem(cfg.starredKey, JSON.stringify(Array.from(bucket.starredIds)));
  } else {
    try {
      bucket.templates = JSON.parse(localStorage.getItem(cfg.dataKey) || "[]");
    } catch (err) {
      bucket.templates = [];
    }
    bucket.updatedAt = localStorage.getItem(cfg.updatedAtKey) || null;
    try {
      bucket.starredIds = new Set(JSON.parse(localStorage.getItem(cfg.starredKey) || "[]"));
    } catch (err) {
      bucket.starredIds = new Set();
    }
  }
}

async function bootTemplatesApp() {
  await Promise.all([loadMode("clinic"), loadMode("tele")]);
  renderModeToggle();
  bindEvents();
  render();
}

SupaSync.mountAuthGate(document.getElementById("authGate"), () => {
  document.getElementById("app").style.display = "";
  bootTemplatesApp();
});
