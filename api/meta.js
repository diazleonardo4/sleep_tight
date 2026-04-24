// GET /api/meta?range=today|7d|30d  (header: x-auth-token)
// Returns Meta Ads insights for the requested range,
// plus per-ad and per-placement breakdowns.
//
// Timezone handling:
//   - "today / 7d / 30d" windows are computed in DASHBOARD_TIMEZONE
//     (see api/_utils/dates.js) and sent to Meta verbatim. Meta
//     interprets the YYYY-MM-DD strings in the AD ACCOUNT timezone's
//     wall-clock, so the window may shift by a few hours of UTC vs.
//     the dashboard TZ. That's deliberate — it keeps the dashboard's
//     "Today" aligned to the exact calendar day the user sees when
//     setting Meta Ads Manager's date picker to "Today" in the same
//     zone. Earlier we translated dashboard boundaries → ad account TZ
//     which caused an off-by-one when the ad account TZ sat west of
//     the dashboard TZ (e.g. LA vs Bogota).
//
// Response shape:
// {
//   range:       "today" | "7d" | "30d",
//   timeRange:   { since, until },           // as sent to Meta — matches dashboardRange
//   dashboardRange: { since, until },        // original dashboard-TZ window
//   summary:     { spend, impressions, clicks, reach, ctr, cpc, cpm },
//   byAd:        [ { name, spend, impressions, clicks, ctr, cpc } ],
//   byPlacement: [ { placement, spend, impressions, clicks, ctr } ]
// }
//
// Note: `clicks` in every output object is Meta's `inline_link_clicks`
// (landing-page clicks — what Meta Ads Manager reports as "Results"),
// NOT the raw `clicks` field (which also counts likes, comments, post
// expands, etc.). CTR and CPC are derived from link clicks on our side.
//
// Monetary values (spend, cpc, cpm) come back in the ad account's
// currency — the dashboard handles display-side conversion.

const { getDateRange, normalizeRange } = require('./_utils/dates');

const cache = new Map(); // range -> { data, at }
const CACHE_MS = 60 * 1000;

module.exports = async (req, res) => {
  if (!checkAuth(req, res)) return;

  const range = normalizeRange(readQuery(req, 'range'));
  const hit = cache.get(range);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return res.status(200).json(hit.data);
  }

  const accountId = process.env.META_AD_ACCOUNT_ID;
  const token = process.env.META_ACCESS_TOKEN;
  if (!accountId || !token) {
    return res.status(500).json({ error: 'Meta env vars not configured' });
  }

  const dashboardRange = getDateRange(range);
  const timeRange = dashboardRange;
  const timeRangeParam = `time_range=${encodeURIComponent(JSON.stringify(timeRange))}`;

  try {
    // Pull inline_link_clicks (Meta's "Results" in Ads Manager) instead of
    // the raw `clicks` field. `clicks` counts every engagement — likes,
    // comments, post-expands, profile clicks — which inflates CTR and
    // deflates CPC vs. real landing-page traffic. We compute CTR/CPC from
    // link clicks ourselves rather than asking Meta (its returned ctr/cpc
    // are derived from raw clicks).
    const baseFields = 'spend,impressions,inline_link_clicks,cpm,reach';
    const [summaryRows, perAdRows, perPlacementRows] = await Promise.all([
      fetchInsights(accountId, token, `fields=${baseFields}&level=account&${timeRangeParam}`),
      fetchInsights(accountId, token, `fields=${baseFields},ad_name&level=ad&${timeRangeParam}&limit=200`),
      fetchInsights(accountId, token, `fields=${baseFields}&level=account&${timeRangeParam}&breakdowns=publisher_platform,platform_position`),
    ]);

    const data = {
      range,
      timeRange,
      dashboardRange,
      summary: summarize(summaryRows),
      byAd: perAdRows.map(r => {
        const spend = parseFloat(r.spend) || 0;
        const impressions = int(r.impressions);
        const linkClicks = int(r.inline_link_clicks);
        return {
          name: r.ad_name || 'unnamed',
          spend: round2(spend),
          impressions,
          clicks: linkClicks,
          ctr: impressions ? round2((linkClicks / impressions) * 100) : 0,
          cpc: linkClicks ? round2(spend / linkClicks) : 0,
        };
      }),
      byPlacement: perPlacementRows.map(r => {
        const spend = parseFloat(r.spend) || 0;
        const impressions = int(r.impressions);
        const linkClicks = int(r.inline_link_clicks);
        return {
          placement: placementKey(r),
          spend: round2(spend),
          impressions,
          clicks: linkClicks,
          ctr: impressions ? round2((linkClicks / impressions) * 100) : 0,
        };
      }),
    };

    cache.set(range, { data, at: Date.now() });
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: `Meta API error: ${err.message}` });
  }
};

function readQuery(req, key) {
  if (req.query && req.query[key]) return req.query[key];
  return new URL(req.url, 'http://x').searchParams.get(key);
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
  const linkClicks = sum(rows, 'inline_link_clicks');
  const reach = sum(rows, 'reach');
  return {
    spend: round2(spend),
    impressions,
    clicks: linkClicks,
    reach,
    ctr: impressions ? round2((linkClicks / impressions) * 100) : 0,
    cpc: linkClicks ? round2(spend / linkClicks) : 0,
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
