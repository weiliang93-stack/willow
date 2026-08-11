// One-time importer for a Day One "Export Day One JSON (.zip)" file.
// Parses the bundled JSON, matches each entry's photos/videos to the
// files packed alongside it in the zip, and hands back plain diary-app
// entry objects (with attachment blobs already written to MediaStore)
// ready to merge into `entries`.
//
// Kept separate from script.js since Day One's export format is a
// self-contained chunk of parsing logic script.js doesn't otherwise need.
(function () {
  const PHOTO_MIME = {
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    heic: "image/heic",
    heif: "image/heif",
    webp: "image/webp",
    tiff: "image/tiff",
  };
  const VIDEO_MIME = {
    mp4: "video/mp4",
    mov: "video/quicktime",
    m4v: "video/mp4",
    avi: "video/x-msvideo",
  };

  // Day One embeds inline photo/video refs in the markdown text like
  // ![](dayone-moment://<identifier>). diary-app shows attachments
  // separately below the entry text rather than rendering markdown, so
  // strip these placeholders instead of leaving raw syntax behind.
  function cleanText(text) {
    return (text || "")
      .replace(/!\[\]\(dayone-moment:\/\/[a-f0-9]+\)/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // Converts a UTC creationDate to the "YYYY-MM-DD" the entry's own
  // timeZone would have shown, so an 11pm entry doesn't land on the
  // wrong day after UTC conversion. Falls back to a plain UTC slice if
  // the zone name is missing or unrecognized.
  function localDateFromIso(isoString, timeZone) {
    const d = new Date(isoString);
    if (timeZone) {
      try {
        const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).formatToParts(d);
        const get = (type) => parts.find((p) => p.type === type).value;
        return `${get("year")}-${get("month")}-${get("day")}`;
      } catch {
        // Unknown/invalid IANA zone name — fall through to UTC below.
      }
    }
    return d.toISOString().slice(0, 10);
  }

  // Maps lowercase base filename -> zip path across the whole archive,
  // so photo/video entries can be matched by md5 or identifier without
  // depending on an exact "photos/" / "videos/" folder layout (Day
  // One's export structure has shifted slightly across app versions).
  function buildFileIndex(zip) {
    const index = new Map();
    zip.forEach((relPath, file) => {
      if (file.dir) return;
      const base = relPath.split("/").pop().split(".")[0].toLowerCase();
      index.set(base, relPath);
    });
    return index;
  }

  async function extractAttachments(zip, fileIndex, items, mimeTable, kind, uidFn, onMediaImported) {
    const attachments = [];
    let missing = 0;
    for (const item of items || []) {
      const key = String(item.md5 || item.identifier || "").toLowerCase();
      const path = fileIndex.get(key);
      if (!path) {
        missing++;
        continue;
      }
      const blob = await zip.file(path).async("blob");
      const id = uidFn();
      const mimeType = mimeTable[String(item.type || "").toLowerCase()] || blob.type || "application/octet-stream";
      await MediaStore.putBlob(id, blob);
      attachments.push({ id, name: path.split("/").pop(), mimeType, kind });
      if (onMediaImported) onMediaImported();
    }
    return { attachments, missing };
  }

  // `existingSourceIds`: a Set of Day One uuids already present in this
  // app's entries (via their `sourceUuid` field), so re-running an
  // import on the same export doesn't create duplicates.
  async function importZipFile(file, { uidFn, existingSourceIds, onProgress } = {}) {
    const zip = await JSZip.loadAsync(file);

    const jsonPath = Object.keys(zip.files).find((name) => name.toLowerCase().endsWith(".json") && !zip.files[name].dir);
    if (!jsonPath) throw new Error("No .json file found inside the zip — is this a Day One JSON export?");

    const data = JSON.parse(await zip.file(jsonPath).async("string"));
    const sourceEntries = data.entries || [];
    const fileIndex = buildFileIndex(zip);

    const result = { entries: [], skipped: 0, mediaImported: 0, mediaMissing: 0, total: sourceEntries.length };

    for (let i = 0; i < sourceEntries.length; i++) {
      const src = sourceEntries[i];
      if (onProgress) onProgress(i + 1, result.total);

      if (existingSourceIds && src.uuid && existingSourceIds.has(src.uuid)) {
        result.skipped++;
        continue;
      }

      const photoResult = await extractAttachments(zip, fileIndex, src.photos, PHOTO_MIME, "image", uidFn, () => result.mediaImported++);
      const videoResult = await extractAttachments(zip, fileIndex, src.videos, VIDEO_MIME, "video", uidFn, () => result.mediaImported++);
      result.mediaMissing += photoResult.missing + videoResult.missing;

      result.entries.push({
        id: uidFn(),
        date: localDateFromIso(src.creationDate, src.timeZone),
        title: "",
        text: cleanText(src.text) || "(No text)",
        attachments: [...photoResult.attachments, ...videoResult.attachments],
        createdAt: src.creationDate || new Date().toISOString(),
        sourceUuid: src.uuid || null,
      });
    }

    return result;
  }

  window.DayOneImport = { importZipFile };
})();
