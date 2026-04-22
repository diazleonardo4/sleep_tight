// GET /api/meta?range=today|7d|30d  (header: x-auth-token)
// Returns Meta Ads insights for the requested range,
// plus per-ad and per-placement breakdowns.
//
// Uses explicit time_range (since/until inclusive of today). Do NOT use
// date_preset=last_7d / last_30d — those EXCLUDE today in Meta Marketing
// API v21, which makes today's number larger than the multi-day totals.
//
// Response shape:
// {
//   range:       "today" | "7d" | "30d",
//   timeRange:   { since, until },
//   summary:     { spend, impressions, clicks, reach, ctr, cpc, cpm },
//   byAd:        [ { name, spend, impressions, clicks, ctr, cpc } ],
//   byPlacement: [ { placement, spend, impressions, clicks, ctr } ]
// }

const VALID_RANGES = ['today', '7d', '30d'];

const cache = new Map(); // range -> { data, at }
const CACHE_MS = 60 * 1000;

module.exports = async (req, res) => {
  if (!checkAuth(req, res)) return;

  const range = normalizeRange(req);
  const hit = cache.get(range);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return res.status(200).json(hit.data);
  }

  const accountId = process.env.META_AD_ACCOUNT_ID;
  const token = process.env.META_ACCESS_TOKEN;
  if (!accountId || !token) {
    return res.status(500).json({ error: 'Meta env vars not configured' });
  }

  const timeRange = getDateRange(range);
  const timeRangeParam = `time_range=${encodeURIComponent(JSON.stringify(timeRange))}`;

  try {
    const baseFields = 'spend,impressions,clicks,ctr,cpc,cpm,reach';
    const [summaryRows, perAdRows, perPlacementRows] = await Promise.all([
      fetchInsights(accountId, token, `fields=${baseFields}&level=account&${timeRangeParam}`),
      fetchInsights(accountId, token, `fields=${baseFields},ad_name&level=ad&${timeRangeParam}&limit=200`),
      fetchInsights(accountId, token, `fields=${baseFields}&level=account&${timeRangeParam}&breakdowns=publisher_platform,platform_position`),
    ]);

    const data = {
      range,
      timeRange,
      summary: summarize(summaryRows),
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

    cache.set(range, { data, at: Date.now() });
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: `Meta API error: ${err.message}` });
  }
};

function normalizeRange(req) {
  const q = (req.query && req.query.range) || new URL(req.url, 'http://x').searchParams.get('range');
  const r = String(q || '7d').toLowerCase();
  return VALID_RANGES.includes(r) ? r : '7d';
}

// Returns { since, until } as YYYY-MM-DD, INCLUSIVE of today.
// today => 1-day window [today, today]
// 7d    => 7-day window [today-6, today]
// 30d   => 30-day window [today-29, today]
function getDateRange(range) {
  const now = new Date();
  const until = now.toISOString().slice(0, 10);
  if (range === 'today') return { since: until, until };
  const daysBack = range === '30d' ? 29 : 6;
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - daysBack);
  return { since: from.toISOString().slice(0, 10), until };
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
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  return `${cap(platform)}_${cap(position)}`;
}
