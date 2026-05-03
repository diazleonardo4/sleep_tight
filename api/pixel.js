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
  // 60s cache on both the Vercel edge (s-maxage) and the browser
  // (max-age). Short enough that env-var rotations propagate within
  // a minute, long enough that a thank-you page burst still gets
  // edge-served. Was 300s previously, which made env-var debugging
  // painful — every typo took ~5 min to disprove.
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');

  const pixelId = process.env.META_PIXEL_ID;
  const bundleUrlBaseRaw = (process.env.BUNDLE_URL_BASE || '').trim();

  // Validate the bundle URL before letting it reach the static
  // thank-you page. The render script there constructs `new URL(...)`
  // from this value, which throws on anything missing the protocol
  // (e.g. "gumroad.com/l/foo" instead of "https://gumroad.com/l/foo").
  // A throw inside the synchronous render kills #content, leaving a
  // blank page -- exactly the symptom we just diagnosed.
  //
  // If the env value doesn't parse as an absolute http(s) URL, emit
  // null. The thank-you page then falls back to its hardcoded
  // placeholder, which 404s on click but at least keeps the page
  // visible. Also append a console.warn into the response body so
  // DevTools surfaces the misconfiguration loudly the next time this
  // happens, instead of silently degrading.
  // Validate (and lightly normalize) the bundle URL. Three accepted
  // shapes, in priority order:
  //   1. https://host/...  -> use as-is
  //   2. http://host/...   -> use as-is (rare, but technically valid)
  //   3. host/...  (no protocol) -> auto-prepend https:// if it parses
  //      cleanly with the prefix added. Common paste-from-Vercel-input
  //      mistake (people drop the protocol when copying from a Gumroad
  //      address bar). Auto-prepending here is safer than failing
  //      silently behind a fallback URL.
  // Anything else (ftp://, mailto:, garbage, just a path) is rejected
  // with a console.warn that surfaces the offending value so DevTools
  // explains the misconfig instead of silently fading to placeholder.
  let bundleUrlBase = '';
  let bundleUrlWarning = '';
  let bundleSourceDetail = ''; // appended to the diagnostic comment
  if (bundleUrlBaseRaw) {
    const tryParse = (candidate) => {
      try {
        const u = new URL(candidate);
        if (u.protocol === 'https:' || u.protocol === 'http:') {
          // Require a non-empty host. `new URL("https://")` parses
          // but produces an empty hostname; we don't want that.
          if (u.hostname) return u.toString();
        }
      } catch (_) {}
      return null;
    };

    const direct = tryParse(bundleUrlBaseRaw);
    if (direct) {
      bundleUrlBase = direct;
      bundleSourceDetail = 'as-typed';
    } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(bundleUrlBaseRaw)) {
      // No protocol scheme detected — try prepending https://. We
      // only do this when the input doesn't already declare some
      // other scheme, so e.g. "ftp://..." still gets rejected
      // outright instead of being silently rewritten.
      const prefixed = tryParse('https://' + bundleUrlBaseRaw);
      if (prefixed) {
        bundleUrlBase = prefixed;
        bundleSourceDetail = 'auto-prefixed https://';
      }
    }

    if (!bundleUrlBase) {
      bundleUrlWarning =
        'BUNDLE_URL_BASE env var is not a valid absolute http(s) URL ' +
        '(got: ' + JSON.stringify(bundleUrlBaseRaw) + '). ' +
        'Falling back to placeholder URL on the thank-you page.';
    }
  }

  // Self-diagnostic comment block at the head of the response.
  // When debugging "why is the thank-you page still showing the old
  // URL?" the answer is almost always one of three things:
  //   1. Browser cached the previous response (force-refresh /api/pixel.js)
  //   2. Vercel edge cached the previous response (60s TTL — wait, or
  //      append a query string like ?_=<ts> to bypass the cache key)
  //   3. The env var hasn't been picked up by the deployed function
  //      (changing env vars in Vercel requires a redeploy to take
  //      effect on the active production deployment)
  // Surface enough state in the body that we can rule each out with
  // a direct browser fetch instead of guessing.
  //
  // SAFE TO SURFACE: BUNDLE_URL_BASE is a public Gumroad URL — we'd
  // be embedding it in the response anyway. We do NOT include any
  // sensitive env vars here.
  const generatedAt = new Date().toISOString();
  const bundleSource = bundleUrlBase
    ? `env (validated${bundleSourceDetail ? ', ' + bundleSourceDetail : ''})`
    : (bundleUrlBaseRaw ? 'env (REJECTED — see warning below)' : 'unset');
  const bundleRawDisplay = bundleUrlBaseRaw
    ? JSON.stringify(bundleUrlBaseRaw)
    : '(empty / unset)';
  const diagnosticBlock =
    `/* Sleep Tight public config\n` +
    ` * generated_at:    ${generatedAt}\n` +
    ` * bundle_url:      ${bundleUrlBase || '(null — using thank-you fallback URL)'}\n` +
    ` * bundle_source:   ${bundleSource}\n` +
    ` * raw_env_value:   ${bundleRawDisplay}\n` +
    ` * pixel_id_set:    ${Boolean(pixelId && /^\d+$/.test(pixelId))}\n` +
    ` */\n`;

  // Public-config envelope. Always emitted (even when env vars are
  // unset) so consumers can `window.__SLEEP_TIGHT_PUBLIC_CONFIG__?.bundleUrl`
  // safely. JSON.stringify handles embedded quotes / newlines
  // defensively, even though we only ever expect a plain HTTPS URL.
  const configBlock =
    `window.__SLEEP_TIGHT_PUBLIC_CONFIG__ = window.__SLEEP_TIGHT_PUBLIC_CONFIG__ || {};\n` +
    `window.__SLEEP_TIGHT_PUBLIC_CONFIG__.bundleUrl = ${
      bundleUrlBase ? JSON.stringify(bundleUrlBase) : 'null'
    };\n` +
    (bundleUrlWarning
      ? `try{(window.console||{}).warn&&console.warn(${JSON.stringify('[Sleep Tight config] ' + bundleUrlWarning)});}catch(_){}\n`
      : '');

  if (!pixelId || !/^\d+$/.test(pixelId)) {
    // Pixel disabled — still emit the public-config envelope so
    // the thank-you page's bundle CTA can wire up.
    return res.status(200).send(
      diagnosticBlock +
      `/* Meta Pixel disabled: META_PIXEL_ID not set */\n` +
      configBlock
    );
  }

  // Standard Meta Pixel base code, verbatim except the id comes from env.
  const pixelBlock = `/* Meta Pixel base code — id injected from env */
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init', ${JSON.stringify(pixelId)});
fbq('track', 'PageView');
`;
  return res.status(200).send(diagnosticBlock + pixelBlock + configBlock);
};
