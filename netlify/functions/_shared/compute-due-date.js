// Turns a client's payment_terms ('cod' | 'net_7' | 'net_14' | 'net_30')
// into a due date, N days after the invoice date - COD (cash/card on
// delivery) is due the same day. Returns a plain YYYY-MM-DD string, the
// same shape `invoices.due_date` (a date column, not a timestamp) stores.
function computeDueDate(paymentTerms, invoiceDate) {
  const days = { cod: 0, net_7: 7, net_14: 14, net_30: 30 }[paymentTerms] ?? 0;
  const d = new Date(invoiceDate);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

module.exports = { computeDueDate };
