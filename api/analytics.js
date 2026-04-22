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

const SCAN_EVENTS = new Set([
  'pageview', 'cta_click', 'scroll_depth', 'form_focus',
  'form_submit_success', 'form_submit_error', 'exit_intent',
]);

const cache = new Map(); // range -> { data, at }
const CACHE_MS = 60 * 1000;

module.exports = async (req, res) => {
  if (!checkAuth(req, res)) return;

  const range = normalizeRange(readQuery(req, 'range'));
  const hit = cache.get(range);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return res.status(200).json(hit.data);
  }

  const redis = getRedis();
  const { since, until } = getDateRange(range);
  const dates = enumerateDates(since, until);

  try {
    const data = await buildReport(redis, dates);
    data.range = range;
    data.dashboardRange = { since, until };
    cache.set(range, { data, at: Date.now() });
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: `Analytics error: ${err.message}` });
  }
};

async function buildReport(redis, dates) {
  const pageviewKeys = dates.map(d => `count:${d}:pageview`);
  const ctaClickKeys = dates.map(d => `count:${d}:cta_click`);
  const formFocusKeys = dates.map(d => `count:${d}:form_focus`);
  const formSuccessKeys = dates.map(d => `count:${d}:form_submit_success`);
  const formErrorKeys = dates.map(d => `count:${d}:form_submit_error`);
  const exitIntentKeys = dates.map(d => `count:${d}:exit_intent`);

  // One round trip for all pre-aggregated totals.
  const mgetKeys = [
    ...pageviewKeys, ...ctaClickKeys, ...formFocusKeys,
    ...formSuccessKeys, ...formErrorKeys, ...exitIntentKeys,
  ];
  const mgetVals = mgetKeys.length ? await redis.mget(...mgetKeys) : [];
  const sumSlice = (i) => {
    const start = i * dates.length;
    return mgetVals.slice(start, start + dates.length).reduce((s, v) => s + (parseInt(v, 10) || 0), 0);
  };
  const pageviewsTotal = sumSlice(0);
  const ctaClickTotal = sumSlice(1);
  const formFocusTotal = sumSlice(2);
  const formSuccessTotal = sumSlice(3);
  const formErrorTotal = sumSlice(4);
  const exitIntentTotal = sumSlice(5);

  // Unique visitors — HyperLogLog union across day keys.
  const uniqueKeys = dates.map(d => `uniques:${d}`);
  let uniquePageviews = 0;
  if (uniqueKeys.length === 1) {
    uniquePageviews = (await redis.pfcount(uniqueKeys[0])) || 0;
  } else if (uniqueKeys.length > 1) {
    // PFCOUNT with multiple keys returns the cardinality of the union.
    uniquePageviews = (await redis.pfcount(...uniqueKeys)) || 0;
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

  for (const raw of allRaw) {
    let e;
    try { e = JSON.parse(raw); } catch (_) { continue; }
    if (!e || !SCAN_EVENTS.has(e.event)) continue;

    if (e.event === 'pageview') {
      if (e.country) breakdowns.byCountry[e.country] = (breakdowns.byCountry[e.country] || 0) + 1;
      if (e.device_type) breakdowns.byDevice[e.device_type] = (breakdowns.byDevice[e.device_type] || 0) + 1;
      if (e.utm_content) breakdowns.byUtmContent[e.utm_content] = (breakdowns.byUtmContent[e.utm_content] || 0) + 1;
      if (e.utm_placement) breakdowns.byUtmPlacement[e.utm_placement] = (breakdowns.byUtmPlacement[e.utm_placement] || 0) + 1;
      const ref = normalizeReferrer(e.referrer);
      if (ref) topReferrers[ref] = (topReferrers[ref] || 0) + 1;
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
    }
  }

  return {
    pageviews: { total: pageviewsTotal, unique: uniquePageviews },
    events: {
      cta_click: { total: ctaClickTotal, byLocation: ctaByLocation },
      scroll_depth: scrollDepthBuckets,
      form_focus: formFocusTotal,
      form_submit_success: formSuccessTotal,
      form_submit_error: formErrorTotal,
      exit_intent: { total: exitIntentTotal, byReason: exitByReason },
    },
    breakdowns: {
      ...breakdowns,
      topReferrers,
    },
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
