// GET /api/pixel.js
// Public client-config bootstrap, served as JavaScript. Two
// responsibilities, one endpoint:
//
//   1. Meta Pixel base + PageView (legacy purpose — the original
//      reason this file exists). Pixel ID injected from
//      META_PIXEL_ID at request time so the id never has to be
//      hardcoded in any committed file.
//
//   2. window.__SLEEP_TIGHT_PUBLIC_CONFIG__ — a tiny envelope of
//      env-driven values that the static HTML pages need to read at
//      runtime. Currently exposes BUNDLE_URL_BASE (the Gumroad
//      destination for the thank-you page's bundle CTA). The
//      pattern lets us keep static HTML files but still rotate
//      destination URLs via Vercel env vars without redeploying
//      the HTML.
//
// Why piggyback both on this endpoint instead of two separate
// functions: Vercel Hobby caps a deployment at 12 serverless
// functions and we're already at the cap. /api/pixel.js loads
// on every page anyway, so adding a few extra characters of JS
// to its response is free.
//
// If META_PIXEL_ID is unset, the Pixel section emits an empty
// (but valid) JS comment — `typeof fbq` stays undefined downstream
// and Preview / local-dev stays clean of Pixel traffic.
//
// If BUNDLE_URL_BASE is unset, the public-config envelope still
// lands (with bundleUrl: null) so callers can feature-detect
// without crashing. Thank-you's render script falls back to a
// hardcoded placeholder in that case.
//
// Known trade-off carried over from the legacy shape: the classic
// Meta <noscript><img ...></noscript> fallback can't come from an
// external script, so users with JS disabled won't hit the
// tracking pixel. Negligible segment on ad-driven mobile traffic.

module.exports = (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  // Short edge cache so env-var rotations propagate quickly. The
  // serverless container keeps env reads hot anyway, so the cost
  // of rebuilding the body per origin request is negligible.
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');

  const pixelId = process.env.META_PIXEL_ID;
  const bundleUrlBase = process.env.BUNDLE_URL_BASE || '';

  // Public-config envelope. Always emitted (even when both env
  // vars are unset) so consumers can `window.__SLEEP_TIGHT_PUBLIC_CONFIG__?.bundleUrl`
  // safely. JSON.stringify on the URL handles any embedded quotes
  // / newlines defensively, even though we only ever expect a
  // plain HTTPS URL here.
  const configBlock =
    `window.__SLEEP_TIGHT_PUBLIC_CONFIG__ = window.__SLEEP_TIGHT_PUBLIC_CONFIG__ || {};\n` +
    `window.__SLEEP_TIGHT_PUBLIC_CONFIG__.bundleUrl = ${
      bundleUrlBase ? JSON.stringify(bundleUrlBase) : 'null'
    };\n`;

  if (!pixelId || !/^\d+$/.test(pixelId)) {
    // Pixel disabled — still emit the public-config envelope so
    // the thank-you page's bundle CTA can wire up.
    return res.status(200).send(
      `/* Meta Pixel disabled: META_PIXEL_ID not set */\n${configBlock}`
    );
  }

  // Standard Meta Pixel base code, verbatim except the id comes from env.
  const pixelBlock = `/* Meta Pixel base code — id injected from env */
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init', ${JSON.stringify(pixelId)});
fbq('track', 'PageView');
`;
  return res.status(200).send(pixelBlock + configBlock);
};
