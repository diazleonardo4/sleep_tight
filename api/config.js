// GET /api/config  (header: x-auth-token)
// Exposes non-secret dashboard config to the frontend — currently the
// configured timezones so the UI can label "today" boundaries and
// surface the Meta translation target for debugging.
//
// Response shape:
//   { timezone: "<DASHBOARD_TIMEZONE>", metaTimezone: "<META_AD_ACCOUNT_TIMEZONE>" }
//
// Both values come from the canonical env-var readers in _utils/
// (strict — missing env vars throw at module load).

const { getDashboardTimezone } = require('./_utils/dates');
const { getMetaTimezone } = require('./_utils/meta-tz');

module.exports = async (req, res) => {
  const expected = process.env.DASHBOARD_PASSWORD;
  const token = req.headers['x-auth-token'];
  if (!expected || !token || token !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.status(200).json({
    timezone: getDashboardTimezone(),
    metaTimezone: getMetaTimezone(),
  });
};
