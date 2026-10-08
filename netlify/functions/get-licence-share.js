const { getAdminClient } = require('./_shared/require-admin');

// GET /.netlify/functions/get-licence-share?token=<uuid>
//
// Public (no login) - this is what the share-licences.html page calls. The
// secret is the unguessable token in the link. Returns the CURRENT insurance /
// licence records the link was made for, with short-lived (1 hour) signed
// links to each certificate file, so nothing in storage is ever public. A
// revoked or expired link returns nothing but a plain "no longer available".

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method not allowed' };
  const token = (event.queryStringParameters || {}).token || '';
  if (!UUID.test(token)) return json(404, { ok: false, error: 'This link is not valid.' });

  try {
    const supabaseAdmin = getAdminClient();
    const { data: share, error } = await supabaseAdmin.from('licence_shares').select('*').eq('token', token).maybeSingle();
    if (error) throw error;
    if (!share || share.revoked) return json(404, { ok: false, error: 'This link is no longer available.' });
    if (share.expires_at && new Date(share.expires_at) < new Date()) return json(410, { ok: false, error: 'This link has expired. Ask Thomson Energy for a new one.' });

    const [{ data: credentials }, { data: licences }, { data: company }] = await Promise.all([
      share.company_credential_ids.length
        ? supabaseAdmin.from('company_credentials').select('id, credential_type, name, provider, reference_number, expiry_date, file_path, file_name').in('id', share.company_credential_ids)
        : Promise.resolve({ data: [] }),
      share.employee_licence_ids.length
        ? supabaseAdmin.from('profile_licences').select('id, profile_id, licence_name, licence_number, expiry_date, file_path, file_name, profiles(full_name)').in('id', share.employee_licence_ids)
        : Promise.resolve({ data: [] }),
      supabaseAdmin.from('company_settings').select('company_name, abn, phone, website').limit(1).maybeSingle(),
    ]);

    const paths = [...(credentials || []), ...(licences || [])].map(r => r.file_path).filter(Boolean);
    const urls = {};
    if (paths.length) {
      const { data: signed } = await supabaseAdmin.storage.from('project-documents').createSignedUrls(paths, 3600);
      (signed || []).forEach(s => { if (s.signedUrl) urls[s.path] = s.signedUrl; });
    }
    const ext = (name, path) => ((name || path || '').split('.').pop() || '').toLowerCase().slice(0, 5);

    const items = [
      ...(credentials || []).map(c => ({
        group: 'Company', kind: c.credential_type, name: c.name, provider: c.provider, number: c.reference_number, expiry: c.expiry_date,
        file_name: c.file_name, file_ext: ext(c.file_name, c.file_path), url: c.file_path ? urls[c.file_path] || null : null,
      })),
      ...(licences || []).map(l => ({
        group: (l.profiles && l.profiles.full_name) || 'Employee', kind: 'licence', name: l.licence_name, provider: null, number: l.licence_number, expiry: l.expiry_date,
        file_name: l.file_name, file_ext: ext(l.file_name, l.file_path), url: l.file_path ? urls[l.file_path] || null : null,
      })),
    ];

    await supabaseAdmin.from('licence_shares').update({ view_count: (share.view_count || 0) + 1, last_viewed_at: new Date().toISOString() }).eq('id', share.id);

    return json(200, {
      ok: true, label: share.label || null, expires_at: share.expires_at,
      company: company ? { name: company.company_name, abn: company.abn, phone: company.phone, website: company.website } : null,
      items,
    });
  } catch (err) {
    console.error('get-licence-share failed:', err);
    return json(500, { ok: false, error: 'Something went wrong loading this link. Please try again.' });
  }
};
