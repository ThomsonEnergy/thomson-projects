// Zip download for shared licences / insurance (team.html and the public
// share-licences.html page). Standalone: needs nothing from supabase-client.js.
// JSZip is only fetched when someone actually asks for a zip.

let _jsZipPromise = null;
function loadJsZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  if (!_jsZipPromise) {
    _jsZipPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
      s.onload = () => resolve(window.JSZip);
      s.onerror = () => { _jsZipPromise = null; reject(new Error('Could not load the zip tool. Check your connection and try again.')); };
      document.head.appendChild(s);
    });
  }
  return _jsZipPromise;
}

const licSafeName = (s) => String(s || 'file').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'file';
const licCsv = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;

// items: [{ group, name, kind, number, provider, expiry, ext, url }]
// url may be null (a record with no file attached) - it still appears in the index.
async function downloadLicenceZip(items, zipName, onProgress) {
  const JSZip = await loadJsZip();
  const zip = new JSZip();
  const used = new Set();
  const index = [['Group', 'Name', 'Type', 'Number', 'Provider', 'Expiry', 'File in this zip'].map(licCsv).join(',')];
  let done = 0;
  const withFile = items.filter(i => i.url).length;
  for (const it of items) {
    let zipPath = '';
    if (it.url) {
      const ext = it.ext ? '.' + String(it.ext).replace(/[^a-z0-9]/gi, '') : '';
      const folder = it.group === 'Company' ? 'Company' : `Employees/${licSafeName(it.group)}`;
      let base = `${folder}/${licSafeName(it.name)}`, candidate = base + ext, n = 2;
      while (used.has(candidate.toLowerCase())) candidate = `${base} (${n++})${ext}`;
      used.add(candidate.toLowerCase());
      const res = await fetch(it.url);
      if (!res.ok) throw new Error(`Could not fetch "${it.name}" (${res.status}). The link may have expired, refresh the page and try again.`);
      zip.file(candidate, await res.blob());
      zipPath = candidate;
      if (onProgress) onProgress(++done, withFile);
    }
    index.push([it.group, it.name, it.kind || '', it.number || '', it.provider || '', it.expiry || '', zipPath || '(no file uploaded)'].map(licCsv).join(','));
  }
  zip.file('Index.csv', index.join('\r\n'));
  const blob = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url; a.download = licSafeName(zipName || 'Licences and insurance') + '.zip';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
