// GET /api/meta  (header: x-auth-token)
// Returns combined Meta Ads insights for today and the last 7 days,
// plus per-ad and per-placement breakdowns.
//
// Response shape:
// {
//   today:      { spend, impressions, clicks, reach, ctr, cpc, cpm },
//   last7days:  { ...same },
//   byAd:       [ { name, spend, impressions, clicks, ctr, cpc } ],
//   byPlacement:[ { placement, spend, impressions, clicks, ctr } ]
// }

const cache = { data: null, at: 0 };
const CACHE_MS = 60 * 1000;

module.exports = async (req, res) => {
  if (!checkAuth(req, res)) return;

  if (cache.data && Date.now() - cache.at < CACHE_MS) {
    return res.status(200).json(cache.data);
  }

  const accountId = process.env.META_AD_ACCOUNT_ID;
  const token = process.env.META_ACCESS_TOKEN;
  if (!accountId || !token) {
    return res.status(500).json({ error: 'Meta env vars not configured' });
  }

  try {
    const baseFields = 'spend,impressions,clicks,ctr,cpc,cpm,reach';
    const [todayRows, last7Rows, perAdRows, perPlacementRows] = await Promise.all([
      fetchInsights(accountId, token, `fields=${baseFields}&level=account&date_preset=today`),
      fetchInsights(accountId, token, `fields=${baseFields}&level=account&date_preset=last_7d`),
      fetchInsights(accountId, token, `fields=${baseFields},ad_name&level=ad&date_preset=last_7d&limit=200`),
      fetchInsights(accountId, token, `fields=${baseFields}&level=account&date_preset=last_7d&breakdowns=publisher_platform,platform_position`),
    ]);

    const data = {
      today: summarize(todayRows),
      last7days: summarize(last7Rows),
      byAd: perAdRows.map(r => ({
        name: r.ad_name || 'unnamed',
        spend: num(r.spend),
        impressions: int(r.impressions),
        clicks: int(r.clicks),
        ctr: num(r.ctr),
        cpc: num(r.cpc),
      })),
      byPlacement: perPlacementRows.map(r => ({
        placement: placementKey(r),
        spend: num(r.spend),
        impressions: int(r.impressions),
        clicks: int(r.clicks),
        ctr: num(r.ctr),
      })),
    };

    cache.data = data;
    cache.at = Date.now();
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: `Meta API error: ${err.message}` });
  }
};

function checkAuth(req, res) {
  const expected = process.env.DASHBOARD_PASSWORD;
  const token = req.headers['x-auth-token'];
  if (!expected || !token || token !== expected) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

async function fetchInsights(accountId, token, query) {
  const url = `https://graph.facebook.com/v21.0/${accountId}/insights?${query}&access_token=${encodeURIComponent(token)}`;
  const r = await fetch(url);
  const body = await r.json();
  if (!r.ok || body.error) {
    throw new Error(body.error?.message || `HTTP ${r.status}`);
  }
  return body.data || [];
}

function summarize(rows) {
  const spend = sum(rows, 'spend');
  const impressions = sum(rows, 'impressions');
  const clicks = sum(rows, 'clicks');
  const reach = sum(rows, 'reach');
  return {
    spend: round2(spend),
    impressions,
    clicks,
    reach,
    ctr: impressions ? round2((clicks / impressions) * 100) : 0,
    cpc: clicks ? round2(spend / clicks) : 0,
    cpm: impressions ? round2((spend / impressions) * 1000) : 0,
  };
}

function sum(rows, field) {
  return rows.reduce((s, r) => s + (parseFloat(r[field]) || 0), 0);
}
function num(v) { return round2(parseFloat(v) || 0); }
function int(v) { return parseInt(v, 10) || 0; }
function round2(n) { return Math.round(n * 100) / 100; }

function placementKey(r) {
  const platform = (r.publisher_platform || 'unknown').toString();
  const position = (r.platform_position || 'unknown').toString();
  // Capitalize first letter of each segment so it reads like "Facebook_Feed"
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  return `${cap(platform)}_${cap(position)}`;
}
