// Reads the text of Formbay's two PDFs for a payment: the "Payment Advice" (Reference No, one line per
// Formbay job sold) and the fee "TAX INVOICE" (Invoice No FEE<reference>, processing and CER registration
// fees per STC, plus GST). Takes plain text (from pdf.js in the browser) and returns the figures, so
// the STC page can show them for checking before anything is saved.
// Works in the browser (window.parseFormbayPdfText) and in Node (module.exports) for testing.

(function () {
  const num = (s) => (s == null || s === '-' ? 0 : parseFloat(String(s).replace(/[$,+\s]/g, '')) || 0);
  const isoDate = (d) => { const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(d || ''); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
  const lastMatch = (re, t) => { let m, last = null; const g = new RegExp(re.source, 'g'); while ((m = g.exec(t))) last = m; return last; };
  const TYPE = { PV: 'pv', BSTC: 'bstc', SWH: 'swh', SHW: 'swh', HW: 'swh' };

  function parseFormbayPdfText(rawText) {
    const t = String(rawText || '').replace(/\s+/g, ' ').trim();
    const date = isoDate((/Date:\s*(\d{2}\/\d{2}\/\d{4})/.exec(t) || [])[1]);

    if (/Payment Advice/i.test(t)) {
      const reference = (/Reference No:\s*(\d+)/i.exec(t) || [])[1] || null;
      // e.g. "PV 1269150 (Owner name) SPV NOT VERIFIED 61 $39.25 - $2,394.25"
      //      "BSTC 292546 (Owner name) - 465 $39.25 - $18,251.25"  (the "-" is an empty Ref Id column)
      const lineRe = /\b(PV|BSTC|SWH|SHW|HW)\s+(\d+)\s*\(([^)]*)\)\s*(.*?)\s*(\d+)\s*\$([\d,]+\.\d{2})\s*(-|\$[\d,]+\.\d{2})\s*\$([\d,]+\.\d{2})/g;
      const lines = [];
      let m;
      while ((m = lineRe.exec(t))) {
        const extra = m[4].replace(/^-\s*|\s*-$/g, '').trim();
        lines.push({
          stc_type: TYPE[m[1]] || 'pv',
          formbay_job_id: m[2],
          description: [m[3].trim(), extra].filter(Boolean).join(' - '),
          commercial: /commercial/i.test(extra),
          units: parseInt(m[5], 10),
          unit_price: num(m[6]),
          gst_on_units: num(m[7]),
          total: num(m[8]),
        });
      }
      const units = parseInt((/Totals\s*:\s*(\d+)/i.exec(t) || [])[1] || '0', 10);
      const net = (/Net Total\s*\$([\d,]+\.\d{2})/i.exec(t) || [])[1];
      const gst = (/GST on Units\s*\+\s*\$([\d,]+\.\d{2})/i.exec(t) || [])[1];
      const total = (lastMatch(/\bTotal\s*\$([\d,]+\.\d{2})/i, t) || [])[1];
      return { kind: 'advice', reference, date, lines, units, net_total: num(net), gst_on_units: num(gst), total: num(total) };
    }

    if (/TAX INVOICE/i.test(t) && /Invoice No:\s*FEE/i.test(t)) {
      const invoiceNo = (/Invoice No:\s*(FEE\d+)/i.exec(t) || [])[1];
      // e.g. "STC Processing Fee (PV) : 148 $0.53 $78.44" or "CER Processing Fee : 465$0.47 $218.55"
      const feeRe = /([A-Z][A-Za-z ]*?Fee(?:\s*\([A-Z]+\))?)\s*:\s*(\d+)\s*\$([\d,]+\.\d{2})\s*\$([\d,]+\.\d{2})/g;
      const fees = [];
      let m;
      while ((m = feeRe.exec(t))) fees.push({ description: m[1].replace(/^.*\bTotal\s+/, '').trim(), units: parseInt(m[2], 10), unit_price: num(m[3]), total: num(m[4]) });
      const gst = (/\bGST\s*\$([\d,]+\.\d{2})/.exec(t) || [])[1];
      const total = (lastMatch(/\bTotal\s*\$([\d,]+\.\d{2})/i, t) || [])[1];
      const exGst = Math.round(fees.reduce((s, f) => s + f.total, 0) * 100) / 100;
      return { kind: 'fee_invoice', invoice_no: invoiceNo, reference: invoiceNo.replace(/^FEE/i, ''), date, fees, fee_ex_gst: exGst, fee_gst: num(gst), fee_total: num(total) };
    }

    return { kind: 'unknown' };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { parseFormbayPdfText };
  if (typeof window !== 'undefined') window.parseFormbayPdfText = parseFormbayPdfText;
})();
