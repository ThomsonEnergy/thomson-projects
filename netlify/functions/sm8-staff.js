// POST /.netlify/functions/sm8-staff
// Body: {} to list, or { links: [{ sm8StaffUuid, profileId|null }] } to save.
// Admin only. Matches each ServiceM8 staff member to a TEops person, so the
// ServiceM8 import (sm8-copy-attachments-background.js) can put their
// check-ins on the right person and say who ticked off each checklist item.
// The match is saved in profiles.sm8_staff_uuid (migration 20261021000000).
// Listing suggests a match (saved one, then email, mobile, name) but saves
// nothing; only pressing Save does. Only reads from ServiceM8.

const { requireAdmin } = require('./_shared/require-admin');
const { getIntegrationKey } = require('./_shared/get-integration-key');
const { sm8GetAll } = require('./_shared/sm8-import');

const normEmail = (s) => String(s || '').trim().toLowerCase();
function normPhone(s) {
  const digits = String(s || '').replace(/\D/g, '');
  return digits.length >= 8 ? digits.slice(-9) : '';
}
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
const isOn = (v) => v === 1 || v === '1' || v === true;

// Every auth user, page by page, so no account is missed however many there are (F36 in docs/BUG_REVIEW_2026-10-23.md).
async function allAuthUsers(supabaseAdmin) {
  const users = [];
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    users.push(...((data && data.users) || []));
    if (!data || !data.nextPage || !(data.users || []).length) break;
  }
  return users;
}

async function loadProfiles(supabaseAdmin) {
  const [{ data: profiles, error }, users] = await Promise.all([
    supabaseAdmin.from('profiles').select('id, full_name, mobile_number, active, sm8_staff_uuid').order('full_name'),
    allAuthUsers(supabaseAdmin),
  ]);
  if (error) throw error;
  const emailById = new Map(users.map(u => [u.id, normEmail(u.email)]));
  return (profiles || []).map(p => ({ ...p, email: emailById.get(p.id) || '' }));
}

function suggest(staff, profiles) {
  const linked = profiles.find(p => p.sm8_staff_uuid === staff.uuid);
  if (linked) return { profileId: linked.id, reason: 'Saved match', saved: true };
  const free = profiles.filter(p => !p.sm8_staff_uuid);
  const email = normEmail(staff.email);
  const byEmail = email && free.find(p => p.email === email);
  if (byEmail) return { profileId: byEmail.id, reason: 'Same email' };
  const phone = normPhone(staff.mobile);
  const byPhone = phone && free.find(p => normPhone(p.mobile_number) === phone);
  if (byPhone) return { profileId: byPhone.id, reason: 'Same mobile' };
  const name = normName(`${staff.first || ''} ${staff.last || ''}`);
  const byName = name && free.filter(p => normName(p.full_name) === name);
  if (byName && byName.length === 1) return { profileId: byName[0].id, reason: 'Same name' };
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requireAdmin(event);
  if (!auth) return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized' }) };
  const { supabaseAdmin } = auth;

  try {
    const { links } = JSON.parse(event.body || '{}');

    if (Array.isArray(links)) {
      // Clear every changed link first, then set the new ones, so moving a
      // match from one person to another never trips the unique index.
      const clean = links
        .filter(l => l && typeof l.sm8StaffUuid === 'string' && l.sm8StaffUuid)
        .map(l => ({ sm8StaffUuid: l.sm8StaffUuid, profileId: l.profileId || null }));
      const uuids = clean.map(l => l.sm8StaffUuid);
      const profileIds = clean.map(l => l.profileId).filter(Boolean);
      if (new Set(profileIds).size !== profileIds.length) {
        return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'The same TEops person is picked for two ServiceM8 staff' }) };
      }
      if (uuids.length) {
        const { error } = await supabaseAdmin.from('profiles').update({ sm8_staff_uuid: null }).in('sm8_staff_uuid', uuids);
        if (error) throw error;
      }
      if (profileIds.length) {
        const { error } = await supabaseAdmin.from('profiles').update({ sm8_staff_uuid: null }).in('id', profileIds);
        if (error) throw error;
      }
      for (const l of clean.filter(x => x.profileId)) {
        const { error } = await supabaseAdmin.from('profiles').update({ sm8_staff_uuid: l.sm8StaffUuid }).eq('id', l.profileId);
        if (error) throw error;
      }
      return { statusCode: 200, body: JSON.stringify({ ok: true, saved: clean.filter(x => x.profileId).length }) };
    }

    const apiKey = await getIntegrationKey('servicem8');
    const [sm8Staff, profiles] = await Promise.all([sm8GetAll(apiKey, 'staff'), loadProfiles(supabaseAdmin)]);
    const staff = sm8Staff
      .map(s => ({
        uuid: s.uuid,
        name: `${s.first || ''} ${s.last || ''}`.trim() || s.email || 'Unnamed',
        email: s.email || '',
        mobile: s.mobile || '',
        active: isOn(s.active),
        match: suggest(s, profiles),
      }))
      .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        staff,
        profiles: profiles.map(p => ({ id: p.id, name: p.full_name || p.email || 'Unnamed', active: p.active })),
      }),
    };
  } catch (err) {
    console.error('sm8-staff error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
