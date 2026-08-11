// IndexedDB-backed storage for diary attachment blobs (photos/videos).
//
// Entry metadata (title, text, date, and each attachment's id/name/type)
// lives in localStorage and syncs via SupaSync like the other willow apps.
// The actual media bytes do not — a video can easily be tens of MB, far
// past what's sane for localStorage or a synced JSON blob — so they're
// kept here, in this browser's IndexedDB only. An entry opened on a
// different device will show its text but a "not available on this
// device" placeholder for attachments made elsewhere.
(function () {
  const DB_NAME = "diaryAppMedia";
  const STORE_NAME = "attachments";
  const DB_VERSION = 1;

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE_NAME);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function putBlob(id, blob) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(blob, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getBlob(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteBlob(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  window.MediaStore = { putBlob, getBlob, deleteBlob };
})();
