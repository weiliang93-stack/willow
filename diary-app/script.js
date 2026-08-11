const STORAGE_KEY = "diaryApp.entries";

let entries = load();

// State for whatever's currently in the entry form — a fresh draft or an
// existing entry being edited. Attachments already written to IndexedDB
// during this compose session (via the file picker) live in
// `newlyAddedIds` so an abandoned edit/draft can clean up its own blobs
// without touching attachments that belong to a saved entry.
let formAttachments = []; // {id, name, mimeType, kind, previewUrl, missing}
let newlyAddedIds = new Set();
let editingEntryId = null;
let editingOriginalAttachmentIds = new Set();

// Object URLs created while hydrating entry-list thumbnails, revoked at
// the start of the next render so they don't pile up.
let activeListObjectUrls = [];

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  SupaSync.pushState("diary", { entries });
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDateLong(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Same month/day, `years` earlier. Falls back to how the JS Date engine
// normalizes invalid dates (Feb 29 in a non-leap year rolls to Mar 1).
function shiftYears(dateStr, years) {
  const d = new Date(dateStr + "T00:00:00");
  d.setFullYear(d.getFullYear() + years);
  return toDateStr(d);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// --- elements ---

const entryForm = document.getElementById("entry-form");
const entryFormHeading = document.getElementById("entry-form-heading");
const entryDateInput = document.getElementById("entry-date");
const entryTitleInput = document.getElementById("entry-title");
const entryTextInput = document.getElementById("entry-text");
const entryFilesInput = document.getElementById("entry-files");
const attachmentPreviewsEl = document.getElementById("attachment-previews");
const cancelEditBtn = document.getElementById("cancel-edit-btn");

const searchTextInput = document.getElementById("search-text");
const clearSearchBtn = document.getElementById("clear-search-btn");
const searchResultsPanelEl = document.getElementById("search-results-panel");
const searchResultsListEl = document.getElementById("search-results-list");
const searchResultCountEl = document.getElementById("search-result-count");

const onThisDayHeadingEl = document.getElementById("on-this-day-heading");
const onThisDayContentEl = document.getElementById("on-this-day-content");

const calendarPanelEl = document.getElementById("calendar-panel");
const calendarMonthLabelEl = document.getElementById("calendar-month-label");
const calendarGridEl = document.getElementById("calendar-grid");
const calPrevBtn = document.getElementById("cal-prev-btn");
const calNextBtn = document.getElementById("cal-next-btn");
const calTodayBtn = document.getElementById("cal-today-btn");

const selectedDayPanelEl = document.getElementById("selected-day-panel");
const selectedDayHeadingEl = document.getElementById("selected-day-heading");
const selectedDayEntriesEl = document.getElementById("selected-day-entries");
const writeForDayBtn = document.getElementById("write-for-day-btn");

entryDateInput.value = todayStr();

// Calendar month currently on screen, and the date whose entries are
// shown in the selected-day panel — independent of each other so paging
// through months doesn't lose the selection.
let calendarYear = new Date().getFullYear();
let calendarMonth = new Date().getMonth();
let selectedDate = todayStr();

// --- attachment handling in the form ---

async function handleFilesSelected(fileList) {
  for (const file of Array.from(fileList)) {
    const kind = file.type.startsWith("video/") ? "video" : "image";
    const id = uid();
    await MediaStore.putBlob(id, file);
    newlyAddedIds.add(id);
    formAttachments.push({
      id,
      name: file.name,
      mimeType: file.type,
      kind,
      previewUrl: URL.createObjectURL(file),
    });
  }
  renderAttachmentPreviews();
}

function removeFormAttachment(id) {
  const idx = formAttachments.findIndex((a) => a.id === id);
  if (idx === -1) return;
  const [removed] = formAttachments.splice(idx, 1);
  if (removed.previewUrl) URL.revokeObjectURL(removed.previewUrl);
  if (newlyAddedIds.has(id)) {
    newlyAddedIds.delete(id);
    MediaStore.deleteBlob(id);
  }
  renderAttachmentPreviews();
}

function renderAttachmentPreviews() {
  if (formAttachments.length === 0) {
    attachmentPreviewsEl.innerHTML = "";
    return;
  }
  attachmentPreviewsEl.innerHTML = formAttachments
    .map((a) => {
      const media = a.missing
        ? `<div class="thumb-missing">${a.kind === "video" ? "🎬" : "🖼"}<br>not on this device</div>`
        : a.kind === "video"
          ? `<video src="${a.previewUrl}" controls></video>`
          : `<img src="${a.previewUrl}" alt="${escapeHtml(a.name)}">`;
      return `
        <div class="attachment-thumb">
          ${media}
          <button type="button" class="remove-thumb-btn" data-id="${a.id}" aria-label="Remove attachment">&times;</button>
        </div>
      `;
    })
    .join("");
}

entryFilesInput.addEventListener("change", (e) => {
  if (e.target.files.length) handleFilesSelected(e.target.files);
  e.target.value = "";
});

attachmentPreviewsEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".remove-thumb-btn");
  if (btn) removeFormAttachment(btn.dataset.id);
});

// --- form submit / reset / edit ---

function resetForm() {
  formAttachments.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
  formAttachments = [];
  newlyAddedIds = new Set();
  editingEntryId = null;
  editingOriginalAttachmentIds = new Set();
  entryForm.reset();
  entryDateInput.value = todayStr();
  entryFormHeading.textContent = "New entry";
  cancelEditBtn.classList.add("hidden");
  renderAttachmentPreviews();
}

entryForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const date = entryDateInput.value;
  const title = entryTitleInput.value.trim();
  const text = entryTextInput.value.trim();
  if (!date || !text) return;

  const attachments = formAttachments.map(({ id, name, mimeType, kind }) => ({ id, name, mimeType, kind }));

  if (editingEntryId) {
    const keptIds = new Set(attachments.map((a) => a.id));
    for (const origId of editingOriginalAttachmentIds) {
      if (!keptIds.has(origId)) MediaStore.deleteBlob(origId);
    }
    const entry = entries.find((en) => en.id === editingEntryId);
    entry.date = date;
    entry.title = title;
    entry.text = text;
    entry.attachments = attachments;
    entry.updatedAt = new Date().toISOString();
  } else {
    entries.unshift({
      id: uid(),
      date,
      title,
      text,
      attachments,
      createdAt: new Date().toISOString(),
    });
  }

  save();
  resetForm();
  selectedDate = date;
  calendarYear = Number(date.slice(0, 4));
  calendarMonth = Number(date.slice(5, 7)) - 1;
  render();
});

cancelEditBtn.addEventListener("click", () => {
  for (const id of newlyAddedIds) MediaStore.deleteBlob(id);
  resetForm();
});

async function startEdit(id) {
  const entry = entries.find((en) => en.id === id);
  if (!entry) return;

  formAttachments.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
  formAttachments = [];
  newlyAddedIds = new Set();
  editingEntryId = entry.id;
  editingOriginalAttachmentIds = new Set(entry.attachments.map((a) => a.id));

  entryDateInput.value = entry.date;
  entryTitleInput.value = entry.title || "";
  entryTextInput.value = entry.text;
  entryFormHeading.textContent = "Edit entry";
  cancelEditBtn.classList.remove("hidden");

  for (const att of entry.attachments) {
    const blob = await MediaStore.getBlob(att.id);
    formAttachments.push({
      ...att,
      previewUrl: blob ? URL.createObjectURL(blob) : null,
      missing: !blob,
    });
  }
  renderAttachmentPreviews();
  entryForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function deleteEntry(id) {
  const entry = entries.find((en) => en.id === id);
  if (!entry) return;
  if (!confirm("Delete this entry and its attachments?")) return;
  for (const att of entry.attachments) MediaStore.deleteBlob(att.id);
  entries = entries.filter((en) => en.id !== id);
  if (editingEntryId === id) resetForm();
  save();
  render();
}

// --- search ---

function matchingEntries(query) {
  const text = query.trim().toLowerCase();
  return entries
    .filter((entry) => entry.text.toLowerCase().includes(text) || (entry.title || "").toLowerCase().includes(text))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt.localeCompare(a.createdAt)));
}

searchTextInput.addEventListener("input", render);

clearSearchBtn.addEventListener("click", () => {
  searchTextInput.value = "";
  render();
});

// --- rendering ---

function revokeActiveListObjectUrls() {
  activeListObjectUrls.forEach((u) => URL.revokeObjectURL(u));
  activeListObjectUrls = [];
}

function entryCardHtml(entry) {
  const thumbs = entry.attachments
    .map((a) => `<div class="thumb" data-media-id="${a.id}" data-kind="${a.kind}"><span class="thumb-loading">…</span></div>`)
    .join("");

  return `
    <article class="entry-card" data-id="${entry.id}">
      <div class="entry-card-top">
        <div>
          <div class="entry-date">${formatDateLong(entry.date)}</div>
          ${entry.title ? `<h3 class="entry-title">${escapeHtml(entry.title)}</h3>` : ""}
        </div>
        <div class="entry-actions">
          <button type="button" class="link-btn edit-entry-btn" data-id="${entry.id}">Edit</button>
          <button type="button" class="link-btn delete-entry-btn" data-id="${entry.id}">Delete</button>
        </div>
      </div>
      <p class="entry-text">${escapeHtml(entry.text)}</p>
      ${thumbs ? `<div class="entry-thumbs">${thumbs}</div>` : ""}
    </article>
  `;
}

async function hydrateThumbnails(rootEl) {
  const nodes = rootEl.querySelectorAll("[data-media-id]");
  for (const node of nodes) {
    const id = node.dataset.mediaId;
    const kind = node.dataset.kind;
    const blob = await MediaStore.getBlob(id);
    if (!blob) {
      node.classList.add("thumb-missing");
      node.innerHTML = `${kind === "video" ? "🎬" : "🖼"}<br>not on this device`;
      continue;
    }
    const url = URL.createObjectURL(blob);
    activeListObjectUrls.push(url);
    node.innerHTML = kind === "video" ? `<video src="${url}" controls></video>` : `<img src="${url}" alt="">`;
  }
}

// Object URLs for the calendar's own photo tiles, tracked separately from
// activeListObjectUrls since renderCalendar() can be called on its own
// (month nav) without going through the full render() pass.
let activeCalendarObjectUrls = [];
function revokeActiveCalendarObjectUrls() {
  activeCalendarObjectUrls.forEach((u) => URL.revokeObjectURL(u));
  activeCalendarObjectUrls = [];
}

function renderCalendar() {
  revokeActiveCalendarObjectUrls();
  const firstOfMonth = new Date(calendarYear, calendarMonth, 1);
  const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
  const startWeekday = firstOfMonth.getDay(); // 0 = Sun
  const today = todayStr();

  const entriesByDate = new Map();
  for (const entry of entries) {
    if (!entriesByDate.has(entry.date)) entriesByDate.set(entry.date, []);
    entriesByDate.get(entry.date).push(entry);
  }

  calendarMonthLabelEl.textContent = firstOfMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  let cells = "";
  for (let i = 0; i < startWeekday; i++) cells += `<div class="cal-cell cal-empty"></div>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${calendarYear}-${String(calendarMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const dayEntries = entriesByDate.get(dateStr);
    const classes = ["cal-cell"];
    if (dayEntries) classes.push("has-entry");
    if (dateStr === today) classes.push("is-today");
    if (dateStr === selectedDate) classes.push("is-selected");

    // Days with a photo attachment get it as a filling thumbnail (most
    // recent entry that day, first image on it); days with only text (or
    // only video, or a photo not available on this device) fall back to
    // a plain solid-color tile — still visually distinct from empty days.
    let thumbHtml = "";
    if (dayEntries) {
      const photo = dayEntries
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .flatMap((e) => e.attachments)
        .find((a) => a.kind === "image");
      if (photo) thumbHtml = `<div class="cal-thumb" data-media-id="${photo.id}"></div>`;
    }

    cells += `<button type="button" class="${classes.join(" ")}" data-date="${dateStr}">
        ${thumbHtml}
        <span class="cal-day-num">${day}</span>
      </button>`;
  }

  calendarGridEl.innerHTML = cells;
  hydrateCalendarThumbnails();
}

async function hydrateCalendarThumbnails() {
  const nodes = calendarGridEl.querySelectorAll(".cal-thumb[data-media-id]");
  for (const node of nodes) {
    const blob = await MediaStore.getBlob(node.dataset.mediaId);
    if (!blob) continue; // leave the solid-color fallback in place
    const url = URL.createObjectURL(blob);
    activeCalendarObjectUrls.push(url);
    node.style.backgroundImage = `url("${url}")`;
  }
}

function renderSelectedDay() {
  selectedDayHeadingEl.textContent = formatDateLong(selectedDate);
  const dayEntries = entries.filter((entry) => entry.date === selectedDate).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (dayEntries.length === 0) {
    selectedDayEntriesEl.innerHTML = `<p class="hint empty-state">No entry for this day yet.</p>`;
    return;
  }
  selectedDayEntriesEl.innerHTML = dayEntries.map(entryCardHtml).join("");
  hydrateThumbnails(selectedDayEntriesEl);
}

function renderOnThisDay() {
  const targetDate = shiftYears(selectedDate, -1);
  onThisDayHeadingEl.textContent = `On this day, 1 year ago — ${formatDateLong(targetDate)}`;
  const matches = entries.filter((entry) => entry.date === targetDate);
  if (matches.length === 0) {
    onThisDayContentEl.innerHTML = `<p class="hint empty-state">No entry from this day last year.</p>`;
    return;
  }
  onThisDayContentEl.innerHTML = matches.map(entryCardHtml).join("");
  hydrateThumbnails(onThisDayContentEl);
}

function render() {
  revokeActiveListObjectUrls();
  renderOnThisDay();

  const query = searchTextInput.value.trim();
  if (query) {
    calendarPanelEl.classList.add("hidden");
    selectedDayPanelEl.classList.add("hidden");
    searchResultsPanelEl.classList.remove("hidden");

    const matches = matchingEntries(query);
    searchResultCountEl.textContent = `${matches.length} ${matches.length === 1 ? "match" : "matches"}`;
    searchResultsListEl.innerHTML =
      matches.length === 0 ? `<p class="hint empty-state">No entries match your search.</p>` : matches.map(entryCardHtml).join("");
    hydrateThumbnails(searchResultsListEl);
    return;
  }

  searchResultsPanelEl.classList.add("hidden");
  calendarPanelEl.classList.remove("hidden");
  selectedDayPanelEl.classList.remove("hidden");
  renderCalendar();
  renderSelectedDay();
}

function goToMonth(delta) {
  calendarMonth += delta;
  if (calendarMonth < 0) {
    calendarMonth = 11;
    calendarYear -= 1;
  } else if (calendarMonth > 11) {
    calendarMonth = 0;
    calendarYear += 1;
  }
  renderCalendar();
}

calPrevBtn.addEventListener("click", () => goToMonth(-1));
calNextBtn.addEventListener("click", () => goToMonth(1));
calTodayBtn.addEventListener("click", () => {
  const today = new Date();
  calendarYear = today.getFullYear();
  calendarMonth = today.getMonth();
  selectedDate = todayStr();
  renderCalendar();
  renderSelectedDay();
  renderOnThisDay();
});

calendarGridEl.addEventListener("click", (e) => {
  const cell = e.target.closest(".cal-cell[data-date]");
  if (!cell) return;
  selectedDate = cell.dataset.date;
  renderCalendar();
  renderSelectedDay();
  renderOnThisDay();
});

writeForDayBtn.addEventListener("click", () => {
  entryDateInput.value = selectedDate;
  entryForm.scrollIntoView({ behavior: "smooth", block: "start" });
  entryTextInput.focus();
});

function onEntryListClick(e) {
  const editBtn = e.target.closest(".edit-entry-btn");
  if (editBtn) return startEdit(editBtn.dataset.id);
  const deleteBtn = e.target.closest(".delete-entry-btn");
  if (deleteBtn) return deleteEntry(deleteBtn.dataset.id);
}

[selectedDayEntriesEl, searchResultsListEl, onThisDayContentEl].forEach((el) => el.addEventListener("click", onEntryListClick));

// Pulls this user's cloud entries (if signed in) before the first render.
// Attachment blobs never leave this device's IndexedDB, so a returning
// device gets entry text/metadata but shows "not on this device" for any
// attachment made elsewhere.
async function bootDiaryApp() {
  const remote = await SupaSync.pullState("diary");
  if (remote) {
    entries = remote.entries || [];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  }

  render();

  if (!remote) save();
}

SupaSync.mountAuthGate(document.getElementById("authGate"), () => {
  document.getElementById("app-content").style.display = "";
  bootDiaryApp();
});
