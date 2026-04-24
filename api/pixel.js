// GET /api/pixel.js
// Returns the Meta Pixel bootstrap JavaScript with META_PIXEL_ID
// substituted at runtime. The landing page loads this via
// <script async src="/api/pixel.js"> so the Pixel ID never has to be
// hardcoded in any committed file.
//
// If META_PIXEL_ID is unset, returns an empty (but valid) JS body.
// That keeps Preview / local-dev clean of Pixel traffic automatically.
//
// Why this shape instead of a templated HTML snippet in <head>:
//   - index.html is plain static HTML served directly by Vercel — no
//     SSR / no build-time templating.
//   - A tiny API route is simpler than a Vercel build hook or edge
//     middleware that rewrites responses.
//   - Async <script src> preserves the non-blocking load behavior of
//     Meta's stock snippet (no impact on LCP / TBT).
//
// Known trade-off: the classic Meta <noscript><img ...></noscript>
// fallback can't come from an external script, so users with JS
// disabled won't hit the tracking pixel. That's a negligible segment
// on ad-driven mobile traffic and isn't worth adding HTML rewriting for.

module.exports = (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  // Short edge cache so rotations propagate quickly; serverless keeps
  // the env read hot anyway.
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');

  const pixelId = process.env.META_PIXEL_ID;
  if (!pixelId || !/^\d+$/.test(pixelId)) {
    // Nothing to install. Empty body so the <script> tag resolves
    // without error and `typeof fbq` stays undefined downstream.
    return res.status(200).send('/* Meta Pixel disabled: META_PIXEL_ID not set */\n');
  }

  // Standard Meta Pixel base code, verbatim except the id comes from env.
  const body = `/* Meta Pixel base code — id injected from env */
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init', ${JSON.stringify(pixelId)});
fbq('track', 'PageView');
`;
  return res.status(200).send(body);
};
