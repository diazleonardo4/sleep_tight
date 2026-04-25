// GET /api/mailerlite?range=today|7d|30d  (header: x-auth-token)
// Returns subscriber counts for the free-ebook and paid-bundle groups,
// plus breakdowns by utm_content (ad) and utm_placement for the range.
//
// Timezone handling:
//   - Ranges are resolved in DASHBOARD_TIMEZONE (see _utils/dates.js).
//   - MailerLite returns subscribed_at as UTC ISO strings. Each one is
//     converted to a dashboard-TZ date (YYYY-MM-DD) and compared against
//     the range's since/until boundaries — so "today" at 10 PM Bogota
//     includes subscribers who joined between 00:00 and 23:59 Bogota
//     today, even though the server runs in UTC.
//
// Response shape:
// {
//   range: "today" | "7d" | "30d",
//   dashboardRange: { since, until },        // inclusive, YYYY-MM-DD
//   subscribers: {
//     free:         <all-time free group total>,
//     paid:         <all-time paid group total>,
//     freeInRange:  <free subs created within the range>,
//     paidInRange:  <paid subs created within the range>
//   },
//   byAd:        { "<utm_content>": count, ... },
//   byPlacement: { "<utm_placement>": count, ... }
// }

const { getDateRange, normalizeRange, utcToDashboardDate } = require('./_utils/dates');
const {
  normalizeAdName,
  normalizeCampaignName,
  normalizePlacement,
} = require('./_utils/attribution');

const cache = new Map(); // cacheKey -> { data, at } — key includes campaign filter
const CACHE_MS = 60 * 1000;

module.exports = async (req, res) => {
  if (!checkAuth(req, res)) return;

  const range = normalizeRange(readQuery(req, 'range'));
  // Optional campaign filter — when set, every aggregate (subs counts +
  // byAd / byPlacement / byCampaign breakdowns) restricts to subscribers
  // whose utm_campaign matches the filter. Empty string = no filter.
  const campaignFilter = normalizeCampaignName(readQuery(req, 'campaign') || '');
  const cacheKey = `${range}:${campaignFilter || 'all'}`;

  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return res.status(200).json(hit.data);
  }

  const token = process.env.MAILERLITE_API_TOKEN;
  const freeGroupId = process.env.MAILERLITE_FREE_EBOOK_GROUP_ID;
  const paidGroupId = process.env.MAILERLITE_PAID_BUNDLE_GROUP_ID;
  if (!token || !freeGroupId || !paidGroupId) {
    return res.status(500).json({ error: 'MailerLite env vars not configured' });
  }

  try {
    const [free, paid] = await Promise.all([
      fetchAllSubscribers(freeGroupId, token),
      fetchAllSubscribers(paidGroupId, token),
    ]);

    const dashboardRange = getDateRange(range);
    const freeInWindow = filterByRange(free, dashboardRange);
    const paidInWindow = filterByRange(paid, dashboardRange);

    // byCampaign aggregates over the *unfiltered* in-range set so the
    // dashboard's "Which campaign is winning?" comparison table can show
    // every campaign side by side, even when the page-level filter is
    // narrowed to one of them.
    const byCampaign = {};
    for (const s of freeInWindow) {
      const camp = normalizeCampaignName((s.fields && s.fields.utm_campaign) || '') || 'unknown';
      byCampaign[camp] = (byCampaign[camp] || 0) + 1;
    }

    // Apply the campaign filter for everything else (counts + byAd +
    // byPlacement). When unset, this is a no-op pass-through.
    const matchesCampaign = (s) => {
      if (!campaignFilter) return true;
      const camp = normalizeCampaignName((s.fields && s.fields.utm_campaign) || '');
      return camp === campaignFilter;
    };
    const freeInScope = freeInWindow.filter(matchesCampaign);
    const paidInScope = paidInWindow.filter(matchesCampaign);

    // Aggregate into canonical keys so the dashboard can join against
    // normalized Meta ad names / placements (see api/_utils/attribution.js).
    const byAd = {};
    const byPlacement = {};
    for (const s of freeInScope) {
      const adRaw = (s.fields && s.fields.utm_content) || 'unknown';
      const placementRaw = (s.fields && s.fields.utm_placement) || 'unknown';
      const ad = normalizeAdName(adRaw);
      const placement = normalizePlacement(placementRaw);
      byAd[ad] = (byAd[ad] || 0) + 1;
      byPlacement[placement] = (byPlacement[placement] || 0) + 1;
    }

    const data = {
      range,
      campaign: campaignFilter || null,
      dashboardRange,
      subscribers: {
        // `free` / `paid` totals are all-time and unaffected by the
        // campaign filter — they're the absolute group sizes.
        free: free.length,
        paid: paid.length,
        freeInRange: freeInScope.length,
        paidInRange: paidInScope.length,
      },
      byAd,
      byPlacement,
      byCampaign,
    };
    cache.set(cacheKey, { data, at: Date.now() });
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: `MailerLite API error: ${err.message}` });
  }
};

function filterByRange(subscribers, { since, until }) {
  return subscribers.filter(s => {
    const iso = s.subscribed_at || s.created_at;
    if (!iso) return false;
    const local = utcToDashboardDate(iso); // YYYY-MM-DD in dashboard TZ
    return local >= since && local <= until;
  });
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

async function fetchAllSubscribers(groupId, token) {
  const base = 'https://connect.mailerlite.com/api/subscribers';
  const all = [];
  const limit = 500;
  const hardCap = 10000;
  let cursor = null;

  while (true) {
    const qs = new URLSearchParams();
    qs.set('filter[group]', groupId);
    qs.set('limit', String(limit));
    if (cursor) qs.set('cursor', cursor);
    const r = await fetch(`${base}?${qs.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
    }
    const body = await r.json();
    const page = body.data || [];
    all.push(...page);
    cursor = body.meta && body.meta.next_cursor;
    if (!cursor || page.length < limit || all.length >= hardCap) break;
  }
  return all;
}
