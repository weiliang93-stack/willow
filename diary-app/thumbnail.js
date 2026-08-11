// Generates and caches small downscaled thumbnails for image attachments.
//
// Every thumbnail-rendering spot in this app (calendar tiles, entry cards)
// used to hand the full-resolution original straight to <img>/background-
// image. A phone photo is often several MB at 3000+ px — decoding a dozen
// or two of those simultaneously just to paint tiny boxes (a month of
// calendar tiles, a busy day's entries) is enough to crash mobile Safari
// under memory pressure. So: shrink once, cache forever, display the
// cached copy everywhere. Full-resolution originals are untouched in
// MediaStore — export and anything needing full fidelity still reads
// those directly. Videos aren't thumbnailed here.
(function () {
  const MAX_DIMENSION = 360;
  const QUALITY = 0.8;

  function thumbKey(id) {
    return `${id}::thumb`;
  }

  async function generateThumbnail(sourceBlob) {
    const bitmap = await createImageBitmap(sourceBlob);
    try {
      const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);

      return await new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("canvas.toBlob failed"))), "image/jpeg", QUALITY);
      });
    } finally {
      bitmap.close();
    }
  }

  // Returns a small display-ready blob for an image attachment: the
  // cached thumbnail if one exists already, otherwise generates one from
  // the full-resolution original and caches it for next time. Falls back
  // to the original blob if thumbnailing isn't possible (e.g. a HEIC
  // photo in a browser that can't decode HEIC at all).
  async function getDisplayBlob(id) {
    const cached = await MediaStore.getBlob(thumbKey(id));
    if (cached) return cached;

    const original = await MediaStore.getBlob(id);
    if (!original) return null;

    try {
      const thumb = await generateThumbnail(original);
      await MediaStore.putBlob(thumbKey(id), thumb);
      return thumb;
    } catch {
      return original;
    }
  }

  function deleteDisplayBlob(id) {
    return MediaStore.deleteBlob(thumbKey(id));
  }

  window.Thumbnail = { getDisplayBlob, deleteDisplayBlob };
})();
