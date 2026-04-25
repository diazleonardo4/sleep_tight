// Canonical normalizers shared across track.js, analytics.js,
// mailerlite.js, and meta.js. The dashboard joins data from three
// independently-named sources:
//   - Meta Insights API (campaign_name, ad_name, publisher_platform +
//     platform_position)
//   - URL UTM params written by the landing page (utm_campaign,
//     utm_content, utm_placement)
//   - MailerLite subscriber custom fields (mirror of UTMs at submit time)
// Each side has different casing/spelling, so every join goes through
// these helpers first.
//
// A mirror copy of normalizeAdName / normalizePlacement / PLACEMENT_ALIASES
// lives in dashboard.html for client-side joining — keep the two in sync.

// Slug-style: lowercase, trim, collapse whitespace and non-alnum to "_",
// dedupe consecutive underscores. Used for ad names AND campaign names —
// both come from user-typed Meta UI strings vs. snake_case UTM tokens.
function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_');
}

const normalizeAdName = normalizeName;
const normalizeCampaignName = normalizeName;

// Placement spellings split between two upstream sources:
//   - Meta Insights API publisher_platform + platform_position →
//     "Facebook_Feed", "Instagram_Instagram_reels", etc.
//   - {{placement}} URL macro substituted at click time →
//     "Facebook_Mobile_Feed", "Instagram_Reels", etc.
// Both get lowercased + underscored, then mapped through this alias table
// so they collapse to the same canonical key on join.
const PLACEMENT_ALIASES = {
  'facebook_mobile_feed': 'facebook_feed',
  'facebook_desktop_feed': 'facebook_feed',
  'facebook_feed': 'facebook_feed',
  'facebook_facebook_reels': 'facebook_reels',
  'facebook_reels': 'facebook_reels',
  'facebook_facebook_stories': 'facebook_stories',
  'facebook_stories': 'facebook_stories',
  'facebook_marketplace': 'facebook_marketplace',
  'facebook_right_column': 'facebook_right_column',
  'facebook_video_feeds': 'facebook_video_feeds',
  'facebook_search': 'facebook_search',
  'instagram_feed': 'instagram_feed',
  'instagram_stream': 'instagram_feed',
  'instagram_stories': 'instagram_stories',
  'instagram_story': 'instagram_stories',
  'instagram_reels': 'instagram_reels',
  'instagram_instagram_reels': 'instagram_reels',
  'instagram_explore': 'instagram_explore',
  'instagram_shop': 'instagram_shop',
  'audience_network_classic': 'audience_network',
  'audience_network_rewarded_video': 'audience_network',
  'audience_network_instream_video': 'audience_network',
  'messenger_messenger_inbox': 'messenger_inbox',
  'messenger_inbox': 'messenger_inbox',
  'messenger_messenger_stories': 'messenger_stories',
  'messenger_stories': 'messenger_stories',
};

function normalizePlacement(s) {
  const lower = String(s || '').toLowerCase().trim().replace(/\s+/g, '_');
  return PLACEMENT_ALIASES[lower] || lower;
}

module.exports = {
  normalizeAdName,
  normalizeCampaignName,
  normalizePlacement,
  PLACEMENT_ALIASES,
};
