// Settings > Email Agent > Rules Postie learned (item 81). One rule per sender and inbox, taught
// by a person's label corrections in the Inbox: "sender -> label" (mail from them goes under that
// label, no AI) or "sender: no label" (Postie never labels them). Listed per inbox the person works
// in (RLS on email_label_rules), with Remove. Loaded by settings.html with loadJsOnce; needs
// supabase-client.js (supabaseClient, escapeHtml).

async function loadEmailRulesCard() {
  const el = document.getElementById('email-rules-list');
  if (!el) return;
  const [{ data: rules, error }, { data: labels }, { data: boxes }, { data: staff }] = await Promise.all([
    supabaseClient.from('email_label_rules').select('*').order('created_at', { ascending: false }).limit(500),
    supabaseClient.from('email_labels').select('id, name'),
    supabaseClient.from('mailboxes').select('id, address'),
    supabaseClient.from('profiles').select('id, full_name'),
  ]);
  if (error) { el.innerHTML = `<div class="error-box">${escapeHtml(error.message)}</div>`; return; }
  if (!rules || !rules.length) { el.innerHTML = '<p class="subtitle" style="margin:0;">No rules yet. Move a conversation to a label, add one by hand, or take one of Postie\'s labels off, and the rule shows here.</p>'; return; }
  const labelName = (id) => (labels || []).find((l) => l.id === id)?.name || '(label gone)';
  const boxName = (id) => (boxes || []).find((b) => b.id === id)?.address || '';
  const who = (id) => (staff || []).find((p) => p.id === id)?.full_name || '';
  const when = (iso) => new Date(iso).toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney', day: 'numeric', month: 'short' });
  const td = 'style="padding:8px 6px; border-bottom:1px solid var(--border); vertical-align:top;"';
  el.innerHTML = `<table style="width:100%; border-collapse:collapse; font-size:13px;"><tbody>${rules.map((r) => `<tr>
      <td ${td}>${escapeHtml(r.sender)}<div class="subtitle" style="font-size:12px;">${escapeHtml(boxName(r.mailbox_id))}</div></td>
      <td ${td}>${r.label_id ? '&rarr; ' + escapeHtml(labelName(r.label_id)) : '<span style="color:var(--muted);">no label from Postie</span>'}</td>
      <td ${td} class="subtitle" style="font-size:12px; white-space:nowrap; padding:8px 6px; border-bottom:1px solid var(--border);">${escapeHtml(who(r.created_by))} ${when(r.created_at)}${r.taught_by_thread_id ? ` &middot; <a href="/inbox.html?thread=${r.taught_by_thread_id}" class="link-quiet">the email</a>` : ''}</td>
      <td ${td} style="white-space:nowrap; padding:8px 6px; border-bottom:1px solid var(--border);"><button type="button" class="secondary" data-rule="${r.id}" style="font-size:12px; padding:3px 8px;">Remove</button></td>
    </tr>`).join('')}</tbody></table>`;
  el.querySelectorAll('[data-rule]').forEach((b) => b.addEventListener('click', async () => {
    const { error: err } = await supabaseClient.from('email_label_rules').delete().eq('id', b.dataset.rule);
    if (err) { alert(err.message); return; }
    loadEmailRulesCard();
  }));
}
