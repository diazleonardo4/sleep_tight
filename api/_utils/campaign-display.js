// Display labels for utm_campaign tokens. Used wherever campaign names
// are rendered in the dashboard UI. Future campaigns just need a new
// entry — falling back to the raw utm_campaign token keeps the table
// readable even before this is updated.
//
// Keep in sync with the dashboard.html mirror (CAMPAIGN_DISPLAY_NAMES).

const CAMPAIGN_DISPLAY_NAMES = {
  sleep_tight_traffic: 'Traffic',
  sleep_tight_lead_target: 'Leads',
};

function getDisplayName(utmCampaign) {
  return CAMPAIGN_DISPLAY_NAMES[utmCampaign] || utmCampaign;
}

module.exports = { CAMPAIGN_DISPLAY_NAMES, getDisplayName };
