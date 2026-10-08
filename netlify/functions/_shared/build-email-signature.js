// Builds the HTML (and plain-text fallback) email signature appended to
// everything sent from the shared inbox. Generated from existing profile
// and company data rather than a hand-pasted blob, so a new logo or
// licence number updates every staff signature at once.
//
// Images (logo, profile photo) are plain absolute URLs, so an animated
// GIF uploaded as either one plays in Gmail and most mail apps. Outlook
// desktop shows only the first frame of a GIF - that's an Outlook
// limitation, nothing to do with how it's built here.
//
// Table-based inline-styled HTML on purpose: email clients ignore most
// modern CSS.

const NAVY = '#0b0b6b';
const BADGE = '#4a6285';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function withScheme(url) {
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function badge(url, label) {
  if (!url) return '';
  return `<td style="padding-right:14px;"><a href="${esc(withScheme(url))}" style="text-decoration:none;"><table cellpadding="0" cellspacing="0" border="0"><tr><td width="30" height="30" align="center" valign="middle" style="width:30px; height:30px; background:${BADGE}; border-radius:15px; color:#ffffff; font:bold 13px Arial,sans-serif;">${label}</td></tr></table></a></td>`;
}

function buildSignature(person, company) {
  const mobile = person.mobile || company.phone || '';
  const licences = (company.licenses || '').split('|').map(s => s.trim()).filter(Boolean);
  const mapsUrl = company.address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(company.address)}`
    : '';
  const showPhoto = person.photoUrl && person.includePhoto !== false;

  const photoCell = showPhoto
    ? `<td valign="top" style="padding-right:14px;"><img src="${esc(person.photoUrl)}" width="76" height="76" alt="${esc(person.fullName)}" style="display:block; width:76px; height:76px; border-radius:38px; object-fit:cover;" /></td>`
    : '';

  const socials = [
    badge(company.social_facebook, 'f'),
    badge(company.social_instagram, 'ig'),
    badge(company.social_linkedin, 'in'),
  ].join('');

  const html = `
<div style="font-family:Arial,Helvetica,sans-serif; color:#222222;">
  <p style="margin:24px 0 18px; font:italic 14px Arial,sans-serif; color:${NAVY};">Kind regards,</p>
  <table cellpadding="0" cellspacing="0" border="0"><tr>
    ${photoCell}
    <td valign="middle">
      <div style="font:bold 17px Arial,sans-serif; color:${NAVY};">${esc(person.fullName)}</div>
      ${person.jobTitle ? `<div style="font:14px Georgia,'Times New Roman',serif; color:#222222; margin-top:2px;">${esc(person.jobTitle)}</div>` : ''}
      ${person.credentials ? `<div style="font:11px Georgia,'Times New Roman',serif; color:#222222; margin-top:3px;">${esc(person.credentials)}</div>` : ''}
    </td>
  </tr></table>
  <table cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;"><tr>
    ${company.logo_url ? `<td valign="bottom" style="padding-right:30px;"><img src="${esc(company.logo_url)}" width="240" alt="${esc(company.company_name || 'Logo')}" style="display:block; width:240px; height:auto;" /></td>` : ''}
    <td valign="bottom" style="font:12px Arial,sans-serif; color:#222222; line-height:1.5;">
      ${mobile ? `<div><b style="color:${NAVY};">Mobile:</b> ${esc(mobile)}</div>` : ''}
      ${person.email ? `<div><b style="color:${NAVY};">Email:</b> <a href="mailto:${esc(person.email)}" style="color:#0b3d91;">${esc(person.email)}</a></div>` : ''}
      ${company.address ? `<div style="margin-top:4px;"><a href="${esc(mapsUrl)}" style="color:#0b3d91;">${esc(company.address)}</a></div>` : ''}
      ${company.website ? `<div style="margin-top:8px;"><a href="${esc(withScheme(company.website))}" style="color:#0b3d91;">${esc(company.website)}</a></div>` : ''}
      ${licences.length ? `<div style="margin-top:8px; font-family:Georgia,'Times New Roman',serif;">${licences.map(esc).join('<br/>')}</div>` : ''}
      ${socials ? `<table cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;"><tr>${socials}</tr></table>` : ''}
    </td>
  </tr></table>
</div>`;

  const text = [
    'Kind regards,',
    '',
    person.fullName,
    person.jobTitle,
    person.credentials,
    '',
    mobile && `Mobile: ${mobile}`,
    person.email && `Email: ${person.email}`,
    company.address,
    company.website,
    licences.join('\n'),
  ].filter(v => v !== undefined && v !== null && v !== false).join('\n').replace(/\n{3,}/g, '\n\n');

  return { html, text };
}

function plainTextToHtml(text) {
  return `<div style="font-family:Arial,Helvetica,sans-serif; font-size:14px; line-height:1.5; color:#222222;">${esc(text).replace(/\r?\n/g, '<br/>')}</div>`;
}

// Loads the signed-in staff member's profile plus company details and
// builds their signature - shared by the send path and the Settings preview
// so what's previewed is exactly what gets sent.
async function signatureForUser(supabaseAdmin, user) {
  const [{ data: profile }, { data: company }] = await Promise.all([
    supabaseAdmin.from('profiles')
      .select('full_name, job_title, mobile_number, photo_url, email_signature, email_signature_include_photo')
      .eq('id', user.id).single(),
    supabaseAdmin.from('company_settings')
      .select('company_name, phone, address, website, licenses, logo_url, social_facebook, social_instagram, social_linkedin')
      .eq('id', 1).single(),
  ]);
  const sig = buildSignature({
    fullName: profile?.full_name || 'Thomson Energy Sales',
    jobTitle: profile?.job_title,
    credentials: profile?.email_signature,
    mobile: profile?.mobile_number,
    email: user.email,
    photoUrl: profile?.photo_url,
    includePhoto: profile?.email_signature_include_photo,
  }, company || {});
  return { ...sig, fullName: profile?.full_name };
}

module.exports = { buildSignature, plainTextToHtml, signatureForUser };
