// GET /api/config  (header: x-auth-token)
// Exposes non-secret dashboard config to the frontend.
// Right now just the canonical timezone so the UI can label
// "today" correctly.
const { DASHBOARD_TZ } = require('./_utils/dates');

module.exports = async (req, res) => {
  const expected = process.env.DASHBOARD_PASSWORD;
  const token = req.headers['x-auth-token'];
  if (!expected || !token || token !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.status(200).json({ timezone: DASHBOARD_TZ });
};
