// Maps Meta campaign IDs (numeric, stable forever) to the canonical
// utm_campaign string we put in the landing-page URL templates. Meta's
// `campaign_name` is freeform user input ("Sleep Tight - Traffic
// Campaign") and doesn't need to match the snake_case utm_campaign
// ("sleep_tight_traffic"), so we maintain this explicit join table.
//
// To onboard a new campaign:
//   1. Create it in Meta Ads Manager.
//   2. Set the URL parameters to include utm_campaign=<canonical_name>.
//   3. Add an entry below mapping campaign_id → canonical_name.
//   4. Add a display label in api/_utils/campaign-display.js.
//   5. Redeploy.
const CAMPAIGN_ID_TO_UTM = {
  '6926783153028': 'sleep_tight_leadgen',
  '6929895898228': 'sleep_tight_lead_target',
};

function utmFromCampaignId(id) {
  return CAMPAIGN_ID_TO_UTM[String(id || '')] || null;
}

function campaignIdFromUtm(utmCampaign) {
  for (const [id, utm] of Object.entries(CAMPAIGN_ID_TO_UTM)) {
    if (utm === utmCampaign) return id;
  }
  return null;
}

module.exports = { CAMPAIGN_ID_TO_UTM, utmFromCampaignId, campaignIdFromUtm };
