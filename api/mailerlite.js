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

const cache = new Map(); // range -> { data, at }
const CACHE_MS = 60 * 1000;

// Canonical normalizers. Meta ad names are user-typed ("2am Math") while
// the UTM value MailerLite sees is whatever we put in the URL template
// ("2am_math"). Placements have two sources with different spellings:
// Meta Insights API returns publisher_platform+platform_position strings
// ("Facebook_Feed", "Instagram_Instagram_reels"); the {{placement}} URL
// macro substitutes different tokens at click time ("Facebook_Mobile_Feed",
// "Instagram_Reels"). Same file MUST also be mirrored in dashboard.html.
function normalizeAdName(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_');
}

const PLACEMENT_ALIASES = {
  'facebook_mobile_feed': 'facebook_feed',
  'facebook_desktop_feed': 'facebook_feed',
  'facebook_feed': 'facebook_feed',
  'facebook_facebook_reels': 'facebook_reels',
  'facebook_reels': 'facebook_reels',
  'facebook_facebook_stories': 'facebook_stories',
  'facebook_stories': 'facebook_stories',
  'facebook_marketplace': 'facebook_marketplace',
  'facebook_right_column': 'facebook_right_column',
  'facebook_video_feeds': 'facebook_video_feeds',
  'facebook_search': 'facebook_search',
  'instagram_feed': 'instagram_feed',
  'instagram_stream': 'instagram_feed',
  'instagram_stories': 'instagram_stories',
  'instagram_story': 'instagram_stories',
  'instagram_reels': 'instagram_reels',
  'instagram_instagram_reels': 'instagram_reels',
  'instagram_explore': 'instagram_explore',
  'instagram_shop': 'instagram_shop',
  'audience_network_classic': 'audience_network',
  'audience_network_rewarded_video': 'audience_network',
  'audience_network_instream_video': 'audience_network',
  'messenger_messenger_inbox': 'messenger_inbox',
  'messenger_inbox': 'messenger_inbox',
  'messenger_messenger_stories': 'messenger_stories',
  'messenger_stories': 'messenger_stories',
};

function normalizePlacement(s) {
  const lower = String(s || '').toLowerCase().trim().replace(/\s+/g, '_');
  return PLACEMENT_ALIASES[lower] || lower;
}

module.exports = async (req, res) => {
  if (!checkAuth(req, res)) return;

  const range = normalizeRange(readQuery(req, 'range'));
  const hit = cache.get(range);
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

    // Aggregate into canonical keys so the dashboard can join against
    // normalized Meta ad names / placements (see normalizeAdName +
    // normalizePlacement above).
    const byAd = {};
    const byPlacement = {};
    for (const s of freeInWindow) {
      const adRaw = (s.fields && s.fields.utm_content) || 'unknown';
      const placementRaw = (s.fields && s.fields.utm_placement) || 'unknown';
      const ad = normalizeAdName(adRaw);
      const placement = normalizePlacement(placementRaw);
      byAd[ad] = (byAd[ad] || 0) + 1;
      byPlacement[placement] = (byPlacement[placement] || 0) + 1;
    }

    const data = {
      range,
      dashboardRange,
      subscribers: {
        free: free.length,
        paid: paid.length,
        freeInRange: freeInWindow.length,
        paidInRange: paidInWindow.length,
      },
      byAd,
      byPlacement,
    };
    cache.set(range, { data, at: Date.now() });
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
