// Thomson Energy's Schedule of Rates: the one copy of its wording, shared by the estimate page
// (quote.html, estimates only) and the standalone document (rates.html, Documents page).
// rates: [{ name, sell_rate }] from billable_rate_tiers; reviewedOn: company_settings.rates_reviewed_on.
// Needs escapeHtml and money from supabase-client.js.

function ratesAsAtText(reviewedOn) {
  const d = reviewedOn ? new Date(reviewedOn + 'T00:00:00') : new Date();
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
}

// Two halves, so the standalone document can put each on its own A4 sheet (the estimate page cuts
// its own sheets and uses the whole thing).
function scheduleOfRatesParts(rates, reviewedOn) {
  const esc = escapeHtml;
  return [`
    <div class="sor-h">1. Application</div>
    <p>This Schedule of Rates applies to all works performed by Thomson Energy where a fixed quotation has not been issued or cannot reasonably be provided. This includes but is not limited to fault-finding, investigative works, service calls, variations, urgent works, and client-requested additional works.</p>
    <div class="sor-h">2. Labour rates</div>
    <table class="qtable">
      <thead><tr><th>Description</th><th class="num">Unit price ex GST</th><th class="num">Unit price inc GST</th></tr></thead>
      <tbody>${(rates || []).map(r => `<tr><td>${esc(r.name)}</td><td class="num">${money(r.sell_rate)}</td><td class="num">${money(Math.round(Number(r.sell_rate) * 1.1 * 100) / 100)}</td></tr>`).join('')}</tbody>
    </table>
    <div class="sor-h">3. Standard hours</div>
    <p><b>Standard hours:</b> Monday to Friday, 6:30am to 4:00pm.<br><b>Minimum charge:</b> 2 hours per attendance per technician.</p>
    <p>Personnel classification is determined solely by Thomson Energy based on licensing, experience, competency, and responsibility required for the task.</p>`, `
    <div class="sor-h">4. Overtime &amp; after hours multipliers</div>
    <table class="qtable">
      <thead><tr><th>Period</th><th class="num">Rate applied</th></tr></thead>
      <tbody>
        <tr><td>Outside standard hours</td><td class="num">1.5x</td></tr>
        <tr><td>Saturday</td><td class="num">1.5x</td></tr>
        <tr><td>Sunday</td><td class="num">2.0x</td></tr>
        <tr><td>Public Holiday</td><td class="num">2.5x</td></tr>
        <tr><td>Emergency Callout</td><td class="num">Minimum 3 hours</td></tr>
      </tbody>
    </table>
    <p class="note-line">Multipliers apply to all labour classifications.</p>
    <div class="sor-h">5. Do &amp; charge basis</div>
    <p>All works performed under this Schedule are charged on a time and materials (do-and-charge) basis, meaning:</p>
    <ul>
      <li>Labour is charged for actual time spent.</li>
      <li>Time includes travel where applicable, fault finding, setup, testing, documentation, compliance verification, and pack-down.</li>
      <li>Materials are charged as supplied and installed.</li>
      <li>Any estimate provided is indicative only and does not constitute a fixed price.</li>
    </ul>
    <div class="sor-h">6. Materials, equipment &amp; consumables</div>
    <p>Materials are charged at Thomson Energy's supply rate, which includes procurement, handling, warranty risk, administration, logistics, and margin. Supply rates are confidential and not subject to disclosure.</p>
    <p>Specialist equipment, access equipment, plant hire, test instruments, lifting equipment, or machinery will be charged at applicable daily or hourly rates.</p>
    <p class="note-line">This document is current as at ${esc(ratesAsAtText(reviewedOn))}.</p>`];
}

function scheduleOfRatesHtml(rates, reviewedOn) {
  return scheduleOfRatesParts(rates, reviewedOn).join('');
}
