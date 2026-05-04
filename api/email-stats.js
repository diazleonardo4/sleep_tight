// GET /api/email-stats  (header: x-auth-token)
//
// Returns engagement stats for the MailerLite automations Sleep
// Tight runs:
//   - welcome_old : legacy 3-day free-funnel (winding down — kept
//                   running for subscribers mid-flow during the
//                   transition; replaced by welcome_new for new
//                   signups)
//   - welcome_new : new 7-day free-funnel (active default for new
//                   signups; better timing, bridge email, feedback
//                   links, rewritten pitch)
//   - purchase    : 7-day post-purchase sequence triggered after a
//                   paid sale
//
// Sleep Tight uses MailerLite automations (triggered email sequences),
// not campaigns (one-shot broadcasts). We hit Connect's
// /api/automations/{id} endpoint, then auto-discover every email step
// in the response — no per-step env-var configuration. Add or remove
// emails inside MailerLite and they appear/disappear from the
// dashboard on the next refresh, no redeploy needed.
//
// Env vars:
//   MAILERLITE_API_TOKEN                  Connect-API token (NOT classic v2)
//   MAILERLITE_WELCOME_AUTOMATION_ID      legacy 3-day welcome sequence id
//   MAILERLITE_NEW_WELCOME_AUTOMATION_ID  new 7-day welcome sequence id
//   MAILERLITE_PURCHASE_AUTOMATION_ID     7-day post-purchase sequence id
//
// All env vars are optional. If a *_AUTOMATION_ID is unset:
//   - welcome_old / purchase  → null in the response; the dashboard
//                               renders "Not configured" for that card
//   - welcome_new             → null in the response; the dashboard
//                               omits the card entirely (during the
//                               transition window the new automation
//                               might not exist yet, and we don't
//                               want to flash "Not configured" until
//                               Leo creates it)
//
// Response shape:
// {
//   fetched_at:  <epoch ms>,
//   welcome_old: <automationResult> | null,
//   welcome_new: <automationResult> | null,
//   purchase:    <automationResult> | null,
// }
// where <automationResult> is one of:
//   { error, automation_id }                                fetch failed
//   {
//     automation_id, automation_name, status,
//     completed,                       // subscribers who finished the flow
//     in_flow,                         // currently mid-sequence
//     overall: { sent, opens, clicks, open_rate, click_rate,
//                unsubscribes, bounce_rate },
//     emails: [
//       { position, step_id, step_name, subject,
//         sent, opens, clicks, unsubscribes, open_rate, click_rate },
//       ...
//     ],
//   }
//
// `position` is the EMAIL position (1, 2, 3, ...) regardless of how
// many delay/condition steps sit between emails in the raw flow.
// MailerLite returns steps in *creation* order, not flow order, so we
// reconstruct flow order by walking the parent_id linked list before
// numbering. `overall` and `completed`/`in_flow` come from the
// top-level data.stats block — MailerLite pre-aggregates them for us.
//
// 5-min memo cache so dashboard refreshes don't hammer MailerLite.

const cache = new Map();
const CACHE_MS = 5 * 60 * 1000;

const AUTOMATION_KEYS = [
  // Order is incidental — we expand `results` into a slot-keyed
  // object below, so renaming or reordering here only affects the
  // parallel-fetch issue order, not the response shape.
  { slot: 'welcome_old', envVar: 'MAILERLITE_WELCOME_AUTOMATION_ID' },
  { slot: 'welcome_new', envVar: 'MAILERLITE_NEW_WELCOME_AUTOMATION_ID' },
  { slot: 'purchase',    envVar: 'MAILERLITE_PURCHASE_AUTOMATION_ID' },
];

module.exports = async (req, res) => {
  if (!checkAuth(req, res)) return;

  const token = process.env.MAILERLITE_API_TOKEN;
  if (!token) {
    return res.status(200).json({
      fetched_at: Date.now(),
      welcome_old: null,
      welcome_new: null,
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
  // automation 404'ing can't take down the other side. Fan results
  // back out into a slot-keyed envelope so consumers don't depend
  // on AUTOMATION_KEYS ordering.
  const results = await Promise.all(config.map(c => fetchOne(c, token)));
  const data = { fetched_at: Date.now() };
  for (let i = 0; i < config.length; i++) {
    data[config[i].slot] = results[i];
  }
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

  // MailerLite returns steps in *creation* order, not flow order.
  // Walk the parent_id linked list from root so Email 1 = the actual
  // first email subscribers receive, regardless of when it was
  // authored. Then filter to email-type steps that have an `email`
  // payload — delays/conditions don't.
  const ordered = sortStepsByFlow(rawSteps);
  const emailSteps = ordered.filter(
    s => String(s.type || '').toLowerCase() === 'email' && s.email
  );
  const emails = emailSteps.map((step, i) => formatEmail(step, i + 1));

  // Top-level automation aggregate. MailerLite already does the
  // sums for us — no need to re-aggregate from per-email rows.
  const stats = a.stats || {};
  const overall = {
    sent:         num(stats.sent),
    opens:        num(stats.opens_count),
    clicks:       num(stats.clicks_count),
    open_rate:    numFloat(stats.open_rate),
    click_rate:   numFloat(stats.click_rate),
    unsubscribes: num(stats.unsubscribes_count),
    bounce_rate:  numFloat(stats.bounce_rate),
  };

  // `enabled` is whatever MailerLite returns — typically a boolean.
  // We pass through unchanged so the dashboard can render the
  // collapsed view when the legacy welcome automation gets paused
  // mid-transition. Paused automations also flip `status` to a
  // non-running value, so the dashboard checks both as a belt +
  // suspenders against MailerLite's slightly-inconsistent shape
  // across plan tiers / response vintages.
  return {
    automation_id: a.id || config.automationId,
    automation_name: a.name || a.title || '',
    status: a.status || '',
    enabled: a.enabled,
    completed: num(stats.completed_subscribers_count),
    in_flow:   num(stats.subscribers_in_queue_count),
    overall,
    emails,
  };
}

// Walk the parent_id linked list. Root step has parent_id null/undefined.
// Each subsequent step's parent_id points at the previous step's id.
// Defensive: if the chain is broken (orphan or cycle) we stop walking
// instead of looping forever, and any unreachable steps are dropped —
// they're not part of the live flow anyway.
function sortStepsByFlow(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return [];
  const byParent = new Map();
  for (const s of steps) {
    if (!s || s.id == null) continue;
    const key = s.parent_id == null ? 'ROOT' : String(s.parent_id);
    // First-write-wins so a malformed payload with duplicate parents
    // doesn't silently swap the order on us.
    if (!byParent.has(key)) byParent.set(key, s);
  }
  const ordered = [];
  const seen = new Set();
  let current = byParent.get('ROOT');
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    ordered.push(current);
    current = byParent.get(String(current.id));
  }
  return ordered;
}

function formatEmail(step, position) {
  const s = step || {};
  const email = s.email || {};
  const stats = email.stats || {};

  const sent         = num(stats.sent);
  const opens        = num(stats.opens_count);
  const clicks       = num(stats.clicks_count);
  const unsubscribes = num(stats.unsubscribes_count);
  const openRate     = numFloat(stats.open_rate);
  const clickRate    = numFloat(stats.click_rate);

  return {
    position,
    step_id: s.id != null ? String(s.id) : '',
    step_name: s.name || '',
    subject: s.subject || email.subject || '',
    sent,
    opens,
    clicks,
    unsubscribes,
    open_rate: openRate,
    click_rate: clickRate,
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// MailerLite wraps rate fields as { float: 0.4848, string: "48.48%" }.
// Some endpoints/vintages return a bare number instead, so handle both.
function numFloat(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'object' && v.float != null) {
    const n = Number(v.float);
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
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
