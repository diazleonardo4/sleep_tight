// GET /api/mailerlite  (header: x-auth-token)
// Returns subscriber counts for the free-ebook and paid-bundle groups,
// plus breakdowns by utm_content (ad) and utm_placement.
//
// Response shape:
// {
//   subscribers: { free, paid, freeToday, freeLast7 },
//   byAd:        { "<utm_content>": count, ... },
//   byPlacement: { "<utm_placement>": count, ... }
// }

const cache = { data: null, at: 0 };
const CACHE_MS = 60 * 1000;

module.exports = async (req, res) => {
  if (!checkAuth(req, res)) return;

  if (cache.data && Date.now() - cache.at < CACHE_MS) {
    return res.status(200).json(cache.data);
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

    const today = startOfDayUtc(0);
    const sevenDaysAgo = startOfDayUtc(7);

    const freeToday = free.filter(s => subscribedAt(s) >= today).length;
    const freeLast7 = free.filter(s => subscribedAt(s) >= sevenDaysAgo).length;

    const byAd = {};
    const byPlacement = {};
    for (const s of free) {
      const ad = (s.fields && s.fields.utm_content) || 'unknown';
      const placement = (s.fields && s.fields.utm_placement) || 'unknown';
      byAd[ad] = (byAd[ad] || 0) + 1;
      byPlacement[placement] = (byPlacement[placement] || 0) + 1;
    }

    const data = {
      subscribers: { free: free.length, paid: paid.length, freeToday, freeLast7 },
      byAd,
      byPlacement,
    };
    cache.data = data;
    cache.at = Date.now();
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: `MailerLite API error: ${err.message}` });
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

async function fetchAllSubscribers(groupId, token) {
  const base = 'https://connect.mailerlite.com/api/subscribers';
  const all = [];
  const limit = 500;
  const hardCap = 10000; // safety
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

function startOfDayUtc(offsetDays) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - offsetDays);
  return d.getTime();
}
