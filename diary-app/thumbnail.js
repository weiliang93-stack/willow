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
  // All thumbnail display boxes in this app are 92 CSS px, cropped to a
  // square via object-fit: cover — meaning it's the SHORTER edge of the
  // source image that actually fills the box, and on a 3x retina phone
  // that needs ~276 real pixels to look crisp. Capping the *longer* edge
  // (the original approach) starves the shorter edge for anything wider
  // than roughly 4:3, which is exactly what read as "pixelated" for
  // widescreen photos. So: guarantee the shorter edge, then cap the
  // longer edge separately so an extreme aspect ratio (a panorama, say)
  // doesn't balloon back up toward original size.
  const MIN_SHORT_EDGE = 400;
  const MAX_LONG_EDGE = 1000;
  const QUALITY = 0.85;

  // Bumping either constant above should also bump this suffix, so
  // thumbnails cached under the old, smaller sizing get regenerated
  // instead of silently staying blurry forever.
  const THUMB_KEY_SUFFIX = "::thumb:v2";
  const LEGACY_THUMB_KEY_SUFFIX = "::thumb";

  function thumbKey(id) {
    return `${id}${THUMB_KEY_SUFFIX}`;
  }

  async function generateThumbnail(sourceBlob) {
    const bitmap = await createImageBitmap(sourceBlob);
    try {
      const shortEdge = Math.min(bitmap.width, bitmap.height);
      const longEdge = Math.max(bitmap.width, bitmap.height);

      let scale = MIN_SHORT_EDGE / shortEdge;
      if (longEdge * scale > MAX_LONG_EDGE) scale = MAX_LONG_EDGE / longEdge;
      scale = Math.min(scale, 1); // never upscale a source smaller than our targets

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
    MediaStore.deleteBlob(`${id}${LEGACY_THUMB_KEY_SUFFIX}`);
    return MediaStore.deleteBlob(thumbKey(id));
  }

  window.Thumbnail = { getDisplayBlob, deleteDisplayBlob };
})();
