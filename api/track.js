// POST /api/track
// Public event ingestion. No auth. IP rate-limited (60/min). Fails open
// on Redis errors — we never want tracking to break real users.
//
// Body: {
//   event: "pageview"|"cta_click"|"scroll_depth"|"form_focus"|
//          "form_submit_success"|"form_submit_error"|"exit_intent",
//   path, referrer, utm_source, utm_medium, utm_campaign, utm_content,
//   utm_placement, metadata: { ... }
// }

const crypto = require('crypto');
const { getRedis } = require('../lib/redis');
const { utcToDashboardDate, todayInDashboardTZ } = require('./_utils/dates');

const VALID_EVENTS = new Set([
  'pageview',
  'cta_click',
  'scroll_depth',
  'form_focus',
  'form_submit_success',
  'form_submit_error',
  'exit_intent',
]);

const EVENT_TTL = 60 * 60 * 24 * 90;   // 90 days
const COUNTER_TTL = 60 * 60 * 24 * 365; // 365 days

module.exports = async (req, res) => {
  // CORS / preflight — track endpoint is same-origin in production, but
  // this keeps local dev + Sleep Tight.html preview working.
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {});
  const event = String(body.event || '');
  if (!VALID_EVENTS.has(event)) {
    return res.status(400).json({ error: 'Invalid event' });
  }

  const ip = clientIp(req);
  const redis = getRedis();

  // Rate limit — fail open on errors
  try {
    const rlKey = `rl:${ip}:${Math.floor(Date.now() / 60000)}`;
    const count = await redis.incr(rlKey);
    if (count === 1) redis.expire(rlKey, 60).catch(() => {});
    if (count > 60) return res.status(429).json({ error: 'Rate limit' });
  } catch (_) {
    // Redis slow/down — let it through.
  }

  const nowISO = new Date().toISOString();
  const date = utcToDashboardDate(nowISO); // YYYY-MM-DD in dashboard TZ
  const ua = String(req.headers['user-agent'] || '');
  const country = String(req.headers['x-vercel-ip-country'] || '');
  const ipHash = hashIp(ip, date);
  const parsedUA = parseUA(ua);

  const utmContent = cleanStr(body.utm_content);
  const utmPlacement = cleanStr(body.utm_placement);
  const metadata = typeof body.metadata === 'object' && body.metadata ? body.metadata : {};
  // Constrain to 40 chars — client generates 16-char hex or "anon_<random>" / "sess_<random>"
  const visitorId = cleanId(body.visitor_id, 40);
  const sessionId = cleanId(body.session_id, 40);

  const eventRecord = {
    event,
    timestamp: nowISO,
    date,
    visitor_id: visitorId,
    session_id: sessionId,
    path: cleanStr(body.path) || '/',
    referrer: cleanStr(body.referrer),
    utm_source: cleanStr(body.utm_source),
    utm_medium: cleanStr(body.utm_medium),
    utm_campaign: cleanStr(body.utm_campaign),
    utm_content: utmContent,
    utm_placement: utmPlacement,
    ip_hash: ipHash,
    country,
    browser: parsedUA.browser,
    os: parsedUA.os,
    device_type: parsedUA.device_type,
    metadata,
  };

  try {
    const pipeline = redis.pipeline();
    const ts = Date.now();
    const eventsKey = `events:${date}`;
    pipeline.zadd(eventsKey, ts, JSON.stringify(eventRecord));
    pipeline.expire(eventsKey, EVENT_TTL);

    const countKey = `count:${date}:${event}`;
    pipeline.incr(countKey);
    pipeline.expire(countKey, COUNTER_TTL);

    if (utmContent) {
      const k = `count:${date}:${event}:utm_content:${utmContent}`;
      pipeline.incr(k);
      pipeline.expire(k, COUNTER_TTL);
    }
    if (utmPlacement) {
      const k = `count:${date}:${event}:utm_placement:${utmPlacement}`;
      pipeline.incr(k);
      pipeline.expire(k, COUNTER_TTL);
    }

    if (event === 'pageview') {
      // Prefer visitor_id (survives network changes) — fall back to ip_hash
      // so pageviews without a visitor_id (rare: JS errors pre-snippet) still
      // count toward uniques.
      const uniquesKey = `uniques:${date}`;
      pipeline.pfadd(uniquesKey, visitorId || ipHash);
      pipeline.expire(uniquesKey, COUNTER_TTL);
    }

    // Per-visitor event counters (90-day TTL) — powers visitor journey lookups
    // and engagement aggregates (returning visitors, bounces, events/visitor).
    if (visitorId) {
      const visitorKey = `visitor:${visitorId}:events`;
      pipeline.hincrby(visitorKey, event, 1);
      pipeline.expire(visitorKey, EVENT_TTL);
      // Track which dates this visitor appeared on — used to count returning
      // visitors (appeared on 2+ different days).
      const visitorDatesKey = `visitor:${visitorId}:dates`;
      pipeline.sadd(visitorDatesKey, date);
      pipeline.expire(visitorDatesKey, EVENT_TTL);
    }

    await pipeline.exec();
    return res.status(204).end();
  } catch (err) {
    // Swallow — tracking is best-effort.
    return res.status(204).end();
  }
};

function safeParse(s) {
  try { return JSON.parse(s); } catch (_) { return {}; }
}

function cleanStr(v) {
  if (v == null) return '';
  const s = String(v).trim();
  return s.length > 200 ? s.slice(0, 200) : s;
}

// Strict sanitizer for visitor/session ids. Alphanumerics + `_` + `-` only so
// they're always safe to embed in Redis key names. Anything else → empty.
function cleanId(v, max) {
  if (v == null) return '';
  const s = String(v).trim().slice(0, max || 40);
  return /^[A-Za-z0-9_-]+$/.test(s) ? s : '';
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || '0.0.0.0';
}

// Hash IP with a daily-rotating salt so the same visitor maps to the same
// ip_hash within a day (enabling unique counts), but can't be joined across
// days. Salt is the dashboard-TZ date — simple and stable.
function hashIp(ip, date) {
  const salt = `${date}:${process.env.DASHBOARD_PASSWORD || 'st'}`;
  return crypto.createHash('sha256').update(`${ip}${salt}`).digest('hex').slice(0, 16);
}

function parseUA(ua) {
  const s = ua.toLowerCase();
  let browser = 'other';
  if (/edg\//.test(s)) browser = 'edge';
  else if (/chrome|crios/.test(s)) browser = 'chrome';
  else if (/firefox|fxios/.test(s)) browser = 'firefox';
  else if (/safari/.test(s)) browser = 'safari';

  let os = 'other';
  if (/iphone|ipad|ipod/.test(s)) os = 'ios';
  else if (/android/.test(s)) os = 'android';
  else if (/mac os x/.test(s)) os = 'mac';
  else if (/windows/.test(s)) os = 'windows';
  else if (/linux/.test(s)) os = 'linux';

  let device_type = 'desktop';
  if (/iphone|ipod|android.*mobile|windows phone/.test(s)) device_type = 'mobile';
  else if (/ipad|tablet|android(?!.*mobile)/.test(s)) device_type = 'tablet';

  return { browser, os, device_type };
}
