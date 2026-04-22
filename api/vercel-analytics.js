// GET /api/vercel-analytics  (header: x-auth-token)
// Vercel Web Analytics does not expose a stable public API at time of writing.
// Rather than block the rest of the dashboard on an unreliable integration,
// this endpoint returns an "unavailable" notice so the UI can render a hint
// directing the user to the Vercel dashboard.
module.exports = async (req, res) => {
  const expected = process.env.DASHBOARD_PASSWORD;
  const token = req.headers['x-auth-token'];
  if (!expected || !token || token !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.status(200).json({
    available: false,
    message: 'Vercel Web Analytics has no public API. View traffic, top pages, and referrers in the Vercel dashboard → Analytics tab.',
  });
};
