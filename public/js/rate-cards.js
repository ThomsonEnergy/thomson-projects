// Charge rate levels in the browser (item 46, spec D1): a quote or job is charged at its level, a
// percent of the Billable Rates (rate_cards, projects.rate_card_id, the client's default in
// clients.rate_card_id). Loaded by project.html (the quote's tier dropdown and the Summary chip),
// clients.html (the client's level) and the fixed variation editor. Reads rate_cards and the
// job's level; the chip writes projects.rate_card_id (pricing roles) and reloads the page so every
// rate on it is read again at the new level. Amounts are still worked out on the server.

let rateCardsPromise = null;
function loadRateCards() {
  if (!rateCardsPromise) {
    rateCardsPromise = supabaseClient.from('rate_cards').select('id, name, percent, is_default').order('sort_order').order('name')
      .then(({ data, error }) => { if (error) { rateCardsPromise = null; throw error; } return data || []; });
  }
  return rateCardsPromise;
}

const STANDARD_RATE_CARD = { id: null, name: 'Standard', percent: 100, is_default: false };

// The level for a project row ({ rate_card_id }) out of the loaded cards. No level means Standard
// (100%), the same reading the server and the database give it; the default level only applies to
// new clients.
function rateCardOf(project, cards) {
  return (cards || []).find(c => c.id === project?.rate_card_id) || STANDARD_RATE_CARD;
}

// The Billable Rates tiers at the quote's or job's level (project.html and the variation editor).
async function loadRateTiersForProject(project) {
  const [{ data: tiers, error }, cards] = await Promise.all([
    supabaseClient.from('billable_rate_tiers').select('*').order('sort_order'),
    loadRateCards(),
  ]);
  if (error) throw error;
  return tiersAtCard(tiers || [], rateCardOf(project, cards));
}

const rateCardFactor = (card) => (Number(card?.percent) > 0 ? Number(card.percent) / 100 : 1);
const rateAtCard = (sellRate, card) => Math.round((Number(sellRate) || 0) * rateCardFactor(card) * 100) / 100;

// "Commercial (+15%)", or "Standard".
function rateCardLabel(card) {
  const pct = Number(card?.percent) || 100;
  if (pct === 100) return card?.name || 'Standard';
  return `${card.name} (${pct > 100 ? '+' : ''}${Math.round((pct - 100) * 10) / 10}%)`;
}

// The Billable Rates tiers with sell_rate at the level (base_sell_rate keeps the Standard figure).
function tiersAtCard(tiers, card) {
  return (tiers || []).map(t => ({ ...t, base_sell_rate: t.sell_rate, sell_rate: rateAtCard(t.sell_rate, card) }));
}

// The Summary chip: "Charge rates: Commercial (+15%)" with a dropdown for pricing roles. Changing it
// saves the job's level and reloads, so the quote lines and invoice panel read the new rates.
async function renderJobRateCard(project, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const [cards, role] = await Promise.all([loadRateCards(), getMyRole()]);
  const card = rateCardOf(project, cards);
  const canEdit = isPricingRole(role) && cards.length > 1;
  const options = card.id ? cards : [STANDARD_RATE_CARD, ...cards];  // a job with no level yet: Standard until one is picked
  el.innerHTML = `<span class="subtitle">Charge rates:</span> <span class="badge draft">${escapeHtml(rateCardLabel(card))}</span>
    ${canEdit ? `<select id="job-rate-card" style="width:auto; display:inline-block; margin-left:6px; padding:4px 8px;">${options.map(c => `<option value="${escapeHtml(c.id || '')}" ${c.id === card.id ? 'selected' : ''}>${escapeHtml(rateCardLabel(c))}</option>`).join('')}</select>` : ''}
    <span class="subtitle" style="font-size:11px;">Labour on this ${project.job_number ? 'job' : 'quote'} is priced at this level from now on; lines already saved keep their rate.</span>`;
  const sel = el.querySelector('#job-rate-card');
  if (sel) sel.addEventListener('change', async () => {
    sel.disabled = true;
    const { error } = await supabaseClient.from('projects').update({ rate_card_id: sel.value || null }).eq('id', project.id);
    if (error) { alert(friendlyError(error)); sel.disabled = false; return; }
    const to = cards.find(c => c.id === sel.value) || STANDARD_RATE_CARD;
    await logActivity('project', project.id, 'rate_card', `Charge rates set to ${rateCardLabel(to)} (was ${rateCardLabel(card)})`);
    location.reload();
  });
}
