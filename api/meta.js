// GET /api/meta?range=today|7d|30d  (header: x-auth-token)
// Returns Meta Ads insights for the requested range,
// plus per-ad and per-placement breakdowns.
//
// Timezone handling:
//   1. The "today / 7d / 30d" window is computed in DASHBOARD_TIMEZONE
//      (see api/_utils/dates.js) as YYYY-MM-DD calendar dates.
//   2. Those dashboard-TZ dates go straight into Meta's `time_range`
//      as YYYY-MM-DD (the ONLY format Meta's Insights API accepts —
//      ISO datetimes and Unix timestamps both error with "(#100) Must
//      be a date representation in the format YYYY-MM-DD").
//   3. Meta interprets the dates in the AD ACCOUNT'S OWN TIMEZONE,
//      so the queried window is exactly N×24h in ad-account TZ wall
//      clock. When dashboard TZ ≠ ad account TZ (e.g. Bogotá vs LA)
//      the window edges sit ~hours off the dashboard's calendar-day
//      edges, but it's still a clean N×24h window — accepted skew.
//   4. CRITICAL: do NOT translate each endpoint of the dashboard
//      window into an ad-account-TZ date independently. The Bogotá
//      day [00:00, 23:59:59] straddles two LA dates (Apr 27 22:00 →
//      Apr 28 21:59), so converting both endpoints produced
//      since="2026-04-27", until="2026-04-28" — Meta then expands
//      that to two full LA days = ~48h, doubling the data. Instead,
//      treat the dashboard's calendar date as the date label to send
//      directly. Past attempts to send sub-day ISO datetimes also
//      failed (Meta v21 rejects them with #100).
//
// Response shape:
// {
//   range:          "today" | "7d" | "30d",
//   timeRange:      { since, until },   // as sent to Meta — YYYY-MM-DD (interpreted in META_AD_ACCOUNT_TIMEZONE)
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

const { getDateRange, normalizeRange } = require('./_utils/dates');
const {
  normalizeCampaignName,
  DIRECT_CAMPAIGN_SENTINEL,
} = require('./_utils/attribution');
const { utmFromCampaignId, campaignIdFromUtm } = require('./_utils/campaign-aliases');

const cache = new Map(); // cacheKey -> { data, at } — key includes campaign filter
const CACHE_MS = 60 * 1000;

module.exports = async (req, res) => {
  if (!checkAuth(req, res)) return;

  const range = normalizeRange(readQuery(req, 'range'));
  // The sentinel `__direct__` represents "events without a Meta-driven
  // utm_campaign" — Meta itself has no equivalent (every Meta-served
  // event has a campaign), so we short-circuit to a zeroed response
  // below. Other values get slugged + alias-resolved.
  const rawCampaignParam = readQuery(req, 'campaign') || '';
  const campaignFilter = rawCampaignParam === DIRECT_CAMPAIGN_SENTINEL
    ? DIRECT_CAMPAIGN_SENTINEL
    : normalizeCampaignName(rawCampaignParam);
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

  // Direct/Untagged → zeroed Meta response. Untagged traffic is, by
  // definition, not driven by a Meta campaign, so spend/clicks are 0.
  if (campaignFilter === DIRECT_CAMPAIGN_SENTINEL) {
    const empty = {
      range,
      campaign: DIRECT_CAMPAIGN_SENTINEL,
      timeRange: null,
      dashboardRange: getDateRange(range),
      summary: { spend: 0, impressions: 0, clicks: 0, reach: 0, ctr: 0, cpc: 0, cpm: 0 },
      byAd: [], byPlacement: [], byCampaign: [],
    };
    cache.set(cacheKey, { data: empty, at: Date.now() });
    return res.status(200).json(empty);
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

  // Pass the dashboard-TZ calendar dates straight through to Meta as
  // YYYY-MM-DD. Meta interprets them in ad-account TZ, giving exactly
  // N×24h. See the timezone block at the top for why we don't try to
  // translate the dashboard window endpoints into ad-account-TZ dates
  // independently (it produced a 48h window) and why we don't send
  // ISO datetimes (Meta rejects with #100).
  const dashboardRange = getDateRange(range);
  const timeRange = {
    since: dashboardRange.since,
    until: dashboardRange.until,
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
