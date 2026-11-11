// Suggested solar and battery sizes from an electricity bill and the pre-quote answers: the bill
// card's "Recommended from the bill" on a quote (project.html, loaded after solar-roi.js) and the
// sizing stored with a bill reading (netlify/functions/read-electricity-bill.js). The client's
// proposal does not load it. Reading only: nothing is saved here.
//
// The estimate's own pieces (the normal values, the bill's figures, the existing solar and the
// export limit) come from solar-roi.js: globals in the browser, required on the server. Everything
// sits inside one function so the names never clash with that file's.
const suggestSizes = (() => {
  const roi = (typeof module !== 'undefined' && module.exports)
    ? require('./solar-roi.js')
    : { ROI_ASSUMPTIONS, billMetrics, existingSolarKw, roiExportLimitKw };

  function roiRoundUpTo(value, sizes) {
    for (const s of sizes) if (s >= value - 0.001) return s;
    return sizes[sizes.length - 1];
  }

  // Share of use outside daylight: the off-peak plus peak share where the bill splits it (peak is the
  // evening on NSW tariffs), else the default. Sizing only.
  function eveningShare(metrics) {
    if (!metrics.split) return 1 - roi.ROI_ASSUMPTIONS.daytimeShare;
    const total = metrics.split.peak + metrics.split.shoulder + metrics.split.offPeak;
    if (!total) return 1 - roi.ROI_ASSUMPTIONS.daytimeShare;
    const share = (metrics.split.peak + metrics.split.offPeak) / total;
    return Math.min(0.85, Math.max(0.45, share));
  }

  // Suggested solar kW and battery kWh from the bill and the pre-quote answers. Deterministic.
  function sizesFor({ reading, answers, zoneRating }) {
    const m = roi.billMetrics(reading);
    const a = answers || {};
    const yieldPerKw = roi.ROI_ASSUMPTIONS.yieldPerKwPerDay[zoneRating] || roi.ROI_ASSUMPTIONS.yieldPerKwPerDay[roi.ROI_ASSUMPTIONS.defaultZoneRating];
    const existingKw = roi.existingSolarKw(a);
    const notes = [];
    let solarKw = null, solarRaw = null;
    if (m.dailyKwh) {
      solarRaw = m.dailyKwh / yieldPerKw;
      const wanted = Math.max(0, solarRaw - existingKw);
      solarKw = wanted > 0 ? roiRoundUpTo(wanted, roi.ROI_ASSUMPTIONS.solarSizesKw) : 0;
      notes.push(`${m.dailyKwh} kWh a day divided by ${yieldPerKw} kWh per kW per day = ${solarRaw.toFixed(1)} kW to cover the whole year's use${existingKw ? `, less ${existingKw} kW already on the roof` : ''}, rounded up to a common size.`);
      if (roi.roiExportLimitKw(a) != null && roi.roiExportLimitKw(a) <= 5) notes.push(`Export limit "${a.export_limit}": a bigger system mostly feeds a battery, not the grid.`);
    }
    let batteryKwh = null, eveningKwh = null;
    if (m.dailyKwh) {
      const share = eveningShare(m);
      eveningKwh = m.dailyKwh * share;
      let wanted = eveningKwh / roi.ROI_ASSUMPTIONS.batteryUsableCycle;
      const backup = String(a.backup_needs || '').toLowerCase();
      if (backup && !/^(nothing|none|no)\b/.test(backup) && /pump|air|aircon|ducted|whole|everything|all/.test(backup)) {
        wanted *= 1.25;
        notes.push('Backup needs include heavy loads, so the battery is sized a quarter larger.');
      }
      batteryKwh = Math.min(roi.ROI_ASSUMPTIONS.maxBatteryKwh, Math.max(roi.ROI_ASSUMPTIONS.minBatteryKwh, roiRoundUpTo(wanted, roi.ROI_ASSUMPTIONS.batterySizesKwh)));
      notes.push(`${Math.round(share * 100)}% of use is outside daylight (${eveningKwh.toFixed(1)} kWh a day${m.split ? ', from the bill\'s peak and off-peak split' : ', assumed'}), rounded up to a common battery size within the 5 to 100 kWh federal discount band.`);
      if (wanted > roi.ROI_ASSUMPTIONS.maxBatteryKwh) notes.push(`The evening use alone would take about ${Math.round(wanted)} kWh of battery; 100 kWh is the top of the discount band (the discount covers the first 50 kWh), so a bigger system is a commercial job sized by hand.`);
    }
    return {
      solarKw, solarRawKw: solarRaw ? Math.round(solarRaw * 10) / 10 : null, existingKw, yieldPerKw,
      batteryKwh, eveningKwhPerDay: eveningKwh ? Math.round(eveningKwh * 10) / 10 : null,
      dailyKwh: m.dailyKwh, notes,
    };
  }

  return sizesFor;
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { suggestSizes };
