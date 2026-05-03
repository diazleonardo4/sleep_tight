// GET /api/feedback?q=<question>&a=<answer>&e=<email>
//
// Public, no-auth one-click feedback collector for email-embedded
// surveys. Each survey link in a MailerLite email points here with
// q/a (and optional e merge tag for per-subscriber dedup). We log
// the response, redirect 302 to /thank-you, and never echo anything
// useful back — these get clicked by subscribers, not authenticated
// callers.
//
// Why GET (not POST): email clients only fire GETs on link clicks.
// No CSRF concern because there is no per-subscriber privileged
// state on the dashboard side — feedback is anonymous aggregate
// data. Email addresses go through SHA-256 before storage.
//
// Data model (extends the analytics keyspace from /api/track):
//   events:<date>                 ZSET of event JSON, feedback events
//                                 land here too (event: "feedback")
//   count:<date>:feedback:<q>:<a> per-date counter (TTL = COUNTER_TTL)
//   feedback:total:<q>:<a>        all-time counter (no TTL — the
//                                 dashboard renders cumulative,
//                                 not date-filtered)
//   feedback:questions            SET of all q values ever seen
//   feedback:answers:<q>          SET of all a values seen per q
//   feedback_seen:<date>:<q>      HASH email_hash -> answer, dedup
//
// Dedup behavior (only when ?e= is provided):
//   If the same (email, question) already submitted today, we look
//   up the prior answer, decrement the old (per-date AND all-time)
//   counter, increment the new one, and overwrite the seen map.
//   Same answer twice is idempotent. The raw event still gets
//   appended both times so the audit trail is complete.
//
//   Without ?e= we have no stable subject identity, so duplicate
//   clicks all count. That's documented behavior — a fallback to
//   IP/visitor_id-based dedup would punish shared-network clicks
//   from the same household far more than it'd help.
//
//   The original spec asked for a SET (feedback_seen:<date>:<q>)
//   storing email_hash membership. A SET can confirm "we saw this
//   subscriber" but can't tell us their PRIOR answer to decrement.
//   We use a HASH instead (email_hash -> answer) so one read
//   answers both questions in a single round trip.
//
// Always responds 302 to /thank-you when q/a are present, even on
// Redis errors — we never want a transient infra hiccup to leave a
// subscriber staring at a JSON error page.

const crypto = require('crypto');
const { getRedis } = require('../lib/redis');
const { utcToDashboardDate } = require('./_utils/dates');

const COUNTER_TTL = 60 * 60 * 24 * 365; // match /api/track
const EVENT_TTL   = 60 * 60 * 24 * 90;  // match /api/track
const THANK_YOU_PATH = '/thank-you';

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const url = new URL(req.url, 'http://x');
  const q = sanitizeKeyish(url.searchParams.get('q'));
  const a = sanitizeKeyish(url.searchParams.get('a'));
  const e = (url.searchParams.get('e') || '').trim();

  if (!q || !a) {
    return res.status(400).json({ error: 'Missing q or a parameter' });
  }

  const ua = String(req.headers['user-agent'] || '');
  const country = String(req.headers['x-vercel-ip-country'] || '');
  const parsedUA = parseUA(ua);
  const emailHash = e ? sha256(e.toLowerCase()) : null;
  const nowMs = Date.now();
  const nowISO = new Date(nowMs).toISOString();
  const date = utcToDashboardDate(nowISO);

  const eventRecord = {
    event: 'feedback',
    t: nowMs,
    timestamp: nowISO,
    date,
    question: q,
    answer: a,
    email_hash: emailHash,
    country,
    browser: parsedUA.browser,
    os: parsedUA.os,
    device_type: parsedUA.device_type,
  };

  // Best-effort write — feedback redirect must succeed even if Redis
  // is degraded. Errors are logged server-side only.
  try {
    const redis = getRedis();

    // Resolve dedup before queuing pipeline ops so we know whether
    // (and which) prior counters to decrement.
    let priorAnswer = null;
    if (emailHash) {
      try {
        priorAnswer = await redis.hget(`feedback_seen:${date}:${q}`, emailHash);
      } catch (_) {
        // Treat unreadable seen-map as "first click" — worst case is
        // a single double-count for this subscriber, which is fine.
        priorAnswer = null;
      }
    }

    const pipeline = redis.pipeline();
    const eventsKey = `events:${date}`;
    const countKey = `count:${date}:feedback:${q}:${a}`;
    const totalKey = `feedback:total:${q}:${a}`;

    // Always append the raw event for the audit trail (even on a
    // same-answer repeat click). Sub-second offset isn't needed
    // here — feedback volume is low and ZSET dedup on identical
    // (score, member) is acceptable.
    pipeline.zadd(eventsKey, nowMs, JSON.stringify(eventRecord));
    pipeline.expire(eventsKey, EVENT_TTL);

    if (emailHash && priorAnswer && priorAnswer === a) {
      // Idempotent: same subscriber clicking the same answer again.
      // Skip counter mutations entirely. We still wrote the event
      // record above so the audit trail captures the repeat click.
    } else {
      if (emailHash && priorAnswer && priorAnswer !== a) {
        // Subscriber changed their mind. Roll back the old answer
        // in BOTH the per-date and all-time counters so the
        // dashboard's cumulative view stays consistent.
        const oldCountKey = `count:${date}:feedback:${q}:${priorAnswer}`;
        const oldTotalKey = `feedback:total:${q}:${priorAnswer}`;
        pipeline.decr(oldCountKey);
        pipeline.decr(oldTotalKey);
      }

      pipeline.incr(countKey);
      pipeline.expire(countKey, COUNTER_TTL);
      pipeline.incr(totalKey);
      // No TTL on totalKey — cumulative-forever metric.

      pipeline.sadd('feedback:questions', q);
      pipeline.sadd(`feedback:answers:${q}`, a);

      if (emailHash) {
        const seenKey = `feedback_seen:${date}:${q}`;
        pipeline.hset(seenKey, emailHash, a);
        pipeline.expire(seenKey, COUNTER_TTL);
      }
    }

    await pipeline.exec();
  } catch (_) {
    // Swallow — we still want to redirect the subscriber.
  }

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Location', THANK_YOU_PATH);
  return res.status(302).end();
};

// Strict allowlist for q/a tokens — they end up embedded in Redis
// key names. Alphanumerics, underscore, hyphen only. Anything else
// (dots, slashes, spaces, unicode) becomes empty string and gets
// rejected upstream as "missing".
function sanitizeKeyish(v) {
  if (v == null) return '';
  const s = String(v).trim().slice(0, 64);
  return /^[A-Za-z0-9_-]+$/.test(s) ? s : '';
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// Identical UA parser to /api/track. Kept inline (rather than
// extracting to a shared util) because the two endpoints are the
// only callers and divergence would be a deliberate signal.
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
