// GET /api/meta?range=today|7d|30d  (header: x-auth-token)
// Returns Meta Ads insights for the requested range,
// plus per-ad and per-placement breakdowns.
//
// Timezone handling:
//   1. The "today / 7d / 30d" window is computed in DASHBOARD_TIMEZONE
//      (see api/_utils/dates.js) and turned into real epoch-ms boundaries.
//   2. Those boundaries are translated into YYYY-MM-DD strings in the
//      Meta ad account's own TZ (META_AD_ACCOUNT_TIMEZONE — see
//      api/_utils/meta-tz.js) and that's what gets sent to Meta's
//      Insights API, because Meta interprets time_range in the ad
//      account TZ's wall clock, not dashboard TZ.
//   3. Because Meta's time_range is day-granularity, the returned
//      numbers cover slightly more than the exact dashboard window at
//      the edges (a couple hours of overlap into Meta's previous or
//      next day). This is an accepted trade-off for Meta's API
//      limitation — precise sub-day alignment would require pulling
//      time_increment=1 hourly rows and filtering in code.
//
// Response shape:
// {
//   range:          "today" | "7d" | "30d",
//   timeRange:      { since, until },   // as sent to Meta — dates in META_AD_ACCOUNT_TIMEZONE
//   dashboardRange: { since, until },   // original dashboard-TZ window (what the UI shows)
//   summary:        { spend, impressions, clicks, reach, ctr, cpc, cpm },
//   byAd:           [ { name, spend, impressions, clicks, ctr, cpc } ],
//   byPlacement:    [ { placement, spend, impressions, clicks, ctr } ]
// }
//
// Note: `clicks` in every output object is Meta's `inline_link_clicks`
// (landing-page clicks — what Meta Ads Manager reports as "Results"),
// NOT the raw `clicks` field (which also counts likes, comments, post
// expands, etc.). CTR and CPC are derived from link clicks on our side.
//
// Monetary values (spend, cpc, cpm) come back in the ad account's
// currency — the dashboard handles display-side conversion.

const { getDateRange, normalizeRange, getDashboardDayBoundaries } = require('./_utils/dates');
const { utcToMetaDate } = require('./_utils/meta-tz');
const { normalizeCampaignName } = require('./_utils/attribution');
const { utmFromCampaignId, campaignIdFromUtm } = require('./_utils/campaign-aliases');

const cache = new Map(); // cacheKey -> { data, at } — key includes campaign filter
const CACHE_MS = 60 * 1000;

module.exports = async (req, res) => {
  if (!checkAuth(req, res)) return;

  const range = normalizeRange(readQuery(req, 'range'));
  const campaignFilter = normalizeCampaignName(readQuery(req, 'campaign') || '');
  const cacheKey = `${range}:${campaignFilter || 'all'}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return res.status(200).json(hit.data);
  }

  const accountId = process.env.META_AD_ACCOUNT_ID;
  const token = process.env.META_ACCESS_TOKEN;
  if (!accountId || !token) {
    return res.status(500).json({ error: 'Meta env vars not configured' });
  }

  // Campaign filter → resolve to a Meta campaign_id via the alias map.
  // An unknown utm_campaign produces an empty response rather than a
  // silent unfiltered query — that catches typos in the URL early.
  let campaignIdFilter = null;
  if (campaignFilter) {
    campaignIdFilter = campaignIdFromUtm(campaignFilter);
    if (!campaignIdFilter) {
      const empty = {
        range,
        campaign: campaignFilter,
        timeRange: null,
        dashboardRange: getDateRange(range),
        summary: { spend: 0, impressions: 0, clicks: 0, reach: 0, ctr: 0, cpc: 0, cpm: 0 },
        byAd: [], byPlacement: [], byCampaign: [],
        warning: `Unknown utm_campaign "${campaignFilter}" — add it to api/_utils/campaign-aliases.js.`,
      };
      cache.set(cacheKey, { data: empty, at: Date.now() });
      return res.status(200).json(empty);
    }
  }

  // Translate dashboard-TZ window → epoch boundaries → Meta-TZ dates.
  // This is the one place in the codebase where Meta's timezone matters.
  // Using endMs - 1 on `until` keeps the final moment inside the window
  // rather than crossing into the next day.
  const dashboardRange = getDateRange(range);
  const { startMs } = getDashboardDayBoundaries(dashboardRange.since);
  const { endMs } = getDashboardDayBoundaries(dashboardRange.until);
  const timeRange = {
    since: utcToMetaDate(startMs),
    until: utcToMetaDate(endMs - 1),
  };
  const timeRangeParam = `time_range=${encodeURIComponent(JSON.stringify(timeRange))}`;

  // Campaign filter → Meta `filtering` parameter on campaign.id. Applied
  // to summary / byAd / byPlacement so they match the filtered scope.
  // Always fetch byCampaign without this filter so the comparison table
  // can show every campaign side-by-side regardless of selection.
  const filteringParam = campaignIdFilter
    ? `&filtering=${encodeURIComponent(JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: [campaignIdFilter] }]))}`
    : '';

  try {
    // Pull inline_link_clicks (Meta's "Results" in Ads Manager) instead of
    // the raw `clicks` field. `clicks` counts every engagement — likes,
    // comments, post-expands, profile clicks — which inflates CTR and
    // deflates CPC vs. real landing-page traffic. We compute CTR/CPC from
    // link clicks ourselves rather than asking Meta (its returned ctr/cpc
    // are derived from raw clicks).
    const baseFields = 'spend,impressions,inline_link_clicks,cpm,reach';
    const [summaryRows, perAdRows, perPlacementRows, perCampaignRows] = await Promise.all([
      fetchInsights(accountId, token, `fields=${baseFields}&level=account&${timeRangeParam}${filteringParam}`),
      fetchInsights(accountId, token, `fields=${baseFields},ad_name&level=ad&${timeRangeParam}${filteringParam}&limit=200`),
      fetchInsights(accountId, token, `fields=${baseFields}&level=account&${timeRangeParam}&breakdowns=publisher_platform,platform_position${filteringParam}`),
      fetchInsights(accountId, token, `fields=${baseFields},campaign_name,campaign_id&level=campaign&${timeRangeParam}&limit=100`),
    ]);

    const data = {
      range,
      campaign: campaignFilter || null,
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
      byCampaign: perCampaignRows.map(r => {
        const spend = parseFloat(r.spend) || 0;
        const impressions = int(r.impressions);
        const linkClicks = int(r.inline_link_clicks);
        const utm = utmFromCampaignId(r.campaign_id);
        return {
          campaign_id: String(r.campaign_id || ''),
          campaign_name: r.campaign_name || 'unnamed',
          // utm_campaign is the canonical join key — null if the campaign
          // hasn't been added to api/_utils/campaign-aliases.js yet. The
          // dashboard surfaces unmapped campaigns via the raw campaign_name.
          utm_campaign: utm,
          spend: round2(spend),
          impressions,
          clicks: linkClicks,
          ctr: impressions ? round2((linkClicks / impressions) * 100) : 0,
          cpc: linkClicks ? round2(spend / linkClicks) : 0,
        };
      }),
    };

    cache.set(cacheKey, { data, at: Date.now() });
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
