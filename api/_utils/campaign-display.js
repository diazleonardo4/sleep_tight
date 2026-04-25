// Display labels for utm_campaign tokens. Intentionally empty — the
// dashboard now renders the raw (slug-normalized) utm_campaign string
// directly. Add an entry here only if you want a prettier label for a
// specific campaign in the picker; the lookup falls back to the raw
// token, so unmapped campaigns still render readably.
//
// Keep in sync with the dashboard.html mirror (CAMPAIGN_DISPLAY_NAMES).
const CAMPAIGN_DISPLAY_NAMES = {};

// Empty / null utm_campaign means the visitor came in without a UTM tag —
// organic, direct, social share without parameters, or our own untagged
// QA. Surfacing this bucket in the picker is half the value of the
// feature: a sudden spike here usually signals broken tagging upstream.
const DIRECT_DISPLAY_NAME = 'Direct/Untagged';

function getDisplayName(utmCampaign) {
  if (!utmCampaign) return DIRECT_DISPLAY_NAME;
  return CAMPAIGN_DISPLAY_NAMES[utmCampaign] || utmCampaign;
}

module.exports = { CAMPAIGN_DISPLAY_NAMES, DIRECT_DISPLAY_NAME, getDisplayName };
