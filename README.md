# Creator Publishing Tool

An existing Node.js / Express Instagram Publisher backend, with a private mobile dashboard and official Meta authorization. This is a **single-owner workspace**, not a public multi-tenant SaaS. Every person who knows the dashboard password can manage every connected account. Do not share that password with clients.

## Review status

The phone-based bulk Reel upload changes are prepared on a feature branch for review; they are not yet deployed to the live Render app. The current live app still accepts public media URLs. Do not use the live site for account access or publishing while Chrome or Google Search Console reports a security warning. A passing test suite does not establish Safe Browsing clearance.

## Run and test

Use Node.js 22 or newer (verified locally on Node 24). Run `npm ci`, then `npm test`. Tests use Express over local HTTP and PGlite, a local PostgreSQL engine. Meta HTTP responses are mocked; tests never publish to Instagram or contact a real database. PGlite is a development dependency, not the production database.

Copy `.env.example` to `.env` and configure the required private values. Start with `npm start`. In production use a persistent PostgreSQL database and `npm ci --omit=dev`. Keep `.env` out of git.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Persistent PostgreSQL connection string |
| `TOKEN_ENCRYPTION_KEY` | Stable, canonical base64 encoding of 32 random bytes |
| `DASHBOARD_PASSWORD` | Private owner password; 16–256 characters, preferably a generated unique password |
| `REDIRECT_URI` | Exact canonical callback, e.g. `https://YOUR-SERVICE.onrender.com/auth/meta/callback` |
| `META_APP_ID`, `META_APP_SECRET` | Facebook Login app credentials |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` | Separate credentials from Instagram API setup with Instagram Login |
| `META_GRAPH_VERSION` | Defaults to `v24.0`; review compatibility before changing |
| `PGSSL` | `verify-full` verifies the server certificate (default); `require` requires encrypted TLS without certificate verification, for Render's self-signed internal Postgres certificate; `disable` turns TLS off and is only for local testing |
| `NODE_ENV` | Set to `production` on the deployed service |

For a Render-hosted app in the same region, use the database's internal URL. Render's internal Postgres TLS certificate is self-signed, so set `PGSSL=require` to require encryption without certificate verification. Use `verify-full` when the database presents a certificate trusted by the Node.js runtime.

Generate the encryption key locally with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`. Save it privately in Render environment settings and a secure backup. Never paste it into a chat or commit it. Losing/changing it makes saved tokens unreadable; key rotation needs an explicit migration. Changing the dashboard password invalidates existing sessions without deleting account connections.

Missing database, encryption key, owner password or a valid callback disables sign-in and publishing. `/health` remains a liveness endpoint; `/ready` returns 503 until configuration and database initialization succeed. Database startup retries every minute. Graceful shutdown stops accepting requests and closes database connections.

## Database ownership and migration

New tables are named `publisher_sessions`, `publisher_oauth_attempts`, `publisher_accounts`, `publisher_jobs`, `publisher_batches`, and `publisher_media_assets`. Accounts belong to the private workspace, not a browser session, so sign-out and session expiry do not delete them. Tokens use AES-256-GCM authenticated with provider/account identity. Uploaded videos are stored in Postgres as short-lived private assets and are deleted after expiry when no active job needs them.

The older PR prototype used `connected_accounts` tied to anonymous sessions. If that table contains data, initialization **stops** for an owner-reviewed migration; this version does not drop, delete, or silently adopt it. Do not point an unrelated app at this database. Back up the database and encryption key before production changes. Job idempotency records are retained; deleting them removes retry protection for those requests.

## Meta authorization

Configure the exact `REDIRECT_URI` in each enabled login product. Facebook and direct Instagram use the same callback route but different app credentials and state-bound providers.

- **Facebook Login**: `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`. Discovers eligible professional accounts linked to accessible Facebook Pages, including paginated Page lists. Authorizing one Facebook user only grants accounts they can actually manage; it cannot sign in arbitrary accounts.
- **Instagram Login**: `instagram_business_basic`, `instagram_business_content_publish`. Direct professional-account authorization does not use Facebook Page discovery. Each account must authorize the app through the official flow. Configure the Instagram credentials from the Instagram API setup, not by copying the Facebook credentials.

Enable the appropriate Meta products, approved permissions/access level, test roles, redirect URLs, privacy policy and data deletion requirements before inviting real users. Test each flow with an eligible owner/test account. No Facebook/Instagram password or verification code is sent to this backend. Meta may request verification or revoke access; this app cannot prevent suspensions or bypass challenges.

OAuth state is random, hashed, expires after ten minutes and is tied to the signed-in owner session. An atomic pending-to-processing claim prevents a concurrent or refreshed callback from exchanging the code twice. Completion/cancellation/failure redirect to a clean dashboard URL. If the process fails after an exchange, start a fresh authorization instead of reusing the old callback URL.

Direct Instagram token refresh is attempted before account use when expiry is within seven days and the token is over 24 hours old. Expired/revoked tokens require fresh authorization. Facebook Page expiry is left unknown rather than inferred from a different token. A refresh endpoint is available for signed-in owner use. Scheduled batches are processed by a lightweight poller in the web process; this is not a separate always-on worker. A sleeping free service can delay scheduled posts and cannot guarantee exact delivery times. Use an approved always-on worker before promising unattended, time-exact publishing.

## Dashboard and publishing

Open `/`, sign in with the private dashboard password, then use a configured official connect button. The account list, composer and history work on mobile; `/studio` opens the same dashboard. Bulk mode accepts 1–10 MP4/MOV files from the phone at once, applies one shared caption, and queues them 10, 15 or 30 minutes apart. Each file is limited to 50 MB and active uploaded video storage to 500 MB. Keep the dashboard open while uploading. The first Reel is queued immediately; after a Reel finishes, the next one is scheduled for the selected interval later. If a Reel definitively fails, the batch pauses so the owner can inspect it before continuing. A result that is uncertain is never automatically retried. Single-post mode also accepts public HTTPS media URLs; the backend never fetches arbitrary URLs itself. It rejects local names, literal IP addresses, credentials, non-HTTPS and unusual ports; this is not a DNS-based guarantee that any hostname is public. Meta must be able to retrieve and validate linked media.

Use a compatible JPEG for photos and a compatible Reel video. Select the account, review the caption and confirm publishing. Request creation saves a receipt before any Meta write. The dashboard then checks the container and finishes publishing once ready, with checks at least 60 seconds apart and a limited number of automatic checks while the page remains open. After closing/reloading the page, use **Check & finish publishing** from history to resume.

Every create request requires a UUIDv4 `Idempotency-Key`. Retry the same request with the **same key and unchanged details**. A different payload with the same key returns 409. A new key is a new operation and may create duplicate content. The UI retains a bounded history of request fingerprints/keys in browser storage, without tokens, captions or media URLs. Same details reuse their prior receipt; intentional repost controls are not implemented. Do not clear storage merely to recover a failed response.

A timeout, invalid success response or lost database write can leave an `unknown` result. Publishing intent is stored before sending the final API call. Later checks only inspect that same container; they do not automatically send the publish call again. `PUBLISHED` recovers the status without inventing a published media ID. If the result remains uncertain, check the actual Instagram account before any new request. This avoids blind retries, not every possible duplicate across distinct requests/devices.

Disconnect removes that saved connection/token, retains publishing history, and prevents later unfinished jobs using it. It does not cancel a Meta API request already in flight or revoke the app permission at Meta. Remove permission in Meta account settings when full revocation is required.

## API

All account/job routes require the owner session cookie. All writes require an exact canonical `Origin` and host. Public API keys, arbitrary access-token request bodies and anonymous publishing are not supported.

| Route | Behavior |
| --- | --- |
| `GET /health`, `GET /ready` | Liveness / actual configuration and database readiness |
| `GET /api/session` | Dashboard sign-in and provider availability |
| `POST /auth/login`, `POST /auth/logout` | Owner session login/logout |
| `GET /auth/meta/start` | Facebook authorization |
| `GET /auth/meta/login` | Compatibility redirect to the correct start route |
| `GET /auth/instagram/start` | Direct Instagram authorization |
| `GET /auth/meta/callback` | State-bound callback |
| `GET /api/accounts` | Safe connection metadata, never tokens |
| `DELETE /api/accounts/:connectionId` | Remove one connection by database connection ID |
| `POST /api/accounts/:connectionId/refresh` | Refresh if eligible; report reconnect requirement |
| `POST /api/publish/image`, `POST /api/publish/reels` | Create idempotent publishing receipt/container |
| `POST /api/assets` | Upload one private MP4/MOV file (up to 50 MB) |
| `POST /api/batches` | Queue 1–10 uploaded files with a shared caption and 10/15/30-minute interval |
| `POST /api/batches/:id/resume` | Continue after a definitively failed Reel |
| `GET /api/jobs` | Latest 100 receipts, including batch progress |
| `POST /api/jobs/:jobId/publish` | Check and finish an existing request, or recover status |

Example photo body (also send the idempotency header):

```json
{
  "connection_id": "DATABASE_CONNECTION_ID_FROM_ACCOUNT_LIST",
  "image_url": "https://your-cdn.example/photo.jpg",
  "caption": "Post caption"
}
```

For reels use `video_url`. Use the returned `job.id` to check/finish publishing. The previous unshipped `/api/publish/reels/:creationId/publish` route is replaced by the job route. Account selection/removal now uses `connection_id`, so connecting the same Instagram identity by two providers is unambiguous.

## Operational boundaries

- HTTPS-only production cookies: HttpOnly, SameSite=Lax, opaque random sessions stored hashed. Exact origin checks protect writes; strict CSP and no-referrer headers protect the dashboard/callback.
- Meta requests have timeouts, reject redirects and use approved hosts. Normal Graph calls use bearer headers. Meta token exchanges/refresh may require secrets in query parameters; application logs never print request URLs or raw provider messages. Ensure proxy/error monitoring also redacts OAuth query strings and credentials.
- Login and API limits are in-process and bounded. Persistent SQL claims protect publishing across instances, but distributed abuse protection is a separate production requirement before public scale.
- No real post is created by automated tests. A live smoke test needs explicit owner approval of the exact account/media/caption.
- Resolve Chrome's reported Dangerous site warning through security investigation and, where applicable, Google Search Console review. Never instruct users to bypass it. Code tests or a green `/health` response do not establish Safe Browsing clearance.

Primary references: [Instagram overview](https://developers.facebook.com/documentation/instagram-platform/overview), [Content publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing), [Business Login for Instagram](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login), [Meta official Instagram Postman collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api).
