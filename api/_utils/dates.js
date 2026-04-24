// Shared timezone + date-range helpers for the dashboard side of the app.
//
// Single source of truth: process.env.DASHBOARD_TIMEZONE. Read ONCE at
// module scope. No hardcoded fallback — a missing env var throws so the
// failure mode is loud instead of silently producing plausible-looking
// wrong data.
//
// Everything timezone-dependent in the dashboard ingest + aggregation
// path flows through this module. Meta's ad-account timezone is handled
// separately in ./meta-tz.js; translate between the two ONLY at the
// Meta API boundary (see api/meta.js).
//
// NEVER use `new Date().toISOString().slice(0,10)` for date bucketing.
// That gives a UTC date, which is wrong for anyone not on UTC. Always
// go through these helpers.

const DASHBOARD_TZ = process.env.DASHBOARD_TIMEZONE;
if (!DASHBOARD_TZ) {
  throw new Error(
    'DASHBOARD_TIMEZONE env var is required (IANA name, e.g. America/Bogota). ' +
    'Set it in Vercel → Project → Settings → Environment Variables.'
  );
}

// Range identifiers the dashboard UI + URL params use. Kept short for
// compact URLs / session storage. getDateRange also accepts the verbose
// aliases listed below so callers can use either form.
const VALID_RANGES = ['today', '7d', '30d'];

function getDashboardTimezone() {
  return DASHBOARD_TZ;
}

function todayInDashboardTZ() {
  return formatInTZ(new Date(), DASHBOARD_TZ);
}

function daysAgoInDashboardTZ(days) {
  return formatInTZ(new Date(Date.now() - days * 86400000), DASHBOARD_TZ);
}

// Given a UTC Date, ISO string, or epoch ms, returns the date it falls
// on in dashboard TZ as YYYY-MM-DD.
function utcToDashboardDate(utc) {
  const d = utc instanceof Date
    ? utc
    : (typeof utc === 'number' ? new Date(utc) : new Date(utc));
  return formatInTZ(d, DASHBOARD_TZ);
}

// For a YYYY-MM-DD interpreted in dashboard TZ, return the epoch ms
// boundaries of that calendar day. startMs is midnight-in-dashboard-TZ;
// endMs is startMs + 24h (exclusive upper bound — the next day's midnight).
// Callers that want the last millisecond in the window should use endMs - 1.
function getDashboardDayBoundaries(dateStr) {
  const startMs = zonedDateToUTC(dateStr, DASHBOARD_TZ).getTime();
  return { startMs, endMs: startMs + 86400000 };
}

// Standard range resolver used by every endpoint. Returns dashboard-TZ
// YYYY-MM-DD strings (inclusive both ends — `until` is today for 7d/30d).
//
// Accepts:
//   today | yesterday | 7d | 30d | last_7_days | last_30_days
// Unknown values fall back to 7d.
function getDateRange(range) {
  const r = normalizeRange(range);
  const today = todayInDashboardTZ();
  if (r === 'today') return { since: today, until: today };
  if (r === 'yesterday') {
    const y = daysAgoInDashboardTZ(1);
    return { since: y, until: y };
  }
  const days = r === '30d' ? 29 : 6;
  return { since: daysAgoInDashboardTZ(days), until: today };
}

const INTERNAL_RANGES = new Set(['today', 'yesterday', '7d', '30d']);

function normalizeRange(range) {
  const raw = String(range || '7d').toLowerCase();
  const r = raw === 'last_7_days' ? '7d'
          : raw === 'last_30_days' ? '30d'
          : raw;
  return INTERNAL_RANGES.has(r) ? r : '7d';
}

// Format a Date as YYYY-MM-DD in a given timezone. en-CA gives ISO order.
function formatInTZ(date, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

// Convert a YYYY-MM-DD (interpreted at 00:00 in the given TZ) to a UTC
// Date. Works regardless of what timezone the server itself runs in
// (Vercel runs in UTC). Uses Intl for the offset math — no hardcoded
// offsets, no Date.prototype.getTimezoneOffset.
function zonedDateToUTC(dateStr, tz) {
  const asUTCGuess = new Date(`${dateStr}T00:00:00Z`);
  const zoned = new Date(asUTCGuess.toLocaleString('en-US', { timeZone: tz }));
  const utc = new Date(asUTCGuess.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offsetMs = utc.getTime() - zoned.getTime();
  return new Date(asUTCGuess.getTime() + offsetMs);
}

module.exports = {
  VALID_RANGES,
  normalizeRange,
  getDateRange,
  getDashboardTimezone,
  todayInDashboardTZ,
  daysAgoInDashboardTZ,
  utcToDashboardDate,
  getDashboardDayBoundaries,
};
