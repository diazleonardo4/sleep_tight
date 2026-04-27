// GET /api/email-stats  (header: x-auth-token)
//
// Returns open/click stats for individual steps in the Sleep Tight
// MailerLite automation. Used by the dashboard's Layer 3c panel.
//
// Sleep Tight runs as an automation (subscribe → Email 1 → wait →
// Email 3 → ...), NOT a one-shot campaign broadcast. The Connect API
// distinguishes the two with separate endpoints; we hit the
// automations endpoint and pluck out the steps we care about.
//
// Env vars:
//   MAILERLITE_API_TOKEN         (required) — Connect API token. The
//                                 classic /api/v2 token will 401 here.
//   MAILERLITE_AUTOMATION_ID     (required to enable card) — parent
//                                 automation containing all email steps.
//   MAILERLITE_EMAIL_1_STEP_ID   (optional) — step ID for "Email 1".
//   MAILERLITE_EMAIL_3_STEP_ID   (optional) — step ID for "Email 3".
//
// Bootstrapping the step IDs: hit the automation endpoint once
// manually with the token to see the available step IDs, then plug
// the right ones into Vercel env. If a STEP_ID is set but doesn't
// match any step in the automation, the response surfaces every
// available step ID so the misconfiguration is obvious.
//
// Response shape when configured:
// {
//   available: true,
//   automation_id, automation_name,
//   automation_totals: { sent, opens, opens_unique, clicks, clicks_unique },
//   email1: {  // present when MAILERLITE_EMAIL_1_STEP_ID resolves
//     step_id, step_name, subject,
//     sent, opens, clicks,
//     opens_unique, clicks_unique,         // snake_case (new spec)
//     opensUnique, clicksUnique,           // camelCase (dashboard renderer)
//     open_rate, click_rate,               // 0..1 fraction (new spec)
//     openRate, clickRate,                 // % out of 100 (dashboard renderer)
//   },
//   email3: { ...same shape... },
// }
//
// Graceful fallback: if MAILERLITE_API_TOKEN or MAILERLITE_AUTOMATION_ID
// is unset, responds 200 with { available: false, reason } so the
// dashboard renders a "not configured" state without breaking layout.
// Real API errors (401/403/404/network) surface with a verbose message
// that names the env var to fix — Leo reads these and diagnoses
// directly, so they need to actually be useful.

const cache = new Map(); // key -> { data, at }
const CACHE_MS = 5 * 60 * 1000; // 5 min — automation stats change slowly

module.exports = async (req, res) => {
  if (!checkAuth(req, res)) return;

  const token = process.env.MAILERLITE_API_TOKEN;
  const automationId = process.env.MAILERLITE_AUTOMATION_ID;
  const email1StepId = process.env.MAILERLITE_EMAIL_1_STEP_ID || '';
  const email3StepId = process.env.MAILERLITE_EMAIL_3_STEP_ID || '';

  if (!token) {
    return res.status(200).json({ available: false, reason: 'MAILERLITE_API_TOKEN not set' });
  }
  if (!automationId) {
    return res.status(200).json({ available: false, reason: 'MAILERLITE_AUTOMATION_ID not set' });
  }

  const cacheKey = `${automationId}:${email1StepId}:${email3StepId}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return res.status(200).json(hit.data);
  }

  try {
    const automation = await fetchAutomation(automationId, token);
    const data = buildResponse(automation, automationId, email1StepId, email3StepId);
    cache.set(cacheKey, { data, at: Date.now() });
    return res.status(200).json(data);
  } catch (err) {
    return res.status(502).json({ error: `Email stats error: ${err.message}` });
  }
};

async function fetchAutomation(automationId, token) {
  const url = `https://connect.mailerlite.com/api/automations/${encodeURIComponent(automationId)}`;
  let r;
  try {
    r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
  } catch (e) {
    throw new Error(`Network error reaching MailerLite Connect API: ${e.message}`);
  }

  if (r.ok) {
    const body = await r.json();
    return body.data || body || {};
  }

  // Non-OK: surface a verbose, action-oriented error. The current
  // 404 message ("HTTP 404 on campaign X") was already useful for
  // diagnosis — these aim for the same clarity.
  let bodyText = '';
  try { bodyText = (await r.text()).slice(0, 200); } catch (_) {}
  switch (r.status) {
    case 401:
      throw new Error(
        `Invalid or expired MailerLite API token (HTTP 401). ` +
        `Note: classic /api/v2 tokens will 401 against the Connect API — ` +
        `regenerate at dashboard.mailerlite.com → Integrations → API ` +
        `(make sure you're in the new MailerLite, not Classic).`
      );
    case 403:
      throw new Error(
        `MailerLite token lacks permission to read automations (HTTP 403). ` +
        `Add the automations scope to the API token.`
      );
    case 404:
      throw new Error(
        `Automation ${automationId} not found (HTTP 404). ` +
        `Verify MAILERLITE_AUTOMATION_ID — get the ID from MailerLite → ` +
        `Automations → click your sequence → URL contains the ID.`
      );
    case 429:
      throw new Error(`MailerLite rate limit hit (HTTP 429). Try again in a minute.`);
    default:
      throw new Error(`MailerLite Connect API HTTP ${r.status} on automation ${automationId}: ${bodyText}`);
  }
}

function buildResponse(automation, automationId, email1StepId, email3StepId) {
  const steps = Array.isArray(automation.steps) ? automation.steps : [];
  const stepsById = new Map(steps.map(s => [String(s.id || ''), s]));
  const availableIds = steps.map(s => `${s.id} (${s.name || s.subject || s.type || 'unnamed'})`);

  const emailEntry = (label, stepId) => {
    if (!stepId) return undefined;
    const step = stepsById.get(String(stepId));
    if (!step) {
      // Don't throw — surface the missing-step problem inline so the
      // other email card can still render. The dashboard's emailCard()
      // handles undefined gracefully (renders zeros), and we tag the
      // response with a clear missing_steps array on the way out.
      return { step_id: stepId, missing: true };
    }
    return formatStep(step);
  };

  const email1 = emailEntry('email1', email1StepId);
  const email3 = emailEntry('email3', email3StepId);

  // Build a list of misconfigured step IDs (set in env but not found
  // in the automation). Surfacing this on success lets the dashboard
  // — or anyone curl'ing the endpoint — see exactly what to fix
  // without having to chase a stack trace.
  const missing = [];
  if (email1StepId && !stepsById.has(String(email1StepId))) {
    missing.push({ slot: 'email1', configured_step_id: email1StepId });
  }
  if (email3StepId && !stepsById.has(String(email3StepId))) {
    missing.push({ slot: 'email3', configured_step_id: email3StepId });
  }

  const totals = aggregateTotals(steps);

  const out = {
    available: true,
    automation_id: automation.id || automationId,
    automation_name: automation.name || automation.title || '',
    automation_totals: totals,
    email1,
    email3,
  };
  if (missing.length) {
    out.missing_steps = missing;
    out.available_step_ids = availableIds;
    // Also stamp a top-level human-readable warning so the dashboard's
    // .error renderer (if we ever wire one) has something to show.
    out.warning =
      `Configured step ID(s) not found in automation ${automation.id || automationId}: ` +
      `${missing.map(m => `${m.slot}=${m.configured_step_id}`).join(', ')}. ` +
      `Available step IDs: ${availableIds.join('; ') || '(automation has no steps)'}.`;
  }
  return out;
}

// MailerLite returns step stats in a few shapes depending on account
// age and endpoint version: top-level (sent/opens_count/...), nested
// under .stats, or under .data.stats. We probe all three before
// falling back to zeros so missing fields render as 0 instead of NaN.
function formatStep(step) {
  const s = step || {};
  const stats = s.stats || s.statistics || {};

  const sent          = num(pick(stats.sent, stats.sent_count, s.sent, s.sent_count, s.total_sent));
  const opens         = num(pick(stats.opens_count, stats.opens, s.opens_count, s.opens, s.total_opens));
  const opensUnique   = num(pick(
    stats.unique_opens_count, stats.unique_opens, stats.opens_unique,
    s.unique_opens_count, s.unique_opens, s.opens_unique
  ));
  const clicks        = num(pick(stats.clicks_count, stats.clicks, s.clicks_count, s.clicks, s.total_clicks));
  const clicksUnique  = num(pick(
    stats.unique_clicks_count, stats.unique_clicks, stats.clicks_unique,
    s.unique_clicks_count, s.unique_clicks, s.clicks_unique
  ));

  // Fractions for new-spec consumers (0..1); percentages for the
  // dashboard renderer (0..100). Both derived from unique opens/clicks
  // since that's the metric that matches MailerLite's UI.
  const openFraction  = sent > 0 ? opensUnique / sent : 0;
  const clickFraction = sent > 0 ? clicksUnique / sent : 0;

  return {
    step_id: s.id != null ? String(s.id) : '',
    step_name: s.name || s.subject || '',
    subject: s.subject || s.name || '',
    sent,
    opens,
    clicks,
    // snake_case (new spec)
    opens_unique: opensUnique,
    clicks_unique: clicksUnique,
    open_rate: round4(openFraction),
    click_rate: round4(clickFraction),
    // camelCase (existing dashboard renderer — keep intact to avoid
    // a coordinated frontend change)
    opensUnique,
    clicksUnique,
    openRate: +(openFraction * 100).toFixed(2),
    clickRate: +(clickFraction * 100).toFixed(2),
  };
}

function aggregateTotals(steps) {
  let sent = 0, opens = 0, opensUnique = 0, clicks = 0, clicksUnique = 0;
  for (const step of steps) {
    if (!step) continue;
    const f = formatStep(step);
    sent          += f.sent;
    opens         += f.opens;
    opensUnique   += f.opens_unique;
    clicks        += f.clicks;
    clicksUnique  += f.clicks_unique;
  }
  return {
    sent,
    opens,
    opens_unique: opensUnique,
    clicks,
    clicks_unique: clicksUnique,
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
