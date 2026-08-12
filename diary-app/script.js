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

const exportBtn = document.getElementById("export-btn");
const exportStatusEl = document.getElementById("export-status");
const exportDownloadsEl = document.getElementById("export-downloads");
let lastExportObjectUrls = [];

const dayOneFileInput = document.getElementById("dayone-file");
const dayOneImportBtn = document.getElementById("dayone-import-btn");
const dayOneImportStatusEl = document.getElementById("dayone-import-status");

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
    Thumbnail.deleteDisplayBlob(id);
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
      if (!keptIds.has(origId)) {
        MediaStore.deleteBlob(origId);
        Thumbnail.deleteDisplayBlob(origId);
      }
    }
    const entry = entries.find((en) => en.id === editingEntryId);
    entry.date = date;
    entry.title = title;
    entry.text = text;
    entry.attachments = attachments;
    entry.updatedAt = new Date().toISOString();
  } else {
    const now = new Date().toISOString();
    entries.unshift({
      id: uid(),
      date,
      title,
      text,
      attachments,
      createdAt: now,
      updatedAt: now,
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
  for (const id of newlyAddedIds) {
    MediaStore.deleteBlob(id);
    Thumbnail.deleteDisplayBlob(id);
  }
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
    const blob = att.kind === "video" ? await MediaStore.getBlob(att.id) : await Thumbnail.getDisplayBlob(att.id);
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
  for (const att of entry.attachments) {
    MediaStore.deleteBlob(att.id);
    Thumbnail.deleteDisplayBlob(att.id);
  }
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
    // Images render from a small cached thumbnail rather than the
    // full-resolution original — decoding several full-size phone photos
    // at once just to paint 92px boxes is enough to crash mobile Safari.
    // Video still needs the real file to play, so that's unaffected.
    const blob = kind === "video" ? await MediaStore.getBlob(id) : await Thumbnail.getDisplayBlob(id);
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
    // Same reasoning as hydrateThumbnails: a month can show up to 31 of
    // these at once, so this must never be the full-resolution original.
    const blob = await Thumbnail.getDisplayBlob(node.dataset.mediaId);
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

// Walks back one year at a time from the selected date (as far as the
// oldest entry goes) and stacks a section for every past year that has
// a matching entry, rather than stopping at exactly one year back.
function renderOnThisDay() {
  onThisDayHeadingEl.textContent = "On this day";

  const selectedYear = Number(selectedDate.slice(0, 4));
  const oldestYear = entries.length ? Math.min(...entries.map((e) => Number(e.date.slice(0, 4)))) : selectedYear;

  let sectionsHtml = "";
  for (let yearsAgo = 1; selectedYear - yearsAgo >= oldestYear; yearsAgo++) {
    const targetDate = shiftYears(selectedDate, -yearsAgo);
    const matches = entries.filter((entry) => entry.date === targetDate);
    if (matches.length === 0) continue;

    sectionsHtml += `
      <div class="on-this-day-year">
        <h3 class="on-this-day-year-heading">${yearsAgo === 1 ? "One year ago" : `${yearsAgo} years ago`} — ${formatDateLong(targetDate)}</h3>
        <div class="entries-list">${matches.map(entryCardHtml).join("")}</div>
      </div>
    `;
  }

  if (!sectionsHtml) {
    onThisDayContentEl.innerHTML = `<p class="hint empty-state">No entries from this day in past years.</p>`;
    return;
  }

  onThisDayContentEl.innerHTML = sectionsHtml;
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

// --- export ---

const EXTENSION_BY_MIME = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/webp": "webp",
  "image/tiff": "tiff",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/x-msvideo": "avi",
};

function extensionForMime(mimeType) {
  return EXTENSION_BY_MIME[mimeType] || (mimeType || "").split("/")[1] || "bin";
}

// Cap on how much media (by original file size) goes into a single zip.
// Building one giant zip with everything means JSZip has to hold that
// whole assembled file in memory at once to produce a downloadable blob
// — for a large library (hundreds of photos/videos, easily hundreds of
// MB to multiple GB total) that alone is enough to exceed mobile
// Safari's per-tab memory budget and crash the page. Splitting into
// capped batches keeps every single zip's peak memory bounded.
const EXPORT_BATCH_MAX_BYTES = 100 * 1024 * 1024;

exportBtn.addEventListener("click", async () => {
  if (entries.length === 0) {
    exportStatusEl.textContent = "No entries to export yet.";
    return;
  }

  exportBtn.disabled = true;
  exportStatusEl.textContent = "Gathering entries…";
  exportDownloadsEl.innerHTML = "";
  lastExportObjectUrls.forEach((u) => URL.revokeObjectURL(u));
  lastExportObjectUrls = [];

  try {
    const today = todayStr();
    const downloads = []; // { url, filename, entryCount }

    let batchZip = new JSZip();
    let batchMediaFolder = batchZip.folder("media");
    let batchEntries = [];
    let batchBytes = 0;
    let mediaCount = 0;
    let missingCount = 0;

    async function finalizeBatch() {
      if (batchEntries.length === 0) return;
      const partNum = downloads.length + 1;
      exportStatusEl.textContent = `Zipping part ${partNum}…`;
      batchZip.file("entries.json", JSON.stringify(batchEntries, null, 2));
      const blob = await batchZip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      lastExportObjectUrls.push(url);
      downloads.push({ url, filename: `diary-export-${today}-part${partNum}.zip`, entryCount: batchEntries.length });

      batchZip = new JSZip();
      batchMediaFolder = batchZip.folder("media");
      batchEntries = [];
      batchBytes = 0;
    }

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      exportStatusEl.textContent = `Packing entry ${i + 1} of ${entries.length}…`;

      // Fetch this entry's own attachments (and total their size) before
      // deciding which batch it lands in, so an entry's media never gets
      // split across two different zips.
      const fetched = [];
      let entryBytes = 0;
      for (const att of entry.attachments) {
        const blob = await MediaStore.getBlob(att.id);
        if (!blob) {
          missingCount++;
          continue;
        }
        fetched.push({ att, blob });
        entryBytes += blob.size;
      }

      if (batchEntries.length > 0 && batchBytes + entryBytes > EXPORT_BATCH_MAX_BYTES) {
        await finalizeBatch();
      }

      for (const { att, blob } of fetched) {
        batchMediaFolder.file(`${att.id}.${extensionForMime(att.mimeType)}`, blob);
        mediaCount++;
      }
      batchBytes += entryBytes;
      batchEntries.push(entry);
    }
    await finalizeBatch();

    for (const dl of downloads) {
      const a = document.createElement("a");
      a.href = dl.url;
      a.download = dl.filename;
      a.className = "link-btn";
      a.textContent = `Download ${dl.filename} (${dl.entryCount} ${dl.entryCount === 1 ? "entry" : "entries"})`;
      exportDownloadsEl.appendChild(a);
    }

    // Auto-triggering a click is only attempted when there's a single
    // file to avoid several downloads firing back-to-back (browsers tend
    // to block that as spam) — and even then it may silently do nothing
    // on iOS Safari since this runs well past the original tap's
    // synchronous window. The links above are the reliable path either way.
    if (downloads.length === 1) {
      const a = document.createElement("a");
      a.href = downloads[0].url;
      a.download = downloads[0].filename;
      a.click();
    }

    const parts = [`Exported ${entries.length} ${entries.length === 1 ? "entry" : "entries"} and ${mediaCount} attachment(s)`];
    parts[0] += downloads.length > 1 ? ` across ${downloads.length} zip files.` : " as a zip file.";
    if (missingCount) parts.push(`${missingCount} attachment(s) weren't on this device and were skipped.`);
    parts.push("Tap each link below to download.");
    exportStatusEl.textContent = parts.join(" ");
  } catch (err) {
    exportStatusEl.textContent = `Export failed: ${err.message}`;
  } finally {
    exportBtn.disabled = false;
  }
});

// --- Day One import ---

dayOneImportBtn.addEventListener("click", async () => {
  const file = dayOneFileInput.files[0];
  if (!file) {
    dayOneImportStatusEl.textContent = "Choose a Day One export .zip file first.";
    return;
  }

  dayOneImportBtn.disabled = true;
  dayOneImportStatusEl.textContent = "Reading zip file…";

  try {
    const existingSourceIds = new Set(entries.filter((e) => e.sourceUuid).map((e) => e.sourceUuid));
    const result = await DayOneImport.importZipFile(file, {
      uidFn: uid,
      existingSourceIds,
      onProgress: (done, total) => {
        dayOneImportStatusEl.textContent = `Importing entry ${done} of ${total}…`;
      },
    });

    entries = entries.concat(result.entries);
    save();
    render();

    const parts = [`Imported ${result.entries.length} ${result.entries.length === 1 ? "entry" : "entries"} (${result.mediaImported} photos/videos).`];
    if (result.skipped) parts.push(`Skipped ${result.skipped} already-imported.`);
    if (result.mediaMissing) parts.push(`${result.mediaMissing} attachment(s) referenced in the export weren't found in the zip.`);
    dayOneImportStatusEl.textContent = parts.join(" ");
  } catch (err) {
    dayOneImportStatusEl.textContent = `Import failed: ${err.message}`;
  } finally {
    dayOneImportBtn.disabled = false;
    dayOneFileInput.value = "";
  }
});

function entryTimestamp(entry) {
  return entry.updatedAt || entry.createdAt || "";
}

// Merges the cloud's entries with whatever's already on this device by
// id, keeping whichever side of each entry was touched more recently
// rather than blindly replacing local with remote. Without this, entries
// written while offline (or written just before a reload, before the
// background sync push had a chance to reach the cloud) would silently
// vanish the next time the app booted and pulled an older cloud copy.
//
// Trade-off: this is a union merge with no deletion tracking, so an
// entry deleted on one device can reappear if another device merges in
// an older copy of it before that deletion has synced. An entry
// unexpectedly coming back is a far smaller problem for a diary than
// newly written entries silently disappearing, which is what this
// exists to prevent — so the merge favors keeping content over
// respecting a not-yet-synced deletion.
function mergeEntries(remoteEntries, localEntries) {
  const byId = new Map();
  for (const entry of remoteEntries) byId.set(entry.id, entry);
  for (const entry of localEntries) {
    const existing = byId.get(entry.id);
    if (!existing || entryTimestamp(entry) > entryTimestamp(existing)) {
      byId.set(entry.id, entry);
    }
  }
  return Array.from(byId.values());
}

// Pulls this user's cloud entries (if signed in) before the first render
// and merges them with whatever's already on this device (see
// mergeEntries above). Attachment blobs never leave this device's
// IndexedDB, so a returning device gets entry text/metadata but shows
// "not on this device" for any attachment made elsewhere.
async function bootDiaryApp() {
  const localEntriesAtBoot = entries;
  const remote = await SupaSync.pullState("diary");

  if (remote) {
    const remoteEntries = remote.entries || [];
    const merged = mergeEntries(remoteEntries, localEntriesAtBoot);
    entries = merged;
    if (JSON.stringify(merged) !== JSON.stringify(remoteEntries)) {
      // Merge surfaced something the cloud didn't have yet (an offline
      // write, or a newer local edit) — push the merged result back up
      // instead of leaving the cloud stale until some unrelated edit.
      save();
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    }
  }

  render();

  if (!remote) save();
}

SupaSync.mountAuthGate(document.getElementById("authGate"), () => {
  document.getElementById("app-content").style.display = "";
  bootDiaryApp();
});
