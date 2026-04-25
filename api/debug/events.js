// TEMPORARY DEBUG ENDPOINT — remove after diagnostics complete.
//
// GET /api/debug/events?campaign=<utm_campaign>&event=<event_name>&range=today|7d|30d
// Header: x-auth-token (same DASHBOARD_PASSWORD check as /api/analytics)
//
// Returns raw event records from the events:<date> ZSETs in Redis, filtered
// to a given utm_campaign + event name across the date range. Used to
// diagnose dashboard aggregate-vs-raw discrepancies — show me the actual
// JSON the funnel is computed from, not the rolled-up numbers.
//
// Both `campaign` and `event` are optional. Omitting either skips that
// filter; omitting both returns every event in the range (capped at 500).
// `event` accepts a comma-separated list to OR multiple types — e.g.
// `event=pageview,form_submit_success`.
//
// Notes on the response shape:
//   - `path` is what's stored (we don't keep the full URL — see api/track.js).
//   - `by_event_type` tallies the raw `event` field as stored. Our event
//     vocabulary is pageview, scroll_depth, cta_click, form_focus,
//     form_submit_success, form_submit_error, exit_intent. Scroll-depth
//     granularity (25/50/75/100) lives in `metadata.depth`, not in the
//     event name itself, so it doesn't appear here as separate buckets.
//   - `events` is capped at 500, sorted by timestamp DESC.
//   - `campaign === "__direct__"` filters to events with empty utm_campaign.
//
// Do NOT link this from the dashboard nav. Keep it auth-gated and remove
// the entire api/debug/ folder once the diagnostic work is done.

const { getRedis } = require('../../lib/redis');
const { getDateRange, normalizeRange } = require('../_utils/dates');
const {
  normalizeCampaignName,
  DIRECT_CAMPAIGN_SENTINEL,
} = require('../_utils/attribution');

const MAX_EVENTS = 500;

module.exports = async (req, res) => {
  if (!checkAuth(req, res)) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const range = normalizeRange(readQuery(req, 'range') || 'today');
  const dashboardRange = getDateRange(range);

  // Campaign filter:
  //   - omitted / empty           → no filter, return all events in range
  //   - "__direct__" sentinel      → only events with empty utm_campaign
  //   - any other string           → slug-normalized then equality match
  const rawCampaignParam = readQuery(req, 'campaign') || '';
  let campaignFilter = null;       // null = no filter
  let campaignFilterIsDirect = false;
  if (rawCampaignParam) {
    if (rawCampaignParam === DIRECT_CAMPAIGN_SENTINEL) {
      campaignFilterIsDirect = true;
      campaignFilter = DIRECT_CAMPAIGN_SENTINEL;
    } else {
      campaignFilter = normalizeCampaignName(rawCampaignParam);
    }
  }

  // Event-type filter. Comma-separated list, trimmed, lowercased. Empty
  // → no filter. We do NOT validate against VALID_EVENTS — debug endpoint
  // should be honest about what's stored, including any unexpected values.
  const rawEventParam = readQuery(req, 'event') || '';
  const eventFilter = rawEventParam
    ? new Set(
        String(rawEventParam)
          .toLowerCase()
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
      )
    : null;

  const redis = getRedis();
  const dateKeys = listDates(dashboardRange.since, dashboardRange.until)
    .map(d => `events:${d}`);

  const matched = [];
  const byEventType = Object.create(null);
  const byVisitor = Object.create(null);

  try {
    for (const key of dateKeys) {
      // ZRANGE with WITHSCORES — score is the epoch-ms timestamp from track.js.
      const rows = await redis.zrange(key, 0, -1, 'WITHSCORES');
      for (let i = 0; i < rows.length; i += 2) {
        const member = rows[i];
        const score = Number(rows[i + 1]);
        let p;
        try { p = JSON.parse(member); } catch (_) { continue; }
        if (!p) continue;

        const utm = p.utm_campaign || '';
        if (campaignFilterIsDirect) {
          if (utm) continue;
        } else if (campaignFilter) {
          if (normalizeCampaignName(utm) !== campaignFilter) continue;
        }

        const evt = String(p.event || '');
        if (eventFilter && !eventFilter.has(evt)) continue;
        byEventType[evt] = (byEventType[evt] || 0) + 1;
        if (p.visitor_id) {
          byVisitor[p.visitor_id] = (byVisitor[p.visitor_id] || 0) + 1;
        }

        matched.push({
          t: score,
          timestamp: p.timestamp,
          date: p.date,
          visitor_id: p.visitor_id || null,
          session_id: p.session_id || null,
          event: evt,
          path: p.path || null,
          referrer: p.referrer || null,
          utm_source: p.utm_source || null,
          utm_medium: p.utm_medium || null,
          utm_campaign: p.utm_campaign || null,
          utm_content: p.utm_content || null,
          utm_placement: p.utm_placement || null,
          country: p.country || null,
          browser: p.browser || null,
          os: p.os || null,
          device_type: p.device_type || null,
          metadata: p.metadata || null,
        });
      }
    }
  } catch (err) {
    return res.status(500).json({ error: `Redis error: ${err.message}` });
  }

  // Sort matched events by epoch ms desc, then cap.
  matched.sort((a, b) => b.t - a.t);
  const events = matched.slice(0, MAX_EVENTS);

  return res.status(200).json({
    range: dashboardRange,
    campaign: campaignFilter,        // null when unfiltered
    event_filter: eventFilter ? Array.from(eventFilter) : null, // null when unfiltered
    total_events: matched.length,    // pre-cap total matching all filters
    returned: events.length,         // post-cap
    cap: MAX_EVENTS,
    by_event_type: byEventType,
    by_visitor: byVisitor,
    events,
  });
};

function readQuery(req, key) {
  if (req.query && req.query[key]) return req.query[key];
  return new URL(req.url, 'http://x').searchParams.get(key);
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

// YYYY-MM-DD inclusive enumeration. Dates here are calendar labels (the
// keys are events:YYYY-MM-DD), so stepping in UTC at day granularity is
// safe — no DST drift to worry about because we're not advancing wall
// clock time, just incrementing the day-of-month label.
function listDates(since, until) {
  const dates = [];
  const start = new Date(since + 'T00:00:00Z');
  const end = new Date(until + 'T00:00:00Z');
  if (isNaN(start) || isNaN(end) || start > end) return dates;
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}
