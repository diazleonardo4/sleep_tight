// GET /api/mailerlite?range=today|7d|30d  (header: x-auth-token)
// Returns subscriber counts for the free-ebook and paid-bundle groups,
// plus breakdowns by utm_content (ad) and utm_placement for the range.
//
// Response shape:
// {
//   range: "today" | "7d" | "30d",
//   subscribers: {
//     free:         <all-time free group total>,
//     paid:         <all-time paid group total>,
//     freeInRange:  <free subs created within the range>,
//     paidInRange:  <paid subs created within the range>
//   },
//   byAd:        { "<utm_content>": count, ... },     // within range
//   byPlacement: { "<utm_placement>": count, ... }    // within range
// }

const RANGE_TO_DAYS = { today: 0, '7d': 7, '30d': 30 };

const cache = new Map(); // range -> { data, at }
const CACHE_MS = 60 * 1000;

module.exports = async (req, res) => {
  if (!checkAuth(req, res)) return;

  const range = normalizeRange(req);
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

    const since = startOfRange(range);
    const freeInWindow = free.filter(s => subscribedAt(s) >= since);
    const paidInWindow = paid.filter(s => subscribedAt(s) >= since);

    const byAd = {};
    const byPlacement = {};
    for (const s of freeInWindow) {
      const ad = (s.fields && s.fields.utm_content) || 'unknown';
      const placement = (s.fields && s.fields.utm_placement) || 'unknown';
      byAd[ad] = (byAd[ad] || 0) + 1;
      byPlacement[placement] = (byPlacement[placement] || 0) + 1;
    }

    const data = {
      range,
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

function normalizeRange(req) {
  const q = (req.query && req.query.range) || new URL(req.url, 'http://x').searchParams.get('range');
  const r = String(q || '7d').toLowerCase();
  return RANGE_TO_DAYS[r] != null ? r : '7d';
}

function startOfRange(range) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - RANGE_TO_DAYS[range]);
  return d.getTime();
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

function subscribedAt(s) {
  const v = s.subscribed_at || s.created_at;
  return v ? new Date(v).getTime() : 0;
}
