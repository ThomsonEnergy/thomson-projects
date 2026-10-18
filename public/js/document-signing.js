// Shared "review and sign" panel for onboarding documents, used by
// onboarding.html and policy-update.html. Draw a signature on a canvas,
// save it with the signer's name and a snapshot of exactly what they
// signed, then bake it into a PDF. Consent documents (consent_type set)
// also need an I agree / I don't agree answer; the answer is added to the
// snapshot so the signed PDF shows it, and a database trigger applies it
// to the person's consent (migration 20261018000000).

const CONSENT_ANSWER_TEXT = {
  agree: 'Answer: I agree',
  disagree: 'Answer: I do not agree',
};

// opts: { doc, bodyText, bodyHtml, profileId, defaultName, onSigned }
// bodyText is what gets saved as the snapshot; bodyHtml is what is shown
// (admin-written policy text is shown as is, contracts are escaped).
function openDocumentSignPanel(opts) {
  const { doc, bodyText, profileId, defaultName, onSigned } = opts;
  const bodyHtml = opts.bodyHtml != null ? opts.bodyHtml : bodyText;
  const isConsent = !!doc.consent_type;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100; padding:16px;';
  overlay.innerHTML = `
    <div class="card" style="max-width:560px; width:100%; max-height:90vh; overflow-y:auto;">
      <h2>${doc.title}</h2>
      <div class="ob-doc-body" style="white-space:pre-wrap; line-height:1.6; max-height:260px; overflow-y:auto; padding:14px; background:var(--surface-2); border-radius:8px; margin-bottom:14px;">${bodyHtml}</div>

      ${isConsent ? `
        <label style="margin-top:0">Your answer</label>
        <label style="display:flex; align-items:center; gap:8px; margin:6px 0; font-weight:400;">
          <input type="radio" name="sign-response" value="agree" style="width:auto;" /> I agree
        </label>
        <label style="display:flex; align-items:center; gap:8px; margin:6px 0 12px; font-weight:400;">
          <input type="radio" name="sign-response" value="disagree" style="width:auto;" /> I don't agree
        </label>
        <p class="subtitle" style="margin:0 0 12px;">Either answer is fine and has no effect on your job or pay. You can change it any time in Settings, My Profile.</p>
      ` : ''}

      <label style="margin-top:0">Your full name</label>
      <input id="sign-name-input" placeholder="Full name" value="${escapeHtml(defaultName || '')}" />

      <label>Signature</label>
      <canvas id="sign-canvas" width="460" height="150" style="border:1px solid var(--border); border-radius:8px; background:#fff; touch-action:none; width:100%; max-width:460px; height:150px; display:block;"></canvas>
      <button type="button" class="secondary" id="sign-clear-btn" style="margin-top:8px; font-size:12px; padding:6px 10px;">Clear signature</button>

      <div style="margin-top:14px; display:flex; gap:8px; flex-wrap:wrap;">
        <button id="sign-confirm-btn">Sign &amp; continue</button>
        <button type="button" class="secondary" id="sign-cancel-btn">Cancel</button>
      </div>
      <div id="sign-msg"></div>
    </div>`;
  document.body.appendChild(overlay);

  const canvas = overlay.querySelector('#sign-canvas');
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  let drawing = false, hasSignature = false;
  const pointerPos = (e) => {
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * (canvas.width / rect.width), y: (e.clientY - rect.top) * (canvas.height / rect.height) };
  };
  canvas.addEventListener('pointerdown', (e) => { drawing = true; hasSignature = true; const p = pointerPos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); });
  canvas.addEventListener('pointermove', (e) => { if (!drawing) return; const p = pointerPos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); });
  const stopDrawing = () => { drawing = false; };
  canvas.addEventListener('pointerup', stopDrawing);
  canvas.addEventListener('pointerleave', stopDrawing);
  overlay.querySelector('#sign-clear-btn').addEventListener('click', () => { ctx.clearRect(0, 0, canvas.width, canvas.height); hasSignature = false; });
  overlay.querySelector('#sign-cancel-btn').addEventListener('click', () => overlay.remove());

  overlay.querySelector('#sign-confirm-btn').addEventListener('click', async () => {
    const msg = overlay.querySelector('#sign-msg');
    const confirmBtn = overlay.querySelector('#sign-confirm-btn');
    const signedByName = overlay.querySelector('#sign-name-input').value.trim();
    const responseInput = overlay.querySelector('input[name="sign-response"]:checked');
    const response = isConsent ? (responseInput ? responseInput.value : null) : null;
    if (isConsent && !response) { msg.innerHTML = `<div class="error-box">Choose I agree or I don't agree.</div>`; return; }
    if (!signedByName) { msg.innerHTML = `<div class="error-box">Enter your name.</div>`; return; }
    if (!hasSignature) { msg.innerHTML = `<div class="error-box">Draw a signature.</div>`; return; }
    confirmBtn.disabled = true;
    const snapshot = response ? `${bodyText}\n\n${CONSENT_ANSWER_TEXT[response]}` : bodyText;
    const { data: newSig, error } = await supabaseClient.from('onboarding_document_signatures').insert({
      profile_id: profileId,
      document_id: doc.id,
      document_title_snapshot: doc.title,
      document_body_snapshot: snapshot,
      signature_data_url: canvas.toDataURL('image/png'),
      signed_by_name: signedByName,
      signed_at: new Date().toISOString(),
      ...(isConsent ? { response } : {}),
    }).select('id').single();
    if (error) { msg.innerHTML = `<div class="error-box">${escapeHtml(error.message)}</div>`; confirmBtn.disabled = false; return; }
    // Bakes the snapshot + signature + signer name/date into one PDF and
    // saves it to Storage. The page moves on whether or not it succeeds,
    // so a slow or failed render never blocks anyone.
    fetch('/.netlify/functions/generate-signed-document', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature_id: newSig.id }),
    }).catch(() => {});
    overlay.remove();
    if (onSigned) await onSigned(response);
  });
}
