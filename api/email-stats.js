// GET /api/email-stats  (header: x-auth-token)
//
// Returns engagement stats for the two MailerLite automations Sleep
// Tight runs:
//   - welcome  : 3-day free-funnel sequence triggered on free signup
//   - purchase : 7-day post-purchase sequence triggered after a paid sale
//
// Sleep Tight uses MailerLite automations (triggered email sequences),
// not campaigns (one-shot broadcasts). We hit Connect's
// /api/automations/{id} endpoint, then auto-discover every email step
// in the response — no per-step env-var configuration. Add or remove
// emails inside MailerLite and they appear/disappear from the
// dashboard on the next refresh, no redeploy needed.
//
// Env vars:
//   MAILERLITE_API_TOKEN                Connect-API token (NOT classic v2)
//   MAILERLITE_WELCOME_AUTOMATION_ID    3-day welcome sequence id
//   MAILERLITE_PURCHASE_AUTOMATION_ID   7-day post-purchase sequence id
//
// All env vars are optional. If a *_AUTOMATION_ID is unset, that key
// is null in the response and the dashboard renders "Not configured"
// for that card without erroring.
//
// Response shape:
// {
//   fetched_at: <epoch ms>,
//   welcome:  <automationResult> | null,
//   purchase: <automationResult> | null,
// }
// where <automationResult> is one of:
//   { error, automation_id }                                fetch failed
//   {
//     automation_id, automation_name, status,
//     total_received,                  // subscribers who entered the flow
//     in_flow,                         // currently mid-sequence
//     overall: { sent, opens, clicks, opens_unique, clicks_unique,
//                open_rate, click_rate },
//     emails: [
//       { position, step_id, step_name, sent, opens, clicks,
//         unique_opens, unique_clicks, open_rate, click_rate },
//       ...
//     ],
//   }
//
// `position` is the EMAIL position (1, 2, 3, ...) regardless of how
// many delay/condition steps sit between emails in the raw flow.
// MailerLite returns steps in flow order, which we preserve.
//
// 5-min memo cache so dashboard refreshes don't hammer MailerLite.

const cache = new Map();
const CACHE_MS = 5 * 60 * 1000;

const AUTOMATION_KEYS = [
  { slot: 'welcome',  envVar: 'MAILERLITE_WELCOME_AUTOMATION_ID' },
  { slot: 'purchase', envVar: 'MAILERLITE_PURCHASE_AUTOMATION_ID' },
];

module.exports = async (req, res) => {
  if (!checkAuth(req, res)) return;

  const token = process.env.MAILERLITE_API_TOKEN;
  if (!token) {
    return res.status(200).json({
      fetched_at: Date.now(),
      welcome: null,
      purchase: null,
      reason: 'MAILERLITE_API_TOKEN not set',
    });
  }

  const config = AUTOMATION_KEYS.map(k => ({
    ...k,
    automationId: process.env[k.envVar] || '',
  }));

  const cacheKey = config.map(c => `${c.slot}=${c.automationId}`).join('|');
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return res.status(200).json({ ...hit.data, cached: true, cached_at: hit.at });
  }

  // Parallel fetch — each fetchOne() is fail-isolated, so one
  // automation 404'ing can't take down the other side.
  const results = await Promise.all(config.map(c => fetchOne(c, token)));
  const data = {
    fetched_at: Date.now(),
    welcome: results[0],
    purchase: results[1],
  };
  cache.set(cacheKey, { data, at: Date.now() });
  return res.status(200).json(data);
};

async function fetchOne(c, token) {
  if (!c.automationId) return null;
  let body;
  try {
    body = await callMailerLite(c.automationId, token);
  } catch (err) {
    return { automation_id: c.automationId, slot: c.slot, error: err.message };
  }
  return shapeAutomation(body, c);
}

async function callMailerLite(automationId, token) {
  const url = `https://connect.mailerlite.com/api/automations/${encodeURIComponent(automationId)}`;
  let r;
  try {
    r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
  } catch (e) {
    throw new Error(`MailerLite API unreachable: ${e.message}`);
  }
  if (r.ok) {
    const json = await r.json();
    return json.data || json || {};
  }
  let bodyText = '';
  try { bodyText = (await r.text()).slice(0, 200); } catch (_) {}
  switch (r.status) {
    case 401:
      throw new Error(
        `Invalid or expired MailerLite API token (HTTP 401). ` +
        `Classic v2 tokens will 401 here — regenerate at ` +
        `dashboard.mailerlite.com → Integrations → API.`
      );
    case 403:
      throw new Error(`MailerLite token lacks the automations:read scope (HTTP 403).`);
    case 404:
      throw new Error(
        `Automation ${automationId} not found (HTTP 404). ` +
        `Check the matching MAILERLITE_*_AUTOMATION_ID env var — ` +
        `find IDs in MailerLite → Automations → click sequence → URL.`
      );
    case 429:
      throw new Error(`MailerLite rate limit hit (HTTP 429). Retry shortly.`);
    default:
      throw new Error(
        `MailerLite Connect API HTTP ${r.status} on automation ${automationId}: ${bodyText}`
      );
  }
}

function shapeAutomation(automation, config) {
  const a = automation || {};
  const rawSteps = Array.isArray(a.steps) ? a.steps : [];

  // Auto-discover email steps. Preserve MailerLite's flow order so
  // Email N matches the order subscribers actually receive them.
  const emailSteps = rawSteps.filter(isEmailStep);

  const emails = emailSteps.map((step, i) => formatEmail(step, i + 1));

  const overall = aggregateOverall(emails);

  return {
    automation_id: a.id || config.automationId,
    automation_name: a.name || a.title || '',
    status: a.status || '',
    total_received: extractCount(a, 'received'),
    in_flow: extractCount(a, 'in_flow'),
    overall,
    emails,
  };
}

// MailerLite step types include `email`, `delay`/`wait`, `condition`,
// `action`/`tag`, `goal`, etc. Prefer the explicit `type === 'email'`
// match. When type is missing/unknown, fall back to sniffing for
// email-shaped content (a subject, or any of the sent/opens/clicks
// counters present at any nesting depth) — the spec's documented
// fallback for accounts where the type field is unreliable.
function isEmailStep(step) {
  if (!step) return false;
  const type = String(step.type || '').toLowerCase();
  if (type === 'email') return true;
  if (type) return false; // explicit non-email type — skip

  if (step.subject) return true;
  return hasAnyStatField(step) || hasAnyStatField(step.stats) || hasAnyStatField(step.statistics);
}

const STAT_FIELDS = [
  'sent', 'sent_count', 'total_sent',
  'opens', 'opens_count', 'unique_opens', 'unique_opens_count',
  'clicks', 'clicks_count', 'unique_clicks', 'unique_clicks_count',
];
function hasAnyStatField(obj) {
  if (!obj || typeof obj !== 'object') return false;
  for (const f of STAT_FIELDS) if (obj[f] !== undefined && obj[f] !== null) return true;
  return false;
}

function formatEmail(step, position) {
  const s = step || {};
  const stats = s.stats || s.statistics || {};

  const sent = num(pick(stats.sent, stats.sent_count, s.sent, s.sent_count, s.total_sent));
  const opens = num(pick(stats.opens_count, stats.opens, s.opens_count, s.opens, s.total_opens));
  const opensUnique = num(pick(
    stats.unique_opens_count, stats.unique_opens, stats.opens_unique,
    s.unique_opens_count, s.unique_opens, s.opens_unique
  ));
  const clicks = num(pick(stats.clicks_count, stats.clicks, s.clicks_count, s.clicks, s.total_clicks));
  const clicksUnique = num(pick(
    stats.unique_clicks_count, stats.unique_clicks, stats.clicks_unique,
    s.unique_clicks_count, s.unique_clicks, s.clicks_unique
  ));

  return {
    position,
    step_id: s.id != null ? String(s.id) : '',
    step_name: s.name || s.subject || '',
    subject: s.subject || '',
    sent,
    opens,
    clicks,
    unique_opens: opensUnique,
    unique_clicks: clicksUnique,
    open_rate: sent > 0 ? round4(opensUnique / sent) : 0,
    click_rate: sent > 0 ? round4(clicksUnique / sent) : 0,
  };
}

function aggregateOverall(emails) {
  let sent = 0, opens = 0, clicks = 0, opensUnique = 0, clicksUnique = 0;
  for (const e of emails) {
    sent += e.sent;
    opens += e.opens;
    clicks += e.clicks;
    opensUnique += e.unique_opens;
    clicksUnique += e.unique_clicks;
  }
  return {
    sent,
    opens,
    clicks,
    opens_unique: opensUnique,
    clicks_unique: clicksUnique,
    open_rate: sent > 0 ? round4(opensUnique / sent) : 0,
    click_rate: sent > 0 ? round4(clicksUnique / sent) : 0,
  };
}

// MailerLite's automation payload exposes the "subscribers received"
// and "currently in flow" counts under various field names depending
// on account vintage. Probe several known shapes; fall back to 0 so
// missing data renders cleanly instead of NaN.
function extractCount(a, kind) {
  const stats = a.stats || a.statistics || {};
  if (kind === 'received') {
    return num(pick(
      a.subscribers_count,
      a.total_subscribers_count,
      a.recipients_count,
      a.total_audience,
      stats.subscribers_count,
      stats.total_subscribers_count,
      stats.recipients_count,
      stats.unique_recipients
    ));
  }
  // kind === 'in_flow' — currently mid-sequence
  return num(pick(
    a.active_subscribers_count,
    a.subscribers_in_flow,
    a.current_subscribers_count,
    a.in_flow,
    stats.active_subscribers_count,
    stats.subscribers_in_flow,
    stats.in_flow
  ));
}

function pick(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return 0;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round4(n) {
  return Number.isFinite(n) ? +n.toFixed(4) : 0;
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
