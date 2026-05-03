// GET /api/feedback-stats  (header: x-auth-token)
//
// Cumulative aggregate of email survey responses, used by the
// dashboard's "Reader feedback" section. Always all-time — feedback
// volume is low and the cohort is tiny, so date-filtering would
// shred sample sizes. The /api/feedback endpoint maintains
// `feedback:total:<q>:<a>` counters per response, which we just
// fan out and read here.
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
// at write time:
//   feedback:questions       — all distinct q values
//   feedback:answers:<q>     — all distinct a values per q
//
// 60s memo cache so dashboard refreshes don't fan out a fresh
// pipeline of MGETs per click.

const { getRedis } = require('../lib/redis');

const cache = new Map(); // 'all' -> { data, at }
const CACHE_MS = 60 * 1000;

module.exports = async (req, res) => {
  if (!checkAuth(req, res)) return;

  const hit = cache.get('all');
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return res.status(200).json({ ...hit.data, cached: true, cached_at: hit.at });
  }

  try {
    const data = await buildReport();
    cache.set('all', { data, at: Date.now() });
    return res.status(200).json(data);
  } catch (err) {
    return res.status(502).json({ error: `Feedback stats error: ${err.message}` });
  }
};

async function buildReport() {
  const redis = getRedis();

  const questions = await redis.smembers('feedback:questions');
  if (!questions || questions.length === 0) {
    return { fetched_at: Date.now(), questions: [] };
  }

  // Two-pass fetch:
  //   1. Per-question SMEMBERS to enumerate answers. Done in a single
  //      pipeline so we pay one round trip regardless of question
  //      count.
  //   2. MGET of every (q,a) total counter, again single round trip.
  const answersPipeline = redis.pipeline();
  for (const q of questions) {
    answersPipeline.smembers(`feedback:answers:${q}`);
  }
  const answersResults = await answersPipeline.exec();

  // Build the flat list of (q,a) pairs we need totals for.
  const pairs = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const [err, answers] = answersResults[i] || [null, []];
    if (err || !Array.isArray(answers)) continue;
    for (const a of answers) {
      pairs.push({ q, a });
    }
  }

  let totals = [];
  if (pairs.length > 0) {
    const keys = pairs.map(p => `feedback:total:${p.q}:${p.a}`);
    totals = await redis.mget(...keys);
  }

  // Group pairs back by question.
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

  return { fetched_at: Date.now(), questions: out };
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
