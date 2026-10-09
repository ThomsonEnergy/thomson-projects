// Shows an email from the shared inbox the way it was meant to look: the formatted
// (HTML) version in a locked-down box, inline pictures filled in, remote pictures
// hidden until you ask (or "Always show pictures"), photos attached to the email shown
// straight away as thumbnails, and other attachments listed to open or download.
//
// Safety, in layers: the HTML is cleaned (scripts, forms, event handlers removed); it is
// shown inside an iframe with no script permission; and that iframe has its own content
// policy that blocks every network request except (when you press "Show images")
// pictures. So a sender cannot run code, and cannot track you with a hidden picture
// unless you choose to load them.
//
// Needs supabase-client.js (escapeHtml, openPhotoLightbox).

// "Always show pictures" is a per-browser preference
function emailAlwaysShowPictures(set) {
  try {
    if (set === undefined) return localStorage.getItem('te_email_show_pictures') === '1';
    localStorage.setItem('te_email_show_pictures', set ? '1' : '0');
  } catch (e) { /* storage blocked: just not remembered */ }
  return !!set;
}

function emailLinkify(escaped) {
  return escaped.replace(/(https?:\/\/[^\s<>"')]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

// Returns { html, styles, blocked } - cleaned markup for the iframe.
function emailSanitize(rawHtml, { allowImages = false, cidMap = {} } = {}) {
  const doc = new DOMParser().parseFromString(String(rawHtml || ''), 'text/html');
  doc.querySelectorAll('script, iframe, frame, frameset, object, embed, applet, form, link, meta, base, noscript, audio, video, source, template').forEach(n => n.remove());
  const dangerousUrl = /^\s*(javascript|vbscript|data:text\/html)/i;
  doc.querySelectorAll('*').forEach(el => {
    [...el.attributes].forEach(a => {
      const n = a.name.toLowerCase();
      if (n.startsWith('on') || n === 'srcdoc' || n === 'formaction' || n === 'action') { el.removeAttribute(a.name); return; }
      if ((n === 'href' || n === 'src' || n === 'xlink:href' || n === 'background') && dangerousUrl.test(a.value)) el.removeAttribute(a.name);
      if (n === 'style') {
        let v = a.value.replace(/expression\s*\(/gi, '(').replace(/@import[^;]*;?/gi, '');
        if (!allowImages) v = v.replace(/url\([^)]*\)/gi, 'none');
        el.setAttribute('style', v);
      }
    });
  });
  doc.querySelectorAll('a[href]').forEach(a => { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer'); });

  let blocked = 0;
  doc.querySelectorAll('img').forEach(img => {
    const src = (img.getAttribute('src') || '').trim();
    if (/^cid:/i.test(src)) {
      const key = decodeURIComponent(src.slice(4)).toLowerCase();
      if (cidMap[key]) img.setAttribute('src', cidMap[key]); else img.removeAttribute('src');
    } else if (/^(https?:)?\/\//i.test(src)) {
      if (!allowImages) { img.removeAttribute('src'); img.removeAttribute('srcset'); blocked += 1; }
    } else if (!/^data:image\//i.test(src)) {
      img.removeAttribute('src');
    }
    img.removeAttribute('srcset');
  });
  doc.querySelectorAll('[background]').forEach(el => el.removeAttribute('background'));

  const styles = [...doc.querySelectorAll('style')].map(st => {
    let css = st.textContent.replace(/@import[^;]*;?/gi, '').replace(/expression\s*\(/gi, '(');
    if (!allowImages) css = css.replace(/url\([^)]*\)/gi, 'none');
    st.remove();
    return `<style>${css}</style>`;
  }).join('');
  return { html: doc.body.innerHTML, styles, blocked };
}

function emailFrameDoc({ html, styles }, allowImages) {
  const csp = `default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data: ${allowImages ? 'https: http:' : ''}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank">
<style>body{font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;color:#222;background:#fff;margin:12px;word-wrap:break-word;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}a{color:#1a56c4}blockquote{margin:8px 0 8px 4px;padding-left:10px;border-left:3px solid #ccc;color:#555}</style>${styles}</head><body>${html}</body></html>`;
}

const emailFileSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

// Opens one attachment: pictures in the photo viewer, PDFs in a new tab, anything else downloads.
async function emailOpenAttachment(emailId, att, ctx) {
  try {
    const f = att.storage ? await ctx.fetchStored(att) : await ctx.fetchAttachment(emailId, att.part_id);
    const bytes = Uint8Array.from(atob(f.data), c => c.charCodeAt(0));
    if (/^image\//i.test(f.mime) && typeof openPhotoLightbox === 'function') {
      openPhotoLightbox([`data:${f.mime};base64,${f.data}`], 0);
    } else {
      const url = URL.createObjectURL(new Blob([bytes], { type: f.mime }));
      if (/pdf/i.test(f.mime)) window.open(url, '_blank');
      else { const a = document.createElement('a'); a.href = url; a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  } catch (err) { alert(err.message); }
}

// ctx.fetchAttachment(emailId, partId) -> { name, mime, data(base64) }   (received mail, from Gmail)
// ctx.fetchStored(attachment)          -> { name, mime, data(base64) }   (mail we sent, from storage)
async function mountEmailBody(el, email, ctx) {
  if (!el) return;
  const attachments = Array.isArray(email.attachments) ? email.attachments : [];
  const referenced = new Set();

  if (!email.body_html) {
    el.innerHTML = `<div style="white-space:pre-wrap; word-wrap:break-word; line-height:1.5;">${emailLinkify(escapeHtml(email.body_text || ''))}</div>`;
  } else {
    el.innerHTML = `<div class="email-images-bar" style="display:none; margin-bottom:6px; font-size:12px;"></div><iframe class="email-frame" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" style="width:100%; height:80px; border:0; border-radius:8px; background:#fff; display:block;"></iframe>`;
    const frame = el.querySelector('iframe'), bar = el.querySelector('.email-images-bar');
    let allow = emailAlwaysShowPictures();
    const cidMap = {};

    // inline pictures that sit inside the email itself
    const cids = [...String(email.body_html).matchAll(/cid:([^"'\s)>]+)/gi)].map(m => decodeURIComponent(m[1]).toLowerCase());
    const inlineParts = attachments.filter(a => a.cid && cids.includes(String(a.cid).toLowerCase()) && /^image\//i.test(a.mime || '') && (a.size || 0) < 1500000).slice(0, 8);
    inlineParts.forEach(a => referenced.add(a.part_id));

    const fit = () => {
      try {
        const d = frame.contentDocument;
        if (d && d.body) frame.style.height = Math.min(Math.ceil(d.body.getBoundingClientRect().height) + 28, 20000) + 'px'; // the body's own height, not the frame's, so it can shrink as well as grow
      } catch (e) { /* not readable: keep the height we have */ }
    };
    const render = () => {
      const clean = emailSanitize(email.body_html, { allowImages: allow, cidMap });
      frame.srcdoc = emailFrameDoc(clean, allow);
      if (clean.blocked && !allow) {
        bar.style.display = 'block';
        bar.innerHTML = `<span style="color:var(--muted);">Pictures from the internet are hidden.</span> <button type="button" class="secondary" style="font-size:12px; padding:3px 10px;">Show pictures</button> <label style="display:inline-flex; gap:4px; align-items:center; margin:0 0 0 8px; font-weight:normal;"><input type="checkbox" style="width:auto;" /> always</label>`;
        bar.querySelector('button').addEventListener('click', () => {
          if (bar.querySelector('input').checked) emailAlwaysShowPictures(true);
          allow = true; bar.style.display = 'none'; render();
        });
      }
    };
    frame.addEventListener('load', () => {
      fit();
      try { frame.contentDocument.querySelectorAll('img').forEach(i => i.addEventListener('load', fit)); } catch (e) { /* fine */ }
      setTimeout(fit, 300); setTimeout(fit, 1200);
    });
    render();
    if (inlineParts.length && ctx && ctx.fetchAttachment) {
      Promise.all(inlineParts.map(async a => {
        try { const f = await ctx.fetchAttachment(email.id, a.part_id); cidMap[String(a.cid).toLowerCase()] = `data:${f.mime};base64,${f.data}`; } catch (e) { /* picture just stays blank */ }
      })).then(() => { if (Object.keys(cidMap).length) render(); });
    }
  }

  // attachments to open or download (not the pictures already shown inside the email)
  const files = attachments.filter(a => !referenced.has(a.part_id) && !(a.inline && a.cid && String(email.body_html || '').toLowerCase().includes('cid:' + String(a.cid).toLowerCase())));
  const isPhoto = (a) => /^image\/(jpeg|jpg|png|gif|webp)$/i.test(a.mime || '') && (a.size || 0) <= 4 * 1024 * 1024 && (a.size || 0) > 3000;
  const photos = (ctx && (ctx.fetchAttachment || ctx.fetchStored) ? files.filter(isPhoto) : []).slice(0, 12);
  const chips = files.filter(a => !photos.includes(a));
  if (photos.length) {
    const grid = document.createElement('div');
    grid.style.cssText = 'margin-top:10px; display:flex; flex-wrap:wrap; gap:8px;';
    grid.innerHTML = photos.map(a => `<div class="email-photo" style="width:150px; height:112px; border:1px solid var(--border); border-radius:8px; overflow:hidden; display:flex; align-items:center; justify-content:center; font-size:11px; color:var(--muted); text-align:center; padding:4px; cursor:pointer;" title="${escapeHtml(a.name)}">Loading ${escapeHtml(a.name)}...</div>`).join('');
    el.appendChild(grid);
    const urls = new Array(photos.length).fill(null);
    const cells = [...grid.querySelectorAll('.email-photo')];
    const load = async (i) => {
      const a = photos[i];
      try {
        const f = a.storage ? await ctx.fetchStored(a) : await ctx.fetchAttachment(email.id, a.part_id);
        urls[i] = `data:${f.mime};base64,${f.data}`;
        cells[i].style.padding = '0';
        cells[i].innerHTML = `<img src="${urls[i]}" alt="${escapeHtml(a.name)}" style="width:100%; height:100%; object-fit:cover; display:block;" />`;
      } catch (e) {
        cells[i].textContent = a.name + ' (could not load - click to retry)';
        cells[i].dataset.failed = '1';
      }
    };
    cells.forEach((cell, i) => cell.addEventListener('click', async () => {
      if (cell.dataset.failed) { cell.dataset.failed = ''; cell.textContent = 'Loading...'; await load(i); return; }
      const ready = urls.map((u, k) => ({ u, k })).filter(x => x.u);
      const at = ready.findIndex(x => x.k === i);
      if (at >= 0 && typeof openPhotoLightbox === 'function') openPhotoLightbox(ready.map(x => x.u), at);
    }));
    (async () => { for (let i = 0; i < photos.length; i += 3) await Promise.all(photos.slice(i, i + 3).map((_, j) => load(i + j))); })();
  }
  if (chips.length) {
    const box = document.createElement('div');
    box.style.cssText = 'margin-top:10px; display:flex; flex-wrap:wrap; gap:8px;';
    box.innerHTML = chips.map(a => `<button type="button" class="secondary email-att" data-idx="${attachments.indexOf(a)}" style="font-size:12px; padding:6px 10px; max-width:100%;">&#128206; ${escapeHtml(a.name)} <span style="color:var(--muted);">(${emailFileSize(a.size || 0)})</span></button>`).join('');
    el.appendChild(box);
    box.querySelectorAll('.email-att').forEach(btn => btn.addEventListener('click', async () => {
      const original = btn.innerHTML; btn.disabled = true; btn.textContent = 'Opening...';
      await emailOpenAttachment(email.id, attachments[Number(btn.dataset.idx)], ctx);
      btn.disabled = false; btn.innerHTML = original;
    }));
  }
}
