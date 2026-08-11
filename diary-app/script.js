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
const searchDateFromInput = document.getElementById("search-date-from");
const searchDateToInput = document.getElementById("search-date-to");
const clearSearchBtn = document.getElementById("clear-search-btn");

const entriesListEl = document.getElementById("entries-list");
const entryCountEl = document.getElementById("entry-count");

entryDateInput.value = todayStr();

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

// --- search / filter ---

function filteredEntries() {
  const text = searchTextInput.value.trim().toLowerCase();
  const from = searchDateFromInput.value;
  const to = searchDateToInput.value;
  return entries.filter((entry) => {
    if (text && !entry.text.toLowerCase().includes(text) && !(entry.title || "").toLowerCase().includes(text)) {
      return false;
    }
    if (from && entry.date < from) return false;
    if (to && entry.date > to) return false;
    return true;
  });
}

[searchTextInput, searchDateFromInput, searchDateToInput].forEach((el) => el.addEventListener("input", render));

clearSearchBtn.addEventListener("click", () => {
  searchTextInput.value = "";
  searchDateFromInput.value = "";
  searchDateToInput.value = "";
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

function render() {
  revokeActiveListObjectUrls();
  const filtered = filteredEntries().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt.localeCompare(a.createdAt)));

  entryCountEl.textContent = `${filtered.length} ${filtered.length === 1 ? "entry" : "entries"}`;

  if (filtered.length === 0) {
    entriesListEl.innerHTML = `<p class="hint empty-state">${entries.length === 0 ? "No entries yet — write your first one above." : "No entries match your search."}</p>`;
    return;
  }

  entriesListEl.innerHTML = filtered.map(entryCardHtml).join("");
  hydrateThumbnails(entriesListEl);
}

entriesListEl.addEventListener("click", (e) => {
  const editBtn = e.target.closest(".edit-entry-btn");
  if (editBtn) return startEdit(editBtn.dataset.id);
  const deleteBtn = e.target.closest(".delete-entry-btn");
  if (deleteBtn) return deleteEntry(deleteBtn.dataset.id);
});

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
