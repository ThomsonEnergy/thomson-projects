// Schedule of Rates bands for billing a clocked shift to a client on a no-quote job
// (not wages: that is compute-labour-cost.js). Standard hours are weekdays 6:30am to
// 4:00pm Sydney; outside them 1.5x, Saturday 1.5x, Sunday 2x, public holiday 2.5x
// (public_holidays table), minimum 2 hours per person per day. The wording the client
// reads is public/js/schedule-of-rates.js: keep the two in step.
// Called by get-invoiceable-actuals.js. Reads nothing, writes nothing.

const STANDARD_START = 6 * 60 + 30; // minutes from midnight, Sydney
const STANDARD_END = 16 * 60;

// Band keys in the order the unpaid break is taken off (cheapest first).
const BANDS = {
  standard: { label: '', multiplier: 1 },
  after_hours: { label: 'after hours', multiplier: 1.5 },
  saturday: { label: 'Saturday', multiplier: 1.5 },
  sunday: { label: 'Sunday', multiplier: 2 },
  public_holiday: { label: 'public holiday', multiplier: 2.5 },
};
const RULES = { standardHours: 'Weekdays 6:30am to 4:00pm', minimumHours: 2, bands: BANDS };

const SYDNEY_PARTS = new Intl.DateTimeFormat('en-AU', {
  timeZone: 'Australia/Sydney', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
function sydneyLocal(iso) {
  const p = Object.fromEntries(SYDNEY_PARTS.formatToParts(new Date(iso)).map(x => [x.type, x.value]));
  return { dateKey: `${p.year}-${p.month}-${p.day}`, minuteOfDay: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}
function dateKeyPlus(dateKey, days) {
  const d = new Date(`${dateKey}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function dayOfWeek(dateKey) {
  return new Date(`${dateKey}T12:00:00Z`).getUTCDay(); // 0 Sunday .. 6 Saturday
}
function clockText(minuteOfDay) {
  const h = Math.floor(minuteOfDay / 60) % 24, m = minuteOfDay % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')}${ampm}`;
}
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// One clocked shift { clock_in, clock_out, break_minutes } to its bands:
// { dateKey, start, end, bands: { standard: hours, after_hours: hours, ... } } with only the
// bands that have hours. Walks the shift a minute at a time in Sydney wall-clock time
// (a shift over midnight carries on into the next day's bands). The unpaid break comes
// off the cheapest band first.
function shiftBands(entry, holidaySet) {
  const start = sydneyLocal(entry.clock_in);
  const totalMinutes = Math.max(0, Math.round((new Date(entry.clock_out) - new Date(entry.clock_in)) / 60000));
  const minutes = {};
  const dayCache = {};
  const dayKind = (offset) => {
    if (dayCache[offset] === undefined) {
      const key = dateKeyPlus(start.dateKey, offset);
      const dow = dayOfWeek(key);
      dayCache[offset] = holidaySet.has(key) ? 'public_holiday' : dow === 0 ? 'sunday' : dow === 6 ? 'saturday' : 'weekday';
    }
    return dayCache[offset];
  };
  for (let m = 0; m < totalMinutes; m++) {
    const local = start.minuteOfDay + m;
    const kind = dayKind(Math.floor(local / 1440));
    const mod = local % 1440;
    const band = kind !== 'weekday' ? kind : (mod >= STANDARD_START && mod < STANDARD_END ? 'standard' : 'after_hours');
    minutes[band] = (minutes[band] || 0) + 1;
  }
  let breakLeft = Math.max(0, Number(entry.break_minutes) || 0);
  Object.keys(BANDS).forEach((band) => {
    if (!minutes[band] || !breakLeft) return;
    const off = Math.min(minutes[band], breakLeft);
    minutes[band] -= off;
    breakLeft -= off;
  });
  const bands = {};
  Object.keys(BANDS).forEach((band) => { if (minutes[band] > 0) bands[band] = r2(minutes[band] / 60); });
  return {
    dateKey: start.dateKey,
    start: clockText(start.minuteOfDay),
    end: clockText(start.minuteOfDay + totalMinutes),
    bands,
  };
}

module.exports = { shiftBands, RULES };
