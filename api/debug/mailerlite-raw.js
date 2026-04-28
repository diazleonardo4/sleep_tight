// TEMPORARY DEBUG ENDPOINT — remove after diagnosis.
//
// GET /api/debug/mailerlite-raw
// Header: x-auth-token (same DASHBOARD_PASSWORD check as the rest of
// the dashboard API)
//
// Hits four MailerLite endpoints for the welcome automation
// (184771321849185715) and returns every response body untouched —
// no shaping, no filtering, no error normalization beyond preserving
// the HTTP status. /api/email-stats is currently parsing the base
// automation response and getting zeros for sent/opens/clicks; this
// endpoint exists to find the URL where engagement stats actually
// live so we can repoint the production parser there.
//
// Endpoints probed:
//   1. GET /api/automations/{id}
//   2. GET /api/automations/{id}/activity
//   3. GET /api/automations/{id}/subscribers?limit=5
//   4. GET /api/campaigns/{step_id}            for each step in (1)
//
// Some of these 404 on certain MailerLite plans — that's expected
// and informative. The HTTP status is included with every response
// so the caller can see which paths return real data.
//
// After diagnosis, delete this file and remove the api/debug/
// folder once events.js is also retired.

const WELCOME_AUTOMATION_ID = '184771321849185715';
const BASE = 'https://connect.mailerlite.com/api';

module.exports = async (req, res) => {
  if (!checkAuth(req, res)) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = process.env.MAILERLITE_API_TOKEN;
  if (!token) {
    return res.status(500).json({
      error: 'MAILERLITE_API_TOKEN not set',
    });
  }

  const automationId = WELCOME_AUTOMATION_ID;

  // 1. Base automation — needed first because we extract step IDs
  // from it for the per-step probes (#4). The other two automation-
  // scoped probes (#2, #3) are independent and can run in parallel
  // with the base fetch.
  const [baseResult, activityResult, subscribersResult] = await Promise.all([
    rawFetch(`${BASE}/automations/${automationId}`, token),
    rawFetch(`${BASE}/automations/${automationId}/activity`, token),
    rawFetch(`${BASE}/automations/${automationId}/subscribers?limit=5`, token),
  ]);

  // Pull step IDs out of the base response if it succeeded. Defensive
  // because the response shape might be { data: { steps: [...] } } or
  // { steps: [...] } depending on MailerLite plan/version.
  const stepsArr = extractSteps(baseResult.body);
  const perStepResults = await Promise.all(
    stepsArr.map(async (step) => ({
      step_id: step.id != null ? String(step.id) : '',
      name: step.name || step.subject || '',
      type: step.type || '',
      campaigns_endpoint: step.id != null
        ? await rawFetch(`${BASE}/campaigns/${encodeURIComponent(step.id)}`, token)
        : { status: 0, body: { error: 'no step.id present' } },
    }))
  );

  return res.status(200).json({
    automation_id: automationId,
    fetched_at: new Date().toISOString(),
    base: baseResult,
    activity: activityResult,
    subscribers: subscribersResult,
    per_step: perStepResults,
  });
};

// rawFetch — never throws. Returns { status, body, headers? } where
// body is the parsed JSON when possible, else the text body, else an
// error stub. Network failures land in status 0 so the caller can
// distinguish "API returned an error" from "we never reached the API".
async function rawFetch(url, token) {
  let r;
  try {
    r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
  } catch (e) {
    return { status: 0, url, body: { error: `network: ${e.message}` } };
  }

  const status = r.status;
  let body;
  try {
    const text = await r.text();
    if (!text) {
      body = null;
    } else {
      try { body = JSON.parse(text); }
      catch (_) { body = { _raw_text: text.slice(0, 4000) }; }
    }
  } catch (e) {
    body = { error: `body read: ${e.message}` };
  }
  return { status, url, body };
}

function extractSteps(body) {
  if (!body || typeof body !== 'object') return [];
  const fromData = body.data && Array.isArray(body.data.steps) ? body.data.steps : null;
  const fromTop = Array.isArray(body.steps) ? body.steps : null;
  return fromData || fromTop || [];
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
