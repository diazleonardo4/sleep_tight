// GET /api/download-pdf
//
// Public 302 redirect to the canonical Sleep Tight guide download
// URL. The destination is read from SLEEP_TIGHT_DOWNLOAD_URL at
// request time so the URL can be rotated without redeploying — set
// it in Vercel → Project → Settings → Environment Variables to
// either a Google Drive share link, an S3 signed URL, or whatever
// host the latest guide lives on.
//
// Why an indirection layer instead of linking the Drive URL
// directly:
//   1. Single point to swap when the guide gets re-versioned.
//   2. Lets the URL stay out of committed HTML (avoids leaking
//      analytics / tracking parameters that some hosts append).
//   3. We can layer per-request logging here later (download
//      counts, referer attribution) without touching the consumers.
//
// If SLEEP_TIGHT_DOWNLOAD_URL is unset, we 503 with a plain-text
// message so the failure is loud during setup. Loud-fail beats
// silently 302'ing to "" (which most browsers render as a reload
// loop on the current page).

module.exports = (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const target = process.env.SLEEP_TIGHT_DOWNLOAD_URL;
  if (!target || !/^https?:\/\//i.test(target)) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(503).send(
      'Download is temporarily unavailable. ' +
      '(Server config: set SLEEP_TIGHT_DOWNLOAD_URL in Vercel.)'
    );
  }

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Location', target);
  return res.status(302).end();
};
