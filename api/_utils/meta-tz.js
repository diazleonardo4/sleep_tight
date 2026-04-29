// Single source of truth for the Meta ad account's timezone.
//
// Meta's Insights API `time_range.since` / `time_range.until` accept
// ONLY YYYY-MM-DD (date-only). Meta interprets those calendar dates
// in the AD ACCOUNT'S OWN TIMEZONE (META_AD_ACCOUNT_TIMEZONE) — so
// `{since:"2026-04-28", until:"2026-04-28"}` returns exactly the
// Apr 28 00:00 → 23:59 window in that TZ.
//
// We expose META_AD_ACCOUNT_TIMEZONE here purely so api/config.js can
// surface it to the dashboard UI as display metadata. The time_range
// itself does NOT route through this TZ — see api/meta.js: we pass
// dashboard-TZ dates straight through, accepting a small (≤24h ad
// account TZ vs dashboard TZ offset) hour-level skew at the window
// edges in exchange for a clean 24h-multiple window. Translating the
// two endpoints of the dashboard window into ad-account-TZ dates
// independently is what produced the original 48h-window bug.
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

module.exports = { getMetaTimezone };
