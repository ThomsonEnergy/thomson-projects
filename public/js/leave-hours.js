// Leave by the hour (item 118): the rules for a part day of leave, in one place.
// A leave request with `hours` set is part of one weekday; hours worked plus leave is never more
// than a full day (8 hours), so leave cannot push a day into overtime.
// Used by timesheets.html, schedule.html and my-day.html (window.LeaveHours) and by
// netlify/functions/push-timesheets-to-xero.js (module.exports). Plain script plus the
// module.exports guard at the bottom: no DOM access, no database.
const LeaveHours = {
  // A full weekday of ordinary hours (the same 8 as dayBands in compute-labour-cost.js).
  FULL_DAY: 8,

  isPartDay(l) { return !!l && l.hours != null; },

  round2(n) { return Math.round(Number(n) * 100) / 100; },

  // Hours of leave that can be paid on a day with `worked` hours clocked: what was asked, cut
  // back so worked plus leave stops at a full day.
  topUp(asked, worked) {
    const room = LeaveHours.FULL_DAY - (Number(worked) || 0);
    return LeaveHours.round2(Math.max(0, Math.min(Number(asked) || 0, room)));
  },

  isWeekday(ymd) {
    const dow = new Date(`${ymd}T12:00:00Z`).getUTCDay();
    return dow >= 1 && dow <= 5;
  },

  // Why these hours cannot be asked for, or '' when they can. `hours` is the typed text
  // (blank = the whole day, always fine here); `worked` is the hours already clocked that day.
  problem({ start, end, hours, worked, isHoliday }) {
    if (hours == null || String(hours).trim() === '') return '';
    const h = Number(hours);
    if (!Number.isFinite(h) || h <= 0) return 'Hours must be more than 0, or leave it blank for the whole day.';
    if (start !== end) return 'Hours only work for one day: make the start and end date the same, or leave Hours blank.';
    if (!LeaveHours.isWeekday(start)) return 'Leave by the hour is for weekdays only.';
    if (isHoliday) return 'That day is a public holiday, so there is no leave to take.';
    if (h >= LeaveHours.FULL_DAY) return `For ${LeaveHours.FULL_DAY} hours or more, leave Hours blank to take the whole day.`;
    const room = LeaveHours.round2(LeaveHours.FULL_DAY - (Number(worked) || 0));
    if (worked > 0 && h > room) {
      return room > 0
        ? `${LeaveHours.round2(worked)}h is already clocked that day, so the most leave is ${room}h (${LeaveHours.FULL_DAY} hours in the day).`
        : `${LeaveHours.round2(worked)}h is already clocked that day, so there is no room for leave.`;
    }
    return '';
  },

  // "2h" for a part day.
  label(l) { return `${LeaveHours.round2(l.hours)}h`; },
};

if (typeof window !== 'undefined') window.LeaveHours = LeaveHours;
if (typeof module !== 'undefined' && module.exports) module.exports = LeaveHours;
