// GET /api/visitor?id=VISITOR_ID  (header: x-auth-token)
// Debug utility: returns every event for a given visitor grouped by session.
//
// Strategy: `visitor:<id>:dates` is a SMEMBERS set of date strings the visitor
// appeared on (maintained by /api/track). For each of those dates we ZRANGE
// the raw events zset and filter by visitor_id. This is O(events in those
// dates), not O(all events) — cheap even across a 90-day retention window.

const { getRedis } = require('../lib/redis');

module.exports = async (req, res) => {
  if (!checkAuth(req, res)) return;

  const rawId = readQuery(req, 'id') || '';
  const id = /^[A-Za-z0-9_-]{1,40}$/.test(rawId) ? rawId : '';
  if (!id) return res.status(400).json({ error: 'Missing or invalid id' });

  const redis = getRedis();

  try {
    const dates = await redis.smembers(`visitor:${id}:dates`);
    if (!dates || !dates.length) {
      return res.status(404).json({ error: 'Visitor not found' });
    }
    dates.sort(); // ascending

    const perDate = await Promise.all(
      dates.map(d => redis.zrange(`events:${d}`, 0, -1))
    );

    const events = [];
    for (const rawList of perDate) {
      for (const raw of rawList) {
        let e;
        try { e = JSON.parse(raw); } catch (_) { continue; }
        if (!e || e.visitor_id !== id) continue;
        events.push(e);
      }
    }

    if (!events.length) return res.status(404).json({ error: 'Visitor not found' });

    events.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

    const sessions = new Map();
    for (const e of events) {
      const sid = e.session_id || 'no_session';
      let s = sessions.get(sid);
      if (!s) { s = { session_id: sid, started_at: e.timestamp, events: [] }; sessions.set(sid, s); }
      s.events.push(e);
    }

    return res.status(200).json({
      visitor_id: id,
      first_seen: events[0].timestamp,
      last_seen: events[events.length - 1].timestamp,
      total_events: events.length,
      dates,
      sessions: Array.from(sessions.values()),
    });
  } catch (err) {
    return res.status(502).json({ error: `Visitor lookup error: ${err.message}` });
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
