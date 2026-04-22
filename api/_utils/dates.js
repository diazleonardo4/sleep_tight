// Shared timezone + date-range helpers for all dashboard endpoints.
//
// The dashboard has ONE canonical timezone (DASHBOARD_TIMEZONE env var,
// default America/Bogota). All "today / 7d / 30d" math happens in that
// zone. When an external service uses a different zone (e.g. Meta ad
// account TZ), translate the boundaries on the way out.
//
// NEVER use `new Date().toISOString().slice(0,10)` for date bucketing in
// the dashboard — it gives a UTC date, which is wrong for anyone not on
// UTC. Always go through these helpers.

const DASHBOARD_TZ = process.env.DASHBOARD_TIMEZONE || 'America/Bogota';

const VALID_RANGES = ['today', '7d', '30d'];

// Returns today's date in the dashboard timezone as YYYY-MM-DD.
function todayInDashboardTZ() {
  return formatInTZ(new Date(), DASHBOARD_TZ);
}

// Returns the date N days ago (from now) in dashboard TZ as YYYY-MM-DD.
function daysAgoInDashboardTZ(days) {
  return formatInTZ(new Date(Date.now() - days * 86400000), DASHBOARD_TZ);
}

// Given a UTC Date or ISO string, returns the date it falls on in
// dashboard TZ as YYYY-MM-DD.
function utcToDashboardDate(utc) {
  return formatInTZ(utc instanceof Date ? utc : new Date(utc), DASHBOARD_TZ);
}

// Converts a YYYY-MM-DD date (interpreted in dashboard TZ) to a UTC Date
// representing the START of that day in the dashboard TZ.
function dashboardDateToUTCStart(dateStr) {
  return zonedDateToUTC(dateStr, DASHBOARD_TZ);
}

// Same for END of the day (exclusive-ish: last millisecond of the day).
function dashboardDateToUTCEnd(dateStr) {
  return new Date(dashboardDateToUTCStart(dateStr).getTime() + 86400000 - 1);
}

// Standard range resolver used by all endpoints. Inclusive of today.
function getDateRange(range) {
  const r = normalizeRange(range);
  const until = todayInDashboardTZ();
  if (r === 'today') return { since: until, until };
  const days = r === '30d' ? 29 : 6;
  return { since: daysAgoInDashboardTZ(days), until };
}

function normalizeRange(range) {
  const r = String(range || '7d').toLowerCase();
  return VALID_RANGES.includes(r) ? r : '7d';
}

// Format a Date as YYYY-MM-DD in a given timezone.
function formatInTZ(date, tz) {
  // en-CA locale gives ISO-like YYYY-MM-DD ordering.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

// Convert a YYYY-MM-DD (interpreted at 00:00 in the given TZ) to a UTC Date.
// Works regardless of what timezone the server itself runs in (Vercel = UTC).
function zonedDateToUTC(dateStr, tz) {
  // Start with the date as if it were UTC midnight. Then figure out what
  // that same wall-clock instant prints as in the target TZ, and use the
  // delta to shift into the true UTC instant for midnight-in-TZ.
  const asUTCGuess = new Date(`${dateStr}T00:00:00Z`);
  const zoned = new Date(asUTCGuess.toLocaleString('en-US', { timeZone: tz }));
  const utc = new Date(asUTCGuess.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offsetMs = utc.getTime() - zoned.getTime();
  return new Date(asUTCGuess.getTime() + offsetMs);
}

// Convert a dashboard-TZ date range to the equivalent range expressed in
// another timezone. Used when calling an external service whose date
// buckets are in a different zone (e.g. Meta ad account TZ).
function rangeInTZ(range, targetTZ) {
  const { since, until } = getDateRange(range);
  if (!targetTZ || targetTZ === DASHBOARD_TZ) return { since, until };
  const sinceUTC = dashboardDateToUTCStart(since);
  const untilUTC = dashboardDateToUTCEnd(until);
  return {
    since: formatInTZ(sinceUTC, targetTZ),
    until: formatInTZ(untilUTC, targetTZ),
  };
}

module.exports = {
  DASHBOARD_TZ,
  VALID_RANGES,
  normalizeRange,
  getDateRange,
  rangeInTZ,
  todayInDashboardTZ,
  daysAgoInDashboardTZ,
  utcToDashboardDate,
  dashboardDateToUTCStart,
  dashboardDateToUTCEnd,
};
