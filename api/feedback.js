// /api/feedback — dual-purpose endpoint.
//
// Two GET request shapes, routed by what's present:
//
//   1. WRITE / REDIRECT (public, no auth):
//        GET /api/feedback?q=<question>&a=<answer>&e=<email>
//      Logs the response, 302s to /thank-you. This is the URL
//      embedded in MailerLite survey links.
//
//   2. STATS (auth, header x-auth-token):
//        GET /api/feedback
//      Returns the cumulative all-time aggregate consumed by the
//      dashboard's "Reader feedback" section.
//
// Why one endpoint instead of two: Vercel's Hobby plan caps a
// deployment at 12 serverless functions. Splitting writer + reader
// into separate files would push us over. The shapes are disjoint
// (writer needs query params + no auth; reader needs auth + no
// query params), so the routing is unambiguous.
//
// Routing rule:
//   - q AND a present  → write path (auth IGNORED — public link)
//   - q OR a present alone → 400 (subscriber link malformed)
//   - neither present → stats path (auth REQUIRED)
//
// =================== WRITE PATH NOTES ===================
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
//   clicks all count. Documented behavior — IP/visitor_id-based
//   dedup would punish shared-network clicks far more than help.
//
//   The original spec asked for a SET (feedback_seen:<date>:<q>)
//   storing email_hash membership. A SET can confirm "we saw this
//   subscriber" but can't tell us their PRIOR answer to decrement.
//   We use a HASH (email_hash -> answer) so one read answers both
//   in a single round trip.
//
// Always responds 302 to /thank-you when q/a are present, even on
// Redis errors — we never want a transient infra hiccup to leave a
// subscriber staring at a JSON error page.
//
// =================== STATS PATH NOTES ===================
//
// Cumulative all-time aggregate. Feedback volume is low and the
// cohort is tiny, so date-filtering would shred sample sizes. The
// write path maintains feedback:total:<q>:<a> counters per
// response, which we just fan out and read here.
//
// Response shape:
// {
//   fetched_at: <epoch ms>,
//   questions: [
//     {
//       q: "breath",
//       total: 23,
//       answers: [
//         { a: "yes",      count: 17, pct: 0.74 },
//         { a: "somewhat", count:  4, pct: 0.17 },
//         { a: "no",       count:  2, pct: 0.09 },
//       ],
//     },
//     ...
//   ],
// }
//
// Questions/answers are auto-discovered from the SETs maintained
// at write time. 60s memo cache so dashboard refreshes don't fan
// out a fresh pipeline of MGETs per click.

const crypto = require('crypto');
const { getRedis } = require('../lib/redis');
const { utcToDashboardDate, todayInDashboardTZ } = require('./_utils/dates');

const COUNTER_TTL = 60 * 60 * 24 * 365; // match /api/track
const EVENT_TTL   = 60 * 60 * 24 * 90;  // match /api/track
const THANK_YOU_PATH = '/thank-you';

const statsCache = new Map(); // 'all' -> { data, at }
const STATS_CACHE_MS = 60 * 1000;

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const url = new URL(req.url, 'http://x');
  const qRaw = url.searchParams.get('q');
  const aRaw = url.searchParams.get('a');

  // No q AND no a → stats path. The (auth-gated) reader.
  if (qRaw == null && aRaw == null) {
    return handleStats(req, res);
  }

  // Either both present or one missing → write path.
  return handleWrite(req, res, url, qRaw, aRaw);
};

// ---------- WRITE PATH ----------

async function handleWrite(req, res, url, qRaw, aRaw) {
  const q = sanitizeKeyish(qRaw);
  const a = sanitizeKeyish(aRaw);
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
  // is degraded.
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

    // Bust the stats cache so the dashboard sees this new vote on
    // the next refresh instead of waiting up to 60s for the memo
    // entry to expire. Free since we own both sides of the cache.
    statsCache.delete('all');
  } catch (_) {
    // Swallow — we still want to redirect the subscriber.
  }

  // Pass q + a through the redirect so /thank-you can render a
  // variant tailored to the answer (e.g. racing_thoughts gets the
  // bundle pitch; sleeping_better gets a warm congrats). Both
  // values were already sanitized through sanitizeKeyish (alnum +
  // _ - only) so they're safe to drop into a URL without further
  // encoding — but encodeURIComponent is cheap insurance against a
  // future relaxation of the allowlist.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Location',
    `${THANK_YOU_PATH}?q=${encodeURIComponent(q)}&a=${encodeURIComponent(a)}`
  );
  return res.status(302).end();
}

// ---------- STATS PATH ----------

async function handleStats(req, res) {
  if (!checkAuth(req, res)) return;

  // FEEDBACK_START_DATE filter — when set to a YYYY-MM-DD string,
  // the dashboard ignores feedback events from earlier dates so
  // pre-launch test responses (Leo testing the endpoint before the
  // automation went live) don't muddy live-segment numbers. The
  // raw events / counters stay in Redis untouched; this is purely
  // a read-time view filter.
  //
  // We key the in-memory cache by the resolved start date so a
  // change to the env var (or the write path also bumps the cache
  // bust) propagates within the next refresh instead of waiting
  // for the 60s memo to expire under a stale start-date snapshot.
  const startDate = resolveFeedbackStartDate();
  const cacheKey = `start=${startDate || ''}`;

  const hit = statsCache.get(cacheKey);
  if (hit && Date.now() - hit.at < STATS_CACHE_MS) {
    return res.status(200).json({ ...hit.data, cached: true, cached_at: hit.at });
  }

  try {
    const data = await buildReport(startDate);
    statsCache.set(cacheKey, { data, at: Date.now() });
    return res.status(200).json(data);
  } catch (err) {
    return res.status(502).json({ error: `Feedback stats error: ${err.message}` });
  }
}

// Validate FEEDBACK_START_DATE. Accept YYYY-MM-DD only (which is
// what utcToDashboardDate / e.date in the event records emit).
// Anything else returns null, which means "no filter, show all".
// Returning null on invalid input matches the codebase's
// fail-soft pattern -- we never want a typo'd env var to silently
// hide all feedback by, say, comparing strings against "true".
function resolveFeedbackStartDate() {
  const raw = (process.env.FEEDBACK_START_DATE || '').trim();
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return raw;
}

async function buildReport(startDate /* YYYY-MM-DD or null */) {
  const redis = getRedis();

  const questions = await redis.smembers('feedback:questions');
  if (!questions || questions.length === 0) {
    return { fetched_at: Date.now(), questions: [], start_date: startDate || null };
  }

  // Two-pass fetch:
  //   1. Per-question SMEMBERS to enumerate answers. Single
  //      pipeline so we pay one round trip regardless of question
  //      count.
  //   2. MGET of every (q,a) total counter, again single round trip.
  const answersPipeline = redis.pipeline();
  for (const q of questions) {
    answersPipeline.smembers(`feedback:answers:${q}`);
  }
  const answersResults = await answersPipeline.exec();

  const pairs = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const [err, answers] = answersResults[i] || [null, []];
    if (err || !Array.isArray(answers)) continue;
    for (const a of answers) {
      pairs.push({ q, a });
    }
  }

  // Counter source split:
  //   - No start date  -> read pre-aggregated all-time counters
  //                       (feedback:total:<q>:<a>). One MGET, fastest.
  //   - Start date set -> sum the per-date counters
  //                       (count:<date>:feedback:<q>:<a>) for every
  //                       date >= startDate. We CANNOT just subtract
  //                       a "totals from date X" snapshot from the
  //                       running total -- the all-time counter
  //                       already includes the test events we want
  //                       to hide, and there's no "totals as of
  //                       date X" stored anywhere.
  //
  // The per-date counters are deduplicated (the write path
  // decrements them on answer flips), so summing them is the
  // correct view -- not the same as scanning raw events, which
  // would double-count the audit-trail copies.
  let totals = [];
  if (pairs.length > 0) {
    if (startDate) {
      totals = await sumPerDateCounters(redis, pairs, startDate);
    } else {
      const keys = pairs.map(p => `feedback:total:${p.q}:${p.a}`);
      totals = await redis.mget(...keys);
    }
  }

  const byQ = new Map();
  for (let i = 0; i < pairs.length; i++) {
    const { q, a } = pairs[i];
    const count = parseInt(totals[i], 10) || 0;
    // Drop zero-count answers — they exist in the answers SET because
    // we recorded one click then rolled it back via dedup. The set
    // membership stays for simplicity but rendering them as 0% rows
    // would just confuse the dashboard.
    if (count <= 0) continue;
    if (!byQ.has(q)) byQ.set(q, []);
    byQ.get(q).push({ a, count });
  }

  const out = [];
  for (const q of questions) {
    const answers = byQ.get(q) || [];
    if (answers.length === 0) continue; // question with no live counts
    const total = answers.reduce((s, x) => s + x.count, 0);
    answers.sort((x, y) => y.count - x.count);
    out.push({
      q,
      total,
      answers: answers.map(x => ({
        a: x.a,
        count: x.count,
        pct: total > 0 ? +(x.count / total).toFixed(4) : 0,
      })),
    });
  }

  // Sort questions by response volume desc — most-engaged surveys
  // surface first on the dashboard.
  out.sort((x, y) => y.total - x.total);

  return {
    fetched_at: Date.now(),
    start_date: startDate || null, // surfaced so the dashboard can label the section if/when filtered
    questions: out,
  };
}

// Sum count:<date>:feedback:<q>:<a> across every date in
// [startDate, today_in_dashboard_TZ]. Bundled into a single big
// MGET so we pay one round trip regardless of how many days are
// in the window. With ~365-day counter TTL and pairs.length * days
// typically ≤ a few hundred, this is well under any practical
// MGET size limit.
async function sumPerDateCounters(redis, pairs, startDate) {
  const today = todayInDashboardTZ();
  const dates = enumerateInclusive(startDate, today);
  if (dates.length === 0 || pairs.length === 0) {
    return pairs.map(() => '0');
  }

  const keys = [];
  for (const p of pairs) {
    for (const d of dates) {
      keys.push(`count:${d}:feedback:${p.q}:${p.a}`);
    }
  }
  const vals = keys.length ? await redis.mget(...keys) : [];

  const totals = [];
  for (let i = 0; i < pairs.length; i++) {
    let sum = 0;
    for (let j = 0; j < dates.length; j++) {
      const v = vals[i * dates.length + j];
      const n = parseInt(v, 10);
      if (Number.isFinite(n)) sum += n;
    }
    // Per-date counter rollback (answer flips) can take an
    // individual day below 0; clamp the *aggregate* at 0 so the
    // dashboard never renders a "negative responses" cell. The
    // per-day negativity self-cancels in normal flows -- if
    // someone flipped from yes->no, yes:-1 and no:+1 sum to 0
    // for the (q, yes) pair on that day. Clamping is defense
    // against partial expirations / out-of-window flips.
    totals.push(String(Math.max(0, sum)));
  }
  return totals;
}

// Inclusive date enumeration for two YYYY-MM-DD strings. Returns
// [] if start > end. Mirrors analytics.js's enumerateDates but
// kept inline here to avoid widening the dates.js module surface
// for a single caller.
function enumerateInclusive(since, until) {
  const [sy, sm, sd] = since.split('-').map(Number);
  const [uy, um, ud] = until.split('-').map(Number);
  if (!sy || !uy) return [];
  const start = Date.UTC(sy, sm - 1, sd);
  const end = Date.UTC(uy, um - 1, ud);
  if (end < start) return [];
  const out = [];
  for (let t = start; t <= end; t += 86400000) {
    const d = new Date(t);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    out.push(`${y}-${m}-${day}`);
  }
  return out;
}

// ---------- shared helpers ----------

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

function checkAuth(req, res) {
  const expected = process.env.DASHBOARD_PASSWORD;
  const token = req.headers['x-auth-token'];
  if (!expected || !token || token !== expected) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
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
