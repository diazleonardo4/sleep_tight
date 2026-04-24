// Single source of truth for the Meta ad account's timezone.
//
// Meta's Insights API interprets `time_range.since` / `time_range.until`
// as wall-clock YYYY-MM-DD values IN THE AD ACCOUNT'S OWN TIMEZONE,
// which often differs from the dashboard's timezone. api/meta.js is the
// only caller — it translates dashboard-TZ boundaries into this TZ at
// the API boundary so users see metrics that match the dashboard day.
//
// Strict env var: missing → throw at module load. We never want silent
// fallbacks here, because a misconfigured Meta TZ produces data that
// looks plausible but is off by a full day.

const META_TZ = process.env.META_AD_ACCOUNT_TIMEZONE;
if (!META_TZ) {
  throw new Error(
    'META_AD_ACCOUNT_TIMEZONE env var is required (IANA name, e.g. America/Los_Angeles). ' +
    'Find it in Meta Business Settings → Ad Accounts → your account → Time Zone. ' +
    'Set it in Vercel → Project → Settings → Environment Variables.'
  );
}

function getMetaTimezone() {
  return META_TZ;
}

// Epoch ms → the calendar date that moment falls on in Meta's ad account
// TZ, formatted as YYYY-MM-DD. en-CA gives ISO-like ordering.
function utcToMetaDate(ms) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: META_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

module.exports = { getMetaTimezone, utcToMetaDate };
