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
// dedupe consecutive underscores, strip leading/trailing underscores.
function _slug(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const normalizeAdName = _slug;

// Reserved for future typo-consolidation. Kept as an empty map (rather
// than removed entirely) so callers don't need to branch on its
// existence — normalizeCampaignName below always does the lookup.
//
// IMPORTANT: only add an entry here when two slugs are *the same
// campaign* with different spellings. Distinct campaigns (e.g. an old
// paused campaign and a new active one) MUST stay as separate buckets
// even if their names look similar — merging them silently corrupts
// historical attribution and inflates the surviving bucket's metrics.
const UTM_ALIASES = {};

// Empty/missing utm_campaign collapses to this sentinel for filtering.
// Stored event payloads use null (not the sentinel) — the sentinel is
// only used in API query params to mean "filter to events with no UTM".
const DIRECT_CAMPAIGN_SENTINEL = '__direct__';

// Canonicalize utm_campaign: slug-normalize, then resolve through
// UTM_ALIASES so historical drift (e.g. sleep_tight_leadgen ➜
// sleep_tight_lead_target) merges into the canonical bucket at read
// time. Returns '' when the input is missing/blank — callers decide
// whether to translate that to null (storage) or to the direct
// sentinel (filtering).
function normalizeCampaignName(s) {
  const slug = _slug(s);
  if (!slug) return '';
  return UTM_ALIASES[slug] || slug;
}

// Returns true if `eventUtm` matches the active campaign filter.
//   - filter falsy           → no filter, always matches
//   - filter is sentinel     → matches only events with empty utm_campaign
//   - filter is a utm token  → matches events whose normalized utm equals it
function eventMatchesCampaign(eventUtm, filter) {
  if (!filter) return true;
  const norm = normalizeCampaignName(eventUtm || '');
  if (filter === DIRECT_CAMPAIGN_SENTINEL) return !norm;
  return norm === filter;
}

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
  eventMatchesCampaign,
  PLACEMENT_ALIASES,
  UTM_ALIASES,
  DIRECT_CAMPAIGN_SENTINEL,
};
