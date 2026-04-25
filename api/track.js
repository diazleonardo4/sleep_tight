// POST /api/track
// Public event ingestion. No auth. IP rate-limited (60 req/min — each
// request can carry up to MAX_BATCH events). Fails open on Redis errors —
// we never want tracking to break real users.
//
// Accepts either shape:
//   Batched:  { events: [{event, visitor_id, ...metadata}, ...] }  (<=50)
//   Single:   { event, visitor_id, ...metadata }                   (legacy)
//
// Per-event fields: event, visitor_id, session_id, path, referrer,
// utm_source, utm_medium, utm_campaign, utm_content, utm_placement,
// metadata. Server enriches with timestamp, date, ip_hash, country, UA.

const crypto = require('crypto');
const { getRedis } = require('../lib/redis');
const { utcToDashboardDate } = require('./_utils/dates');
const { normalizeCampaignName } = require('./_utils/attribution');

const VALID_EVENTS = new Set([
  'pageview',
  'cta_click',
  'scroll_depth',
  'form_focus',
  'form_submit_success',
  'form_submit_error',
  'exit_intent',
]);

// Internal / test visitor_ids (Leo + Claude + any QA devices). Populated
// from the INTERNAL_VISITOR_IDS env var — comma-separated list. Events
// from these ids are dropped at ingest so dashboard metrics reflect
// real traffic only. Cached at module scope so warm invocations don't
// re-parse the env var per request.
const INTERNAL_VISITOR_IDS = new Set(
  (process.env.INTERNAL_VISITOR_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean)
);

const EVENT_TTL = 60 * 60 * 24 * 90;   // 90 days
const COUNTER_TTL = 60 * 60 * 24 * 365; // 365 days
const MAX_BATCH = 50;

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

  // Normalize to an array of per-event bodies. Legacy single-event shape
  // stays supported — if there's no `events` array, treat the body itself
  // as a single event.
  const rawEvents = Array.isArray(body.events) ? body.events : [body];
  if (rawEvents.length === 0) {
    return res.status(400).json({ error: 'No events' });
  }
  if (rawEvents.length > MAX_BATCH) {
    return res.status(400).json({ error: `Batch too large (max ${MAX_BATCH})` });
  }

  // Validate every event up front; reject the whole batch if any are bad.
  const validated = [];
  for (const e of rawEvents) {
    if (!e || typeof e !== 'object') return res.status(400).json({ error: 'Invalid event' });
    const name = String(e.event || '');
    if (!VALID_EVENTS.has(name)) return res.status(400).json({ error: 'Invalid event' });
    validated.push(e);
  }

  // Drop internal/test events before any Redis write. If the whole batch
  // is internal we short-circuit with 204 so the client still sees success
  // — no counters incremented, no rate-limit token burned either.
  const events = validated.filter(e => {
    const vid = cleanId(e.visitor_id, 40);
    return !(vid && INTERNAL_VISITOR_IDS.has(vid));
  });
  if (events.length === 0) {
    return res.status(204).end();
  }

  const ip = clientIp(req);
  const redis = getRedis();

  // Rate limit — 60 batches/min per IP. Each batch can carry up to
  // MAX_BATCH events, so effective throughput is well beyond real usage.
  try {
    const rlKey = `rl:${ip}:${Math.floor(Date.now() / 60000)}`;
    const count = await redis.incr(rlKey);
    if (count === 1) redis.expire(rlKey, 60).catch(() => {});
    if (count > 60) return res.status(429).json({ error: 'Rate limit' });
  } catch (_) {
    // Redis slow/down — let it through.
  }

  const nowISO = new Date().toISOString();
  const date = utcToDashboardDate(nowISO);
  const ua = String(req.headers['user-agent'] || '');
  const country = String(req.headers['x-vercel-ip-country'] || '');
  const ipHash = hashIp(ip, date);
  const parsedUA = parseUA(ua);

  try {
    const pipeline = redis.pipeline();
    const tsBase = Date.now();
    const eventsKey = `events:${date}`;
    const uniquesKey = `uniques:${date}`;
    let pipelineOps = 0;

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const name = String(e.event);
      const utmContent = cleanStr(e.utm_content);
      const utmPlacement = cleanStr(e.utm_placement);
      const utmCampaignRaw = cleanStr(e.utm_campaign);
      const utmCampaignNorm = normalizeCampaignName(utmCampaignRaw);
      const metadata = typeof e.metadata === 'object' && e.metadata ? e.metadata : {};
      const visitorId = cleanId(e.visitor_id, 40);
      const sessionId = cleanId(e.session_id, 40);

      const eventRecord = {
        event: name,
        timestamp: nowISO,
        date,
        visitor_id: visitorId,
        session_id: sessionId,
        path: cleanStr(e.path) || '/',
        referrer: cleanStr(e.referrer),
        utm_source: cleanStr(e.utm_source),
        utm_medium: cleanStr(e.utm_medium),
        // utm_campaign is stored canonical: lowercased + slugged + alias-
        // resolved, or null (NOT empty string) when the URL had no tag.
        // Distinguishing null from "" matters for the Direct/Untagged
        // dashboard bucket — the analytics scan groups null events under
        // the direct sentinel. Old events stored as raw strings still
        // re-normalize correctly at read time (idempotent slug).
        utm_campaign: utmCampaignNorm || null,
        utm_content: utmContent,
        utm_placement: utmPlacement,
        ip_hash: ipHash,
        country,
        browser: parsedUA.browser,
        os: parsedUA.os,
        device_type: parsedUA.device_type,
        metadata,
      };

      // Offset ts by index so identical (ts, same-body) pairs in one batch
      // still ZADD as distinct members — otherwise ZSET dedupes them.
      pipeline.zadd(eventsKey, tsBase + i, JSON.stringify(eventRecord));
      pipelineOps++;

      const countKey = `count:${date}:${name}`;
      pipeline.incr(countKey);
      pipeline.expire(countKey, COUNTER_TTL);
      pipelineOps += 2;

      if (utmContent) {
        const k = `count:${date}:${name}:utm_content:${utmContent}`;
        pipeline.incr(k);
        pipeline.expire(k, COUNTER_TTL);
      }
      if (utmPlacement) {
        const k = `count:${date}:${name}:utm_placement:${utmPlacement}`;
        pipeline.incr(k);
        pipeline.expire(k, COUNTER_TTL);
      }
      if (name === 'pageview') {
        // Prefer visitor_id (survives network changes) — fall back to ip_hash
        // so pageviews without a visitor_id (rare: JS errors pre-snippet) still
        // count toward uniques.
        pipeline.pfadd(uniquesKey, visitorId || ipHash);
      }

      if (visitorId) {
        const visitorKey = `visitor:${visitorId}:events`;
        pipeline.hincrby(visitorKey, name, 1);
        pipeline.expire(visitorKey, EVENT_TTL);
        const visitorDatesKey = `visitor:${visitorId}:dates`;
        pipeline.sadd(visitorDatesKey, date);
        pipeline.expire(visitorDatesKey, EVENT_TTL);
      }
    }

    // EXPIREs for the shared per-date keys, just once per batch.
    if (pipelineOps > 0) {
      pipeline.expire(eventsKey, EVENT_TTL);
      pipeline.expire(uniquesKey, COUNTER_TTL);
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
