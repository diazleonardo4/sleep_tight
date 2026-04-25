// GET /api/analytics?range=today|7d|30d  (header: x-auth-token)
// Aggregated self-hosted analytics consumed by the dashboard.
//
// Strategy:
//   - Pre-aggregated counters (pageviews, cta_click, scroll_depth buckets,
//     form_focus, form_submit_*, exit_intent totals) are MGET'd across the
//     relevant dates in a single round trip.
//   - Uniques come from HyperLogLog PFCOUNT across date keys.
//   - Breakdowns that aren't pre-aggregated (country, device, exit_intent
//     by reason, cta_click by location, utm_content/placement) are
//     computed by scanning the raw `events:<date>` ZSETs. For the
//     dashboard's three fixed ranges (1/7/30 days) this is cheap.
//
// Response is cached in memory for 60s per range.

const { getRedis } = require('../lib/redis');
const { getDateRange, normalizeRange } = require('./_utils/dates');
const {
  normalizeCampaignName,
  eventMatchesCampaign,
  DIRECT_CAMPAIGN_SENTINEL,
} = require('./_utils/attribution');

const SCAN_EVENTS = new Set([
  'pageview', 'cta_click', 'scroll_depth', 'form_focus',
  'form_submit_success', 'form_submit_error', 'exit_intent',
]);

const cache = new Map(); // cacheKey -> { data, at } — key includes campaign filter
const CACHE_MS = 60 * 1000;

module.exports = async (req, res) => {
  if (!checkAuth(req, res)) return;

  const range = normalizeRange(readQuery(req, 'range'));
  // Optional campaign filter. When set, totals + breakdowns restrict to
  // events whose utm_campaign matches; uniques fall back to scan-derived
  // distinct visitor_ids (HLL is per-day, not per-campaign).
  // The literal sentinel `__direct__` bypasses normalization — it's the
  // wire value for "filter to events without a utm_campaign".
  const rawCampaignParam = readQuery(req, 'campaign') || '';
  const campaignFilter = rawCampaignParam === DIRECT_CAMPAIGN_SENTINEL
    ? DIRECT_CAMPAIGN_SENTINEL
    : normalizeCampaignName(rawCampaignParam);
  const cacheKey = `${range}:${campaignFilter || 'all'}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return res.status(200).json(hit.data);
  }

  const redis = getRedis();
  const { since, until } = getDateRange(range);
  const dates = enumerateDates(since, until);

  try {
    const data = await buildReport(redis, dates, campaignFilter);
    data.range = range;
    data.campaign = campaignFilter || null;
    data.dashboardRange = { since, until };
    cache.set(cacheKey, { data, at: Date.now() });
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: `Analytics error: ${err.message}` });
  }
};

async function buildReport(redis, dates, campaignFilter) {
  // Read strategy:
  //   - No filter → MGET pre-aggregated totals (one round trip, fast).
  //   - Filter set → derive totals from the raw event scan further down.
  //     The scan parses every event in the range anyway (for breakdowns,
  //     visitor stats, the byCampaign comparison aggregate), so getting
  //     filtered totals from it is free — and it's the only path that
  //     can correctly handle events that may not have been bucketed
  //     into per-campaign keys at ingest time. We deliberately do NOT
  //     write per-campaign counter keys; the raw event scan IS the
  //     filter path.
  let pageviewsTotal = 0, ctaClickTotal = 0, formFocusTotal = 0;
  let formSuccessTotal = 0, formErrorTotal = 0, exitIntentTotal = 0;
  if (!campaignFilter) {
    const pageviewKeys = dates.map(d => `count:${d}:pageview`);
    const ctaClickKeys = dates.map(d => `count:${d}:cta_click`);
    const formFocusKeys = dates.map(d => `count:${d}:form_focus`);
    const formSuccessKeys = dates.map(d => `count:${d}:form_submit_success`);
    const formErrorKeys = dates.map(d => `count:${d}:form_submit_error`);
    const exitIntentKeys = dates.map(d => `count:${d}:exit_intent`);
    const mgetKeys = [
      ...pageviewKeys, ...ctaClickKeys, ...formFocusKeys,
      ...formSuccessKeys, ...formErrorKeys, ...exitIntentKeys,
    ];
    const mgetVals = mgetKeys.length ? await redis.mget(...mgetKeys) : [];
    const sumSlice = (i) => {
      const start = i * dates.length;
      return mgetVals.slice(start, start + dates.length).reduce((s, v) => s + (parseInt(v, 10) || 0), 0);
    };
    pageviewsTotal = sumSlice(0);
    ctaClickTotal = sumSlice(1);
    formFocusTotal = sumSlice(2);
    formSuccessTotal = sumSlice(3);
    formErrorTotal = sumSlice(4);
    exitIntentTotal = sumSlice(5);
  }

  // Unique pageviews. Two paths, picked by whether a filter is active:
  //   - No filter → PFCOUNT union of the global per-day HLLs (cheap,
  //     accurate to ~0.8%).
  //   - Filter set → distinct visitor_id Set assembled in the scan
  //     loop below (filteredUniqueVisitors). Exact for the filtered
  //     subset; no separate per-campaign HLL needed.
  let uniquePageviews = 0;
  if (!campaignFilter) {
    const uniqueKeys = dates.map(d => `uniques:${d}`);
    if (uniqueKeys.length === 1) {
      uniquePageviews = (await redis.pfcount(uniqueKeys[0])) || 0;
    } else if (uniqueKeys.length > 1) {
      uniquePageviews = (await redis.pfcount(...uniqueKeys)) || 0;
    }
  }

  // Scan raw events for breakdowns. Parse once, attribute many times.
  const scanLists = await Promise.all(dates.map(d => redis.zrange(`events:${d}`, 0, -1)));
  const allRaw = [].concat(...scanLists);

  const breakdowns = {
    byUtmContent: {},
    byUtmPlacement: {},
    byCountry: {},
    byDevice: {},
  };
  const ctaByLocation = {};
  const exitByReason = {};
  const scrollDepthBuckets = { 25: 0, 50: 0, 75: 0, 100: 0 };
  const topReferrers = {};

  // Dimensional breakdowns (country / browser / os / device_type). Each
  // map: dimValue → { pageviews, subs, visitors:Set, engagedVisitors:Set }.
  // Materialized at output time as arrays of {value, pageviews,
  // unique_visitors, engaged, engagement_rate, subs}, sorted desc by
  // pageviews. Missing dim values bucket as 'unknown' per the spec.
  //
  // Engagement attribution is pinned to the visitor's pageview dims (see
  // visitorDims below) so engagement_rate stays bounded at <= 1.0 even
  // when a visitor's scroll event happens to carry slightly different
  // dim values (e.g. UA parser hiccup mid-session).
  const DIM_FIELDS = ['country', 'browser', 'os', 'device_type'];
  const dimMaps = {
    country: new Map(),
    browser: new Map(),
    os: new Map(),
    device_type: new Map(),
  };
  const dimBucket = (dim, val) => {
    const m = dimMaps[dim];
    let v = m.get(val);
    if (!v) {
      v = { pageviews: 0, subs: 0, visitors: new Set(), engagedVisitors: new Set() };
      m.set(val, v);
    }
    return v;
  };
  const visitorDims = new Map(); // vid -> { country, browser, os, device_type }

  // Per-campaign aggregates — built unconditionally so the dashboard's
  // comparison table can always show every campaign side-by-side, even
  // when a campaign filter is active for the rest of the response.
  // utm_campaign(normalized) → { pageviews, submits, visitors:Set,
  // engagedVisitors:Set }. unique = visitors.size; engaged =
  // engagedVisitors.size at output time.
  const campaignStats = new Map();
  const campaignBucket = (camp) => {
    let v = campaignStats.get(camp);
    if (!v) {
      v = { pageviews: 0, submits: 0, visitors: new Set(), engagedVisitors: new Set() };
      campaignStats.set(camp, v);
    }
    return v;
  };

  // Scan-derived uniques for the campaign-filter case. Tracks distinct
  // visitor_ids that produced a pageview within the filtered set.
  const filteredUniqueVisitors = new Set();

  // Per-visitor tracking for the visitors aggregates block.
  // visitorStats: vid -> { dates, pageviews, engagedScroll, nonPageviewEvents }
  // nonPageviewEvents is the count of events that are NOT pageview — a visitor
  // with pageviews>=1 and nonPageviewEvents===0 is a bounce. engagedScroll is
  // true once we've seen a scroll_depth >= 50 for the visitor — that's the
  // funnel's "Engaged" stage.
  const visitorStats = new Map();
  let totalEventsInRange = 0;

  // Scan-derived per-event counts. Always tallied; used as the source of
  // truth for the response totals when a campaign filter is active
  // (the MGET path is skipped in that case — see top of buildReport).
  const scanTotals = {
    pageview: 0, cta_click: 0, form_focus: 0,
    form_submit_success: 0, form_submit_error: 0, exit_intent: 0,
  };

  for (const raw of allRaw) {
    let e;
    try { e = JSON.parse(raw); } catch (_) { continue; }
    if (!e || !SCAN_EVENTS.has(e.event)) continue;

    // Slug + alias-resolve. Empty string here means the event has no
    // utm_campaign — bucketed under DIRECT_CAMPAIGN_SENTINEL for the
    // comparison table so untagged traffic always has a row.
    const eventCampaign = normalizeCampaignName(e.utm_campaign || '');
    const campaignKey = eventCampaign || DIRECT_CAMPAIGN_SENTINEL;

    // Always feed the byCampaign aggregate (independent of any filter)
    // so the comparison table sees every campaign — including
    // Direct/Untagged — for the entire date range.
    {
      const cs = campaignBucket(campaignKey);
      if (e.event === 'pageview') {
        cs.pageviews++;
        if (e.visitor_id) cs.visitors.add(e.visitor_id);
      }
      if (e.event === 'form_submit_success') cs.submits++;
      if (e.event === 'scroll_depth') {
        const d = Number(e.metadata?.depth);
        if (d >= 50 && e.visitor_id) cs.engagedVisitors.add(e.visitor_id);
      }
    }

    // Page-level filter: skip events outside the selected campaign for
    // every other aggregate (visitors, breakdowns, scroll buckets, etc.).
    if (!eventMatchesCampaign(e.utm_campaign, campaignFilter)) continue;

    if (campaignFilter && e.event === 'pageview' && e.visitor_id) {
      filteredUniqueVisitors.add(e.visitor_id);
    }

    if (scanTotals[e.event] != null) {
      scanTotals[e.event]++;
    }

    totalEventsInRange++;

    const vid = e.visitor_id;
    if (vid) {
      let vs = visitorStats.get(vid);
      if (!vs) {
        vs = { dates: new Set(), pageviews: 0, nonPageviewEvents: 0, engagedScroll: false };
        visitorStats.set(vid, vs);
      }
      if (e.date) vs.dates.add(e.date);
      if (e.event === 'pageview') {
        vs.pageviews++;
      } else {
        vs.nonPageviewEvents++;
      }
      if (e.event === 'scroll_depth') {
        const d = Number(e.metadata?.depth);
        if (d >= 50) vs.engagedScroll = true;
      }
    }

    if (e.event === 'pageview') {
      if (e.country) breakdowns.byCountry[e.country] = (breakdowns.byCountry[e.country] || 0) + 1;
      if (e.device_type) breakdowns.byDevice[e.device_type] = (breakdowns.byDevice[e.device_type] || 0) + 1;
      if (e.utm_content) breakdowns.byUtmContent[e.utm_content] = (breakdowns.byUtmContent[e.utm_content] || 0) + 1;
      if (e.utm_placement) breakdowns.byUtmPlacement[e.utm_placement] = (breakdowns.byUtmPlacement[e.utm_placement] || 0) + 1;
      const ref = normalizeReferrer(e.referrer);
      if (ref) topReferrers[ref] = (topReferrers[ref] || 0) + 1;

      // Dimensional breakdowns — pageviews + visitors set. Capture this
      // visitor's dims here (first pageview wins) so we can attribute
      // their engagement back to the right buckets when scroll arrives.
      const dimValues = {};
      for (const dim of DIM_FIELDS) {
        const v = e[dim] || 'unknown';
        dimValues[dim] = v;
        const b = dimBucket(dim, v);
        b.pageviews++;
        if (e.visitor_id) b.visitors.add(e.visitor_id);
      }
      if (e.visitor_id && !visitorDims.has(e.visitor_id)) {
        visitorDims.set(e.visitor_id, dimValues);
      }
    }

    if (e.event === 'form_submit_success') {
      // subs is a count of submit events (not distinct visitors) per spec.
      for (const dim of DIM_FIELDS) {
        dimBucket(dim, e[dim] || 'unknown').subs++;
      }
    }

    if (e.event === 'cta_click') {
      const loc = e.metadata?.cta_location || 'unknown';
      ctaByLocation[loc] = (ctaByLocation[loc] || 0) + 1;
    }

    if (e.event === 'exit_intent') {
      const reason = e.metadata?.reason || 'unknown';
      exitByReason[reason] = (exitByReason[reason] || 0) + 1;
    }

    if (e.event === 'scroll_depth') {
      const d = Number(e.metadata?.depth);
      if (scrollDepthBuckets[d] != null) scrollDepthBuckets[d]++;

      // Per-dim engagement: a visitor counts once per dim bucket they
      // belong to, the first time they cross the 50% scroll threshold.
      // Attribute to the visitor's pageview dims if known, otherwise
      // fall back to the scroll event's own dim values.
      if (d >= 50 && e.visitor_id) {
        const dims = visitorDims.get(e.visitor_id);
        for (const dim of DIM_FIELDS) {
          const val = dims ? dims[dim] : (e[dim] || 'unknown');
          dimBucket(dim, val).engagedVisitors.add(e.visitor_id);
        }
      }
    }
  }

  // Visitor aggregates. totalUnique uses the HLL (cheap, accurate to ~0.8%);
  // the rest come from the scan since HLL can't enumerate members.
  let returningVisitors = 0;
  let singlePageviewBounces = 0;
  let engagedVisitors = 0;
  for (const vs of visitorStats.values()) {
    if (vs.dates.size > 1) returningVisitors++;
    if (vs.pageviews >= 1 && vs.nonPageviewEvents === 0) singlePageviewBounces++;
    if (vs.pageviews >= 1 && vs.engagedScroll) engagedVisitors++;
  }
  const scannedVisitors = visitorStats.size;
  const avgEventsPerVisitor = scannedVisitors > 0
    ? +(totalEventsInRange / scannedVisitors).toFixed(2)
    : 0;

  // Filtered case: uniques come straight from the scan-derived set.
  if (campaignFilter) {
    uniquePageviews = filteredUniqueVisitors.size;
  }

  // When filter is active, totals come from the scan (the only path
  // that's correct for events without per-campaign counter keys, and
  // also the only path that's robust against ingest-time normalization
  // drift). Otherwise the MGET pre-aggregates already populated above.
  let pageviewsTotalFinal = pageviewsTotal;
  let ctaClickTotalFinal = ctaClickTotal;
  let formFocusTotalFinal = formFocusTotal;
  let formSuccessTotalFinal = formSuccessTotal;
  let formErrorTotalFinal = formErrorTotal;
  let exitIntentTotalFinal = exitIntentTotal;
  if (campaignFilter) {
    pageviewsTotalFinal = scanTotals.pageview;
    ctaClickTotalFinal = scanTotals.cta_click;
    formFocusTotalFinal = scanTotals.form_focus;
    formSuccessTotalFinal = scanTotals.form_submit_success;
    formErrorTotalFinal = scanTotals.form_submit_error;
    exitIntentTotalFinal = scanTotals.exit_intent;
  }

  // Materialize the per-dimension breakdowns. Each row uses its own
  // canonical key (country / browser / os / device_type) so the
  // dashboard can render them with the same render fn but different
  // value lookups (flag map for country, title-case for the rest).
  const materializeDim = (dim, valueKey) => Array.from(dimMaps[dim].entries())
    .map(([val, s]) => {
      const unique = s.visitors.size;
      const engaged = s.engagedVisitors.size;
      return {
        [valueKey]: val,
        pageviews: s.pageviews,
        unique_visitors: unique,
        engaged,
        engagement_rate: unique ? +(engaged / unique).toFixed(2) : 0,
        subs: s.subs,
      };
    })
    .filter(r => r.pageviews > 0)
    .sort((a, b) => b.pageviews - a.pageviews);

  const byCountry = materializeDim('country', 'country');
  const byBrowser = materializeDim('browser', 'browser');
  const byOs = materializeDim('os', 'os');
  const byDevice = materializeDim('device_type', 'device_type');

  // Materialize the byCampaign array. Sorted by submits desc, then
  // pageviews desc — winners-first ordering for the dashboard.
  const byCampaign = Array.from(campaignStats.entries())
    .map(([campaign, s]) => {
      const unique = s.visitors.size;
      const engaged = s.engagedVisitors.size;
      return {
        campaign,
        pageviews: s.pageviews,
        unique,
        engaged,
        submits: s.submits,
        engagementRate: s.pageviews ? +(engaged / s.pageviews).toFixed(4) : 0,
      };
    })
    .filter(c => c.pageviews > 0 || c.submits > 0)
    .sort((a, b) => (b.submits - a.submits) || (b.pageviews - a.pageviews));

  return {
    pageviews: { total: pageviewsTotalFinal, unique: uniquePageviews },
    visitors: {
      total_unique: uniquePageviews,
      avg_events_per_visitor: avgEventsPerVisitor,
      returning_visitors: returningVisitors,
      single_pageview_bounces: singlePageviewBounces,
      engaged_visitors: engagedVisitors,
      scanned_visitors: scannedVisitors,
    },
    events: {
      cta_click: { total: ctaClickTotalFinal, byLocation: ctaByLocation },
      scroll_depth: scrollDepthBuckets,
      form_focus: formFocusTotalFinal,
      form_submit_success: formSuccessTotalFinal,
      form_submit_error: formErrorTotalFinal,
      exit_intent: { total: exitIntentTotalFinal, byReason: exitByReason },
    },
    breakdowns: {
      ...breakdowns,
      topReferrers,
    },
    byCampaign,
    byCountry,
    byBrowser,
    byOs,
    byDevice,
  };
}

function enumerateDates(since, until) {
  // since/until are already YYYY-MM-DD in dashboard TZ. We only need the
  // set of date-string keys between them — parse each string into UTC
  // components, increment by a day, and re-format from UTC components.
  // No toISOString slicing (which would silently TZ-shift).
  const out = [];
  const [sy, sm, sd] = since.split('-').map(Number);
  const [uy, um, ud] = until.split('-').map(Number);
  if (!sy || !uy) return [since];
  const start = Date.UTC(sy, sm - 1, sd);
  const end = Date.UTC(uy, um - 1, ud);
  if (end < start) return [since];
  for (let t = start; t <= end; t += 86400000) {
    const d = new Date(t);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    out.push(`${y}-${m}-${day}`);
  }
  return out;
}

function normalizeReferrer(ref) {
  if (!ref) return '';
  try {
    const host = new URL(ref).hostname.replace(/^www\./, '');
    return host || '';
  } catch (_) {
    return '';
  }
}

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
