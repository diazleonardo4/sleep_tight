// Display labels for utm_campaign tokens. Used wherever campaign names
// are rendered in the dashboard UI. Future campaigns just need a new
// entry — falling back to the raw utm_campaign token keeps the table
// readable even before this is updated.
//
// Keep in sync with the dashboard.html mirror (CAMPAIGN_DISPLAY_NAMES).

const CAMPAIGN_DISPLAY_NAMES = {
  sleep_tight_traffic: 'Traffic',
  sleep_tight_lead_target: 'Leads',
  // Older Leads-style campaign that was paused — kept as a distinct
  // bucket (NOT aliased into sleep_tight_lead_target) so historical
  // attribution stays clean. The "(paused)" tag flags its status in
  // the picker.
  sleep_tight_leadgen: 'Leadgen (paused)',
};

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
