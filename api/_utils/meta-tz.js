// Single source of truth for the Meta ad account's timezone.
//
// Meta's Insights API `time_range` accepts two forms:
//   - YYYY-MM-DD              → expanded to full-day boundaries IN THE
//                               AD ACCOUNT'S OWN TIMEZONE (DO NOT USE
//                               when dashboard TZ ≠ ad-account TZ —
//                               since/until both rounded out to LA day
//                               edges, the queried window can stretch
//                               to ~48h instead of the intended 24h).
//   - YYYY-MM-DDTHH:mm:ss±ZZZ → exact datetime, any TZ offset.
//
// We always send the second form (UTC, formatted with `+0000`) so the
// queried window is *exactly* the dashboard-TZ window we computed —
// no expansion at the edges, regardless of how the ad account TZ
// relates to dashboard TZ. api/meta.js is the only caller.
//
// META_AD_ACCOUNT_TIMEZONE is still required (other callers — see
// api/config.js — surface it as display metadata), but we no longer
// route the time_range value through it. Strict env var: missing →
// throw at module load.

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

// Epoch ms → ISO 8601 datetime with explicit UTC offset (`+0000`),
// the format Meta's Insights API accepts as a precise time_range
// boundary. Drops sub-second precision because Meta ignores it and a
// shorter string is easier to eyeball in logs / cache keys.
//
// Example: 1745812800000 → "2026-04-28T05:00:00+0000"
function epochToMetaISO(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+0000');
}

module.exports = { getMetaTimezone, epochToMetaISO };
