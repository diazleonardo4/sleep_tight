# Sleep Tight Dashboard

Single-page metrics dashboard at `/dashboard` that pulls live data from Meta Ads, MailerLite, and self-hosted Redis analytics. Password-protected, read-only.

## Required environment variables

Set these in Vercel → Project Settings → Environment Variables (apply to Production, Preview, and Development as needed).

| Variable | Where to get it | Notes |
| --- | --- | --- |
| `DASHBOARD_PASSWORD` | You choose it. Use a strong random string (1Password → generate, 24+ chars). | Gate for the whole dashboard. Anyone with this value can view all metrics. |
| `META_AD_ACCOUNT_ID` | Meta Ads Manager → top-left account selector → copy the ID (format: `act_1234567890`). | Must include the `act_` prefix. |
| `META_ACCESS_TOKEN` | [Meta Graph API Explorer](https://developers.facebook.com/tools/explorer/) → select your app → generate a token with `ads_read` permission. For long-lived use, exchange via `oauth/access_token?grant_type=fb_exchange_token`. | Token expires — rotate every ~60 days. A system-user token from Business Settings never expires and is preferred for production. |
| `MAILERLITE_API_TOKEN` | MailerLite → Integrations → Developer API → Generate new token. | Needs read access to subscribers. |
| `MAILERLITE_FREE_EBOOK_GROUP_ID` | MailerLite → Subscribers → Groups → click the free-ebook group → copy the numeric ID from the URL. | Numeric string. |
| `MAILERLITE_PAID_BUNDLE_GROUP_ID` | MailerLite → Subscribers → Groups → click the paid-bundle group → copy the ID from the URL. | Numeric string. |
| `DASHBOARD_TIMEZONE` | IANA timezone name (e.g. `America/Bogota`). Defaults to `America/Bogota` if unset. | This is the canonical TZ for all "today / 7d / 30d" date math shown in the dashboard. |
| `META_AD_ACCOUNT_TIMEZONE` | Meta Business Settings → Ad Accounts → your account → Time zone. IANA name (e.g. `America/Los_Angeles`). Defaults to `DASHBOARD_TIMEZONE` if unset. | Only needed when your ad account TZ differs from the dashboard TZ. Controls how the dashboard-TZ range is translated for Meta's API. |
| `REDIS_URL` | Vercel → Storage → connect a Redis database (Upstash, Vercel KV, or similar). The URL is injected automatically. | Backs self-hosted pageview / engagement / audience analytics. Without it, `/api/track` and `/api/analytics` will fail and Pageviews falls back to Meta clicks. |

After adding or changing env vars, redeploy (Vercel → Deployments → ⋯ → Redeploy) so the serverless functions pick them up.

## How to set env vars in Vercel

1. Open the project in Vercel.
2. Settings → Environment Variables.
3. For each variable above: enter the name + value, check **Production** (and **Preview** if you want the dashboard to work on preview URLs), click **Save**.
4. Trigger a redeploy so the new values are loaded.

## How to access the dashboard

1. Navigate to `https://<your-domain>/dashboard`.
2. Enter the value of `DASHBOARD_PASSWORD`.
3. The dashboard fetches Meta + MailerLite data in parallel and renders today + last-7-days cards, plus per-ad and per-placement tables.
4. The password is cached in `sessionStorage` for the browser session — closing the tab signs you out. Use the **Logout** button to clear it manually.

Data auto-loads on page open. Click **Refresh** to re-fetch (server caches each source for 60s to keep API quotas safe).

## How to rotate tokens if compromised

### `DASHBOARD_PASSWORD`
1. Vercel → Settings → Environment Variables → edit `DASHBOARD_PASSWORD` → set a new value.
2. Redeploy. All existing dashboard sessions are invalidated on next request.
3. Share the new password through a secure channel (1Password share, Signal).

### `META_ACCESS_TOKEN`
1. Meta Business Settings → System Users (or Graph API Explorer) → revoke the old token.
2. Generate a new token with `ads_read` scope.
3. Update `META_ACCESS_TOKEN` in Vercel → redeploy.

### `MAILERLITE_API_TOKEN`
1. MailerLite → Integrations → Developer API → delete the compromised token.
2. Generate a new token with the same permissions.
3. Update `MAILERLITE_API_TOKEN` in Vercel → redeploy.

### Group IDs / ad account ID
These are not secrets — rotating them means pointing the dashboard at different groups or an ad account. Update the env var and redeploy.

## Security notes

- All `/api/*` endpoints require the `x-auth-token` header to match `DASHBOARD_PASSWORD`. There is no other auth layer — treat the password as the only gate.
- Tokens are never logged. The serverless functions hold them only in `process.env`.
- If you suspect the password has been shared, rotate it immediately (steps above). The old sessions become unusable on the next API call.
- `/api/track` is the only public endpoint. It's IP rate-limited to 60 req/min and fails open so tracking issues never break the site for real users.
- All other `/api/*` endpoints require the `x-auth-token` header to match `DASHBOARD_PASSWORD`.

## Files

- `dashboard.html` — the UI.
- `api/auth.js` — password check, returns the auth token.
- `api/config.js` — exposes the dashboard timezone to the client.
- `api/meta.js` — Meta Ads insights (today / last 7 days / last 30 days, per-ad, per-placement).
- `api/mailerlite.js` — subscriber counts + UTM breakdowns for free and paid groups.
- `api/track.js` — public event ingestion. Writes pageviews, CTA clicks, scroll depth, form events, and exit intent to Redis.
- `api/analytics.js` — aggregates Redis events into pageviews, uniques, scroll funnel, form funnel, exit intent, and country / device / referrer breakdowns.
- `api/_utils/dates.js` — shared date/timezone helpers. All date bucketing goes through here — never use `toISOString().slice(0, 10)` elsewhere.
- `lib/redis.js` — shared ioredis singleton (reused across warm invocations).
- `vercel.json` — rewrites `/dashboard` to `/dashboard.html`.
