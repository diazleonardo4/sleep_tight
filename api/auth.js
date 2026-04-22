// POST /api/auth  { password } -> { token }
// Token is literally the password. Each subsequent API call re-validates
// the x-auth-token header against DASHBOARD_PASSWORD.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) {
    return res.status(500).json({ error: 'DASHBOARD_PASSWORD not configured' });
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {});
  const password = body && body.password;

  if (!password || password !== expected) {
    // Small delay to discourage brute force
    await new Promise(r => setTimeout(r, 400));
    return res.status(401).json({ error: 'Invalid password' });
  }

  return res.status(200).json({ token: expected });
};

function safeParse(s) {
  try { return JSON.parse(s); } catch (_) { return {}; }
}
