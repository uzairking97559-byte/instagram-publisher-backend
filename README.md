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

New tables are named `publisher_sessions`, `publisher_oauth_attempts`, `publisher_accounts`, `publisher_jobs`, `publisher_batches`, and `publisher_media_assets`. Accounts belong to the private workspace, not a browser session, so sign-out and session expiry do not delete them. Tokens use AES-256-GCM authenticated with provider/account identity. Uploaded videos are stored in Postgres as short-lived private assets. A video is deleted as soon as its Reel is published or has definitively failed; videos of queued, in-flight or uncertain Reels are kept (up to 7 days once in a batch), and uploads never added to a batch expire after 3 hours. Activity keeps each Reel's file name after its video is deleted. Meta downloads them from a signed `/media/...` URL that reads the video in 1 MB slices (with HTTP Range support); HEAD reads no video bytes. Selecting a whole 20 MB video in one query uses over 100 MB of Postgres memory, which repeatedly restarted a 256 MB database instance.

The older PR prototype used `connected_accounts` tied to anonymous sessions. If that table contains data, initialization **stops** for an owner-reviewed migration; this version does not drop, delete, or silently adopt it. Do not point an unrelated app at this database. Back up the database and encryption key before production changes. Job idempotency records are retained; deleting them removes retry protection for those requests.

## Meta authorization

Configure the exact `REDIRECT_URI` in each enabled login product. Facebook and direct Instagram use the same callback route but different app credentials and state-bound providers.

- **Facebook Login**: `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`. Discovers eligible professional accounts linked to accessible Facebook Pages, including paginated Page lists. Authorizing one Facebook user only grants accounts they can actually manage; it cannot sign in arbitrary accounts.
- **Instagram Login**: `instagram_business_basic`, `instagram_business_content_publish`. Direct professional-account authorization does not use Facebook Page discovery. Each account must authorize the app through the official flow. Configure the Instagram credentials from the Instagram API setup, not by copying the Facebook credentials.

Enable the appropriate Meta products, approved permissions/access level, test roles, redirect URLs, privacy policy and data deletion requirements before inviting real users. Test each flow with an eligible owner/test account. No Facebook/Instagram password or verification code is sent to this backend. Meta may request verification or revoke access; this app cannot prevent suspensions or bypass challenges.

OAuth state is random, hashed, expires after ten minutes and is tied to the signed-in owner session. An atomic pending-to-processing claim prevents a concurrent or refreshed callback from exchanging the code twice. Completion/cancellation/failure redirect to a clean dashboard URL. If the process fails after an exchange, start a fresh authorization instead of reusing the old callback URL.

Direct Instagram token refresh is attempted before account use when expiry is within seven days and the token is over 24 hours old. Expired/revoked tokens require fresh authorization. Facebook Page expiry is left unknown rather than inferred from a different token. A refresh endpoint is available for signed-in owner use. Scheduled batches are processed by a lightweight poller in the web process; this is not a separate always-on worker. A sleeping free service can delay scheduled posts and cannot guarantee exact delivery times. Use an approved always-on worker before promising unattended, time-exact publishing.

## Dashboard and publishing

Open `/`, sign in with the private dashboard password, then use a configured official connect button. The dashboard is built for the phone: an account switcher at the top (all accounts, or one) drives every tab — Accounts shows a compact list or that account's card, Create post defaults to it, and Activity shows only its history — and the Accounts, Create post and Activity tabs each show one view at a time. The picked account and tab are remembered in the browser. `/studio` opens the same dashboard. Bulk mode accepts 1–20 MP4/MOV files from the phone at once, applies one shared caption, and queues them 5, 10, 15, 20, 30, 45 or 60 minutes apart. Each file is limited to 250 MB. Files up to 45 MB go in one request; larger ones are sent in 4 MB parts that are stored one row per part, so neither the upload nor Meta's ranged reads load a whole video, and an interrupted upload resends only the missing parts. Videos kept at once (queued Reels plus uploads not yet in a batch) are limited to `MEDIA_STORAGE_LIMIT_MB` (default 500 MB); keep it well below the Postgres disk size, because Render suspends a database that runs out of storage. The dashboard shows used and free space and checks it before uploading. Account cards show a post target (200 by default), posts previously counted by the owner, and live counts of published, scheduled, failed and uncertain requests. Activity shows individual Reel statuses and times. Keep the dashboard open while uploading. The first Reel is queued immediately; after a Reel finishes, the next one is scheduled for the selected interval later. If a Reel definitively fails, the batch pauses so the owner can inspect it before continuing. A result that is uncertain is never automatically retried. Accounts are independent: each uses its own saved connection, so an account that stops working (for example a suspended or disconnected one) only stops its own batches. A Reel whose account cannot be reached is failed once Meta's 24-hour container limit has passed, and a batch still paused when its videos expire (7 days after it was created) closes on its own, so its videos stop taking up the storage all accounts share. Single-post mode also accepts public HTTPS media URLs; the backend never fetches arbitrary URLs itself. It rejects local names, literal IP addresses, credentials, non-HTTPS and unusual ports; this is not a DNS-based guarantee that any hostname is public. Meta must be able to retrieve and validate linked media.

Use a compatible JPEG for photos and a compatible Reel video. Select the account, review the caption and confirm publishing. Request creation saves a receipt before any Meta write. The dashboard then checks the container and finishes publishing once ready, with checks at least 60 seconds apart and a limited number of automatic checks while the page remains open. After closing/reloading the page, use **Check & finish publishing** from history to resume.

Every create request requires a UUIDv4 `Idempotency-Key`. Retry the same request with the **same key and unchanged details**. A different payload with the same key returns 409. A new key is a new operation and may create duplicate content. The UI retains a bounded history of request fingerprints/keys in browser storage, without tokens, captions or media URLs. Same details reuse their prior receipt; intentional repost controls are not implemented. Do not clear storage merely to recover a failed response.

A timeout, invalid success response or lost database write can leave an `unknown` result. Publishing intent is stored before sending the final API call. Later checks only inspect that same container; they do not automatically send the publish call again. `PUBLISHED` recovers the status without inventing a published media ID. If the result remains uncertain, check the actual Instagram account before any new request. This avoids blind retries, not every possible duplicate across distinct requests/devices.

Disconnect removes that saved connection/token, retains publishing history, and cancels that account's unfinished batches (their videos are then deleted); a Reel already being published still finishes. It does not cancel a Meta API request already in flight or revoke the app permission at Meta. Remove permission in Meta account settings when full revocation is required.

## Reel frame

Bulk mode has a **Frame lagao** switch. A framed Reel is shown in a centred square box (25–80% of the width, 60% by default) on a textured background, with a single line of text just above it, the account's username below it and a picture at the bottom. Each account has its own look under Accounts → account → **Frame ka look**: a background colour (each account gets a different one by default) or an uploaded photo, the box size, the bottom picture (the bundled default, an uploaded one, or none), whether to show the username, whether the switch starts on, and a list of top lines. A batch can give its own top line; otherwise one is picked at random from the account's lines, or from the built-in Hinglish lines. The bundled Lora font draws Latin text only, so emoji and other scripts are removed from the line.

Each account can also keep a **default caption** (on its card, or saved from Create post). Picking the account in Create post fills it in; editing it there changes only that batch until it is saved as the new default.

Uploading is unchanged. A background worker in the web process frames queued Reels one at a time, in the order they are due, with ffmpeg (`lib/frame.js`), and replaces the stored video with the 1080×1920 H.264 result. The scheduler does not start a framed Reel until its frame is done. A render that fails is tried once more; after that, or if ffmpeg is missing, the original video is posted and Activity says so. A render cut off by a restart starts again. Rendering a 30-second Reel takes roughly a minute on half a CPU and about 180 MB of memory (encoder settings in `lib/frame.js`), so one render at a time fits a 512 MB instance.

`npm install` runs `scripts/install-ffmpeg.js`, which downloads a pinned static ffmpeg 6.0 build for linux-x64 into `bin/` and checks its SHA-256. If it cannot (another platform, no network), framing is unavailable but nothing else is affected. Set `FFMPEG_PATH` to use an installed ffmpeg, or `SKIP_FFMPEG_DOWNLOAD=1` to skip the download. Fonts are Lora (SIL Open Font License, `assets/frame/fonts/OFL.txt`).

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
| `POST /api/assets/uploads`, `PUT .../uploads/:id/parts/:n`, `POST .../uploads/:id/complete` | Upload one MP4/MOV file of up to 250 MB in 4 MB parts; starting again with the same idempotency key resumes |
| `POST /api/batches` | Queue 1–20 uploaded files with a shared caption and a 5/10/15/20/30/45/60-minute interval; optional `frame: true` and `frame_title` |
| `GET`/`PUT /api/accounts/:connectionId/frame` | Read or change an account's frame look and default caption |
| `PUT`/`DELETE /api/accounts/:connectionId/frame/background`, `.../frame/art` | Upload (JPEG/PNG/WEBP, up to 5 MB) or remove the account's background or bottom picture |
| `GET /api/accounts/:connectionId/frame/preview` | PNG preview of the account's look |
| `POST /api/batches/:id/resume` | Continue after a definitively failed Reel |
| `POST /api/batches/:id/cancel` | Cancel every Reel of a batch not yet sent for publishing |
| `GET /api/storage` | Video storage used, free and allowed |
| `GET /api/progress` | Per-account target and complete publishing-state counts |
| `PUT /api/accounts/:connectionId/progress` | Save a post target and the owner's pre-existing scheduled/published count |
| `GET /api/jobs` | Latest 500 receipts, including batch progress; `?connection_id=` limits them to one account |
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
