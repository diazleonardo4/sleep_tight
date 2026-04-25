// GET /api/campaigns?range=today|7d|30d  (header: x-auth-token)
// Returns the distinct list of utm_campaign values seen across events
// in the requested range, with total event counts. Drives the dashboard's
// campaign picker — the picker shows event counts inline so phantom or
// typo'd campaigns surface immediately at a glance.
//
// Response shape:
// {
//   range:          "today" | "7d" | "30d",
//   dashboardRange: { since, until },
//   campaigns: [
//     { utm_campaign: "sleep_tight_traffic",     events: 220 },
//     { utm_campaign: "sleep_tight_lead_target", events: 4   },
//     { utm_campaign: null,                      events: 12  }   // direct/untagged
//   ]
// }
//
// utm_campaign is canonical (slugged + alias-resolved via
// api/_utils/attribution.js), so historical typos auto-merge into their
// canonical bucket. The null bucket is explicit, not omitted, so the
// dashboard can offer a "Direct/Untagged" option in the picker.

const { getRedis } = require('../lib/redis');
const { getDateRange, normalizeRange } = require('./_utils/dates');
const { normalizeCampaignName } = require('./_utils/attribution');

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
    // Same scan path as /api/analytics — cheap because the dashboard's
    // three fixed ranges keep the working set small (≤30 day-keys).
    const scanLists = await Promise.all(dates.map(d => redis.zrange(`events:${d}`, 0, -1)));
    const allRaw = [].concat(...scanLists);

    const counts = new Map(); // canonical utm | null -> count
    for (const raw of allRaw) {
      let e;
      try { e = JSON.parse(raw); } catch (_) { continue; }
      if (!e) continue;
      const canon = normalizeCampaignName(e.utm_campaign || '') || null;
      counts.set(canon, (counts.get(canon) || 0) + 1);
    }

    const campaigns = Array.from(counts.entries())
      .map(([utm_campaign, events]) => ({ utm_campaign, events }))
      .sort((a, b) => b.events - a.events);

    const data = { range, dashboardRange: { since, until }, campaigns };
    cache.set(range, { data, at: Date.now() });
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: `Campaigns error: ${err.message}` });
  }
};

function enumerateDates(since, until) {
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
