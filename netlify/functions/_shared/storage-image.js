// A picture in the app's own storage, resized by Supabase on the way out (the render endpoint),
// so a page, a PDF or a model never downloads the original. The same rule as supaImageVariant in
// public/js/supabase-client.js. Anything that is not a public storage URL comes back as it was.
//   renderedImageUrl(url, { width, height, quality }) -> url
//     width only: the picture is scaled to that width (a cover photo). width and height: a box
//     the whole picture fits in (resize=contain), since width alone would crop a tall photo.
const STORAGE_PUBLIC = '/storage/v1/object/public/';

function renderedImageUrl(url, { width, height, quality = 70 } = {}) {
  const u = String(url || '');
  const i = u.indexOf(STORAGE_PUBLIC);
  if (i === -1) return url;
  const path = u.slice(i + STORAGE_PUBLIC.length).split('?')[0];
  const box = height ? `width=${width}&height=${height}&resize=contain` : `width=${width}`;
  return `${u.slice(0, i)}/storage/v1/render/image/public/${path}?${box}&quality=${quality}`;
}

module.exports = { renderedImageUrl, STORAGE_PUBLIC };
