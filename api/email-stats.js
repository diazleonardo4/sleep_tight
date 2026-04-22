// GET /api/email-stats  (header: x-auth-token)
// Returns open/click stats for the Email 1 (welcome) and Email 3
// (pitch) campaigns. Used by the dashboard's Layer 3c panel.
//
// Graceful fallback: if MAILERLITE_API_TOKEN or either of the campaign
// id env vars is missing, responds 200 with { available: false, reason }
// so the dashboard can render a "not configured" state without blocking
// the rest of the page.
//
// Response shape when available:
// {
//   available: true,
//   email1: { subject, sent, opens, opensUnique, openRate, clicks, clicksUnique, clickRate },
//   email3: { ...same fields... }
// }

const cache = new Map(); // key -> { data, at }
const CACHE_MS = 5 * 60 * 1000; // 5 min — campaign stats change slowly

module.exports = async (req, res) => {
  if (!checkAuth(req, res)) return;

  const token = process.env.MAILERLITE_API_TOKEN;
  const email1Id = process.env.MAILERLITE_EMAIL_1_CAMPAIGN_ID;
  const email3Id = process.env.MAILERLITE_EMAIL_3_CAMPAIGN_ID;

  if (!token) {
    return res.status(200).json({ available: false, reason: 'MAILERLITE_API_TOKEN not set' });
  }
  if (!email1Id || !email3Id) {
    return res.status(200).json({
      available: false,
      reason: 'MAILERLITE_EMAIL_1_CAMPAIGN_ID / MAILERLITE_EMAIL_3_CAMPAIGN_ID not set',
    });
  }

  const cacheKey = `${email1Id}:${email3Id}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return res.status(200).json(hit.data);
  }

  try {
    const [email1, email3] = await Promise.all([
      fetchCampaignStats(email1Id, token),
      fetchCampaignStats(email3Id, token),
    ]);
    const data = { available: true, email1, email3 };
    cache.set(cacheKey, { data, at: Date.now() });
    return res.status(200).json(data);
  } catch (err) {
    return res.status(502).json({ error: `Email stats error: ${err.message}` });
  }
};

async function fetchCampaignStats(campaignId, token) {
  const r = await fetch(`https://connect.mailerlite.com/api/campaigns/${campaignId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`HTTP ${r.status} on campaign ${campaignId}: ${text.slice(0, 200)}`);
  }
  const body = await r.json();
  const c = body.data || body || {};
  const stats = c.stats || {};
  const sent = num(stats.sent);
  const opens = num(stats.opens_count);
  const opensUnique = num(stats.unique_opens_count ?? stats.unique_opens);
  const clicks = num(stats.clicks_count);
  const clicksUnique = num(stats.unique_clicks_count ?? stats.unique_clicks);
  return {
    id: c.id || campaignId,
    subject: c.subject || c.name || '',
    sent,
    opens,
    opensUnique,
    openRate: sent > 0 ? +((opensUnique / sent) * 100).toFixed(2) : 0,
    clicks,
    clicksUnique,
    clickRate: sent > 0 ? +((clicksUnique / sent) * 100).toFixed(2) : 0,
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function checkAuth(req, res) {
  const expected = process.env.DASHBOARD_PASSWORD;
  const token = req.headers['x-auth-token'];
  if (!expected || !token || token !== expected) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}
