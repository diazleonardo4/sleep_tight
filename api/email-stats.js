// GET /api/email-stats  (header: x-auth-token)
//
// Returns engagement stats for the two MailerLite automations Sleep
// Tight runs:
//   - welcome  : 3-day free-funnel sequence triggered on free signup
//   - purchase : 7-day post-purchase sequence triggered after a paid sale
//
// MailerLite distinguishes campaigns (one-shot broadcasts) from
// automations (triggered email sequences). Sleep Tight uses
// automations, so we hit the Connect /api/automations/{id} endpoint.
//
// Env vars (all optional — if a *_AUTOMATION_ID is unset, that key is
// null in the response and the dashboard renders a "Not configured"
// state for that card without erroring):
//
//   MAILERLITE_API_TOKEN                   Connect-API token (NOT classic v2)
//
//   MAILERLITE_WELCOME_AUTOMATION_ID       3-day welcome sequence
//   MAILERLITE_WELCOME_EMAIL_1_STEP_ID     optional, welcome email step
//   MAILERLITE_WELCOME_EMAIL_3_STEP_ID     optional, bundle pitch step
//
//   MAILERLITE_PURCHASE_AUTOMATION_ID      7-day post-purchase sequence
//   MAILERLITE_PURCHASE_EMAIL_1_STEP_ID    optional
//   MAILERLITE_PURCHASE_EMAIL_3_STEP_ID    optional
//
// Each automation is fetched in parallel and handled independently —
// if the welcome call 200s and the purchase call 404s, the response
// returns full welcome data alongside an error stub for purchase. The
// two cards on the dashboard render independently from this output.
//
// Response shape:
// {
//   fetched_at: <epoch ms>,
//   welcome:  <automationResult> | null,
//   purchase: <automationResult> | null,
// }
// where <automationResult> is one of:
//   { error: "...", automation_id }                       // fetch failed
//   { automation_id, automation_name, status,
//     subscribers_in_flow, total_sent, total_opens, total_clicks,
//     overall_open_rate, overall_click_rate,              // fractions 0..1
//     email_1: {step_id, step_name, sent, opens, clicks,
//               open_rate, click_rate} | null,
//     email_3: {...} | null,
//     available_steps: [{id, name, type}],                // every step in flow
//     missing_steps: ["welcome_email_1", ...]             // when step IDs misconfigured
//   }
//
// Cache: 5 min memo per request signature so dashboard refreshes
// don't burn through MailerLite quota. Cache key includes both
// automation IDs + step IDs so an env-var change invalidates
// immediately on next deploy.

const cache = new Map(); // key -> { data, at }
const CACHE_MS = 5 * 60 * 1000;

const AUTOMATION_KEYS = [
  {
    slot: 'welcome',
    label: '3-day welcome sequence',
    automationVar: 'MAILERLITE_WELCOME_AUTOMATION_ID',
    step1Var: 'MAILERLITE_WELCOME_EMAIL_1_STEP_ID',
    step3Var: 'MAILERLITE_WELCOME_EMAIL_3_STEP_ID',
  },
  {
    slot: 'purchase',
    label: '7-day post-purchase sequence',
    automationVar: 'MAILERLITE_PURCHASE_AUTOMATION_ID',
    step1Var: 'MAILERLITE_PURCHASE_EMAIL_1_STEP_ID',
    step3Var: 'MAILERLITE_PURCHASE_EMAIL_3_STEP_ID',
  },
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
    automationId: process.env[k.automationVar] || '',
    step1Id: process.env[k.step1Var] || '',
    step3Id: process.env[k.step3Var] || '',
  }));

  // Cache key includes both automation triplets so any env change is
  // visible on the next request — Vercel deploys reset the function
  // process anyway, but this keeps local dev sane too.
  const cacheKey = config
    .map(c => `${c.slot}=${c.automationId}:${c.step1Id}:${c.step3Id}`)
    .join('|');
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return res.status(200).json({
      ...hit.data,
      cached: true,
      cached_at: hit.at,
    });
  }

  // Fire both automation fetches in parallel; allSettled so a single
  // failure doesn't hide the other side's data. Each promise resolves
  // to either a successful automationResult or an error stub — we
  // never reject from inside fetchOne(), so allSettled is defensive.
  const results = await Promise.all(config.map(c => fetchOne(c, token)));
  const data = {
    fetched_at: Date.now(),
    welcome: results[0],
    purchase: results[1],
  };
  cache.set(cacheKey, { data, at: Date.now() });
  return res.status(200).json(data);
};

// fetchOne — never throws. Returns one of:
//   null                                  (automation not configured)
//   { error, automation_id }              (API call failed)
//   { ...full automationResult shape }    (success)
async function fetchOne(c, token) {
  if (!c.automationId) return null;

  let body;
  try {
    body = await callMailerLite(c.automationId, token);
  } catch (err) {
    return {
      automation_id: c.automationId,
      slot: c.slot,
      error: err.message,
    };
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
      throw new Error(
        `MailerLite token lacks the automations:read scope (HTTP 403).`
      );
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

// Build the per-automation result object the dashboard renders. Pulls
// the configured email-1 / email-3 steps out of the steps[] array,
// aggregates totals across every email step, and surfaces the full
// step list so a misconfigured STEP_ID is debuggable from the response
// alone (no need to curl the API separately).
function shapeAutomation(automation, config) {
  const a = automation || {};
  const steps = Array.isArray(a.steps) ? a.steps : [];
  const stepsById = new Map(steps.map(s => [String(s.id || ''), s]));

  // Available steps list — only emit "real" steps (drop pure delays
  // unless the step has email content, which we sniff via the type
  // and the presence of stats fields).
  const availableSteps = steps.map(s => ({
    id: s.id != null ? String(s.id) : '',
    name: s.name || s.subject || '',
    type: s.type || '',
  }));

  const buildEmail = (slotName, stepId) => {
    if (!stepId) return null;
    const step = stepsById.get(String(stepId));
    if (!step) {
      return {
        step_id: stepId,
        step_name: '',
        missing: true,
      };
    }
    return formatStep(step);
  };

  const email1 = buildEmail('email_1', config.step1Id);
  const email3 = buildEmail('email_3', config.step3Id);

  const missingSteps = [];
  if (config.step1Id && !stepsById.has(String(config.step1Id))) {
    missingSteps.push(`${config.slot}_email_1=${config.step1Id}`);
  }
  if (config.step3Id && !stepsById.has(String(config.step3Id))) {
    missingSteps.push(`${config.slot}_email_3=${config.step3Id}`);
  }

  // Aggregate totals across every email step (not just the two
  // configured ones) — overall_open_rate is the metric we want
  // surfaced on the card header even when the operator hasn't
  // bothered with step-level config yet.
  let totalSent = 0, totalOpens = 0, totalClicks = 0, totalOpensUnique = 0, totalClicksUnique = 0;
  for (const step of steps) {
    const s = formatStep(step);
    if (s.sent === 0 && s.opens === 0 && s.clicks === 0) continue; // skip non-email steps
    totalSent += s.sent;
    totalOpens += s.opens;
    totalClicks += s.clicks;
    totalOpensUnique += s.opens_unique;
    totalClicksUnique += s.clicks_unique;
  }

  return {
    automation_id: a.id || config.automationId,
    automation_name: a.name || a.title || '',
    status: a.status || '',
    subscribers_in_flow: extractSubscribersInFlow(a),
    total_sent: totalSent,
    total_opens: totalOpens,
    total_opens_unique: totalOpensUnique,
    total_clicks: totalClicks,
    total_clicks_unique: totalClicksUnique,
    overall_open_rate: totalSent > 0 ? round4(totalOpensUnique / totalSent) : 0,
    overall_click_rate: totalSent > 0 ? round4(totalClicksUnique / totalSent) : 0,
    email_1: email1,
    email_3: email3,
    available_steps: availableSteps,
    missing_steps: missingSteps.length ? missingSteps : undefined,
  };
}

// MailerLite's automation response carries the active-subscriber
// count in different fields depending on account vintage; probe
// every shape we've seen before falling back to 0. The dashboard
// uses this to render "Waiting for first purchase" when an
// automation is armed but empty.
function extractSubscribersInFlow(a) {
  const stats = a.stats || a.statistics || {};
  return num(pick(
    a.subscribers_count,
    a.total_audience,
    a.audience_count,
    a.recipients_count,
    stats.subscribers_count,
    stats.total_audience,
    stats.unique_recipients,
    stats.recipients_count
  ));
}

function formatStep(step) {
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
    step_id: s.id != null ? String(s.id) : '',
    step_name: s.name || s.subject || '',
    subject: s.subject || s.name || '',
    type: s.type || '',
    sent,
    opens,
    opens_unique: opensUnique,
    clicks,
    clicks_unique: clicksUnique,
    open_rate: sent > 0 ? round4(opensUnique / sent) : 0,
    click_rate: sent > 0 ? round4(clicksUnique / sent) : 0,
  };
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
