# Creator Publishing Tool

An existing Node.js / Express Instagram Publisher backend, with a private mobile dashboard and official Meta authorization. This is a **single-owner workspace**, not a public multi-tenant SaaS. Every person who knows the dashboard password can manage every connected account. Do not share that password with clients.

The website has three parts: **Posting** (accounts, new post, Activity), **Messages** (Replies, DM campaigns, new campaign) and **Creators** (Joined, Finder, List check). Every change goes through a pull request with CI and is deployed to Render from `main`. `CLAUDE.md` has the short version for coding agents.

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

## DM Sender

**Messages → Campaigns** sends one message to Instagram creators who asked for promotion details (for example by commenting on a Reel), from the owner's own Instagram account. It does not use the Meta API: the account stays logged in inside a [Browser Use](https://browser-use.com) cloud browser profile, and the server drives that browser over the Chrome DevTools Protocol with fixed steps (`lib/instagram-dm.js`, no AI model per message). Images, video and fonts are not downloaded, and one browser is reused for many messages, to keep proxy data small.

- A **campaign** has a name, a Browser Use profile (one Instagram account), the message (up to 1,000 characters per version; several versions can be separated by a line with `---`, one is picked per DM, and `{username}` becomes the creator's username), a list of up to 2,000 usernames or profile links, a daily limit (1–200, default 100), a gap between messages (2–60 minutes, default 9; each gap differs, from 0.4× to 1.6× of it — e.g. 4, 13, 7, 14 minutes for 9 — averaging the set gap) and the hours to send in, India time (default 08:00–23:00). The owner must confirm that the people on the list asked to be contacted.
- A campaign that is not running can be moved to another account (Browser Use profile) from its settings; the list stays, people already messaged are still skipped, and the new account's warm-up applies. Profiles used by the creator finder can't be picked.
- Nobody gets the message twice: a username already messaged from any campaign is skipped, and before typing, the chat is checked for any version of the message.
- Messages are sent from the Direct inbox (New message → search → Chat), so Instagram's page loads once per browser (~4.7 MB) and each later DM uses ~50 KB; when the inbox doesn't work the driver opens the profile instead (`DM_SEND_METHOD=profile` always does). A username is skipped as "not found" only when Instagram's search answers (other names, or "no results"); a search that shows nothing at all counts as a failed DM (`search_empty`), so three in a row pause the campaign and "Failed wale dobara list mein" puts them back. A search that answers "Something went wrong. Try again later." is Instagram limiting the account: the campaign pauses at once (`action_blocked`, warm-up restarts). A skipped name is followed 15 s later by the next one, but after three skips in a row the next DM waits a normal gap, so renamed accounts never turn into a burst of searches. When Instagram shows its "can't receive your message" notice, the DM counts as sent for pacing but is marked not delivered.
- **Warm-up** (on by default): an account sends at most 20 DMs a day in its first week of DMs, +10 each week, up to the campaign's limit; after an Instagram warning or security check it starts again at 10.
- **Start** can stop after a number of messages (the form suggests a 5-message test first). Any Instagram warning ("Try again later", restricted), logout or security check pauses the campaign and closes the browser; so do three failures in a row, a rejected key or no credits. The owner checks Instagram and starts again. One account runs one campaign at a time.
- The worker runs every 15 seconds in the web process. A database lease keeps two copies of the service (for example during a deploy) from sending at once; on start-up, browsers left open by an earlier run are stopped (which also saves the profile's login) and a message cut off by the restart is tried again (the chat check prevents a repeat).
- Each card shows the cost in rupees (Browser Use browser time and proxy data, converted at `DM_USD_INR`, default 96.5) and the cost per message.
- **Hisaab** (on the Campaigns page, for today, 7 days, 30 days or everything): per account, DMs that reached people, not delivered, how many of those people replied (reply rate), the account's browser cost and the cost per reply; and per message version, how many it went to and how many replied, so a weak version can be dropped. Each DM records the version and the account it was sent from (DMs from before this have no version).

Set `BROWSER_USE_API_KEY` in the service's environment (never in code or chat). Without it the tab still saves campaigns but cannot start them. Each campaign picks its connection: Browser Use's residential proxy in India (the default, or `DM_PROXY_COUNTRY`; it should match the country the profile logged in from), or **no proxy**. Proxy data is billed per GB and an Instagram profile page is a few MB, so most of the cost is proxy data; without a proxy only browser time is billed, but Instagram sees the login from another country and may ask for a security check (the campaign then pauses). `npm test` runs the driver against a fake Instagram page only when `DM_TEST_CHROME` points to a Chrome/Chromium binary.

Sending messages through the website instead of the official API is outside Meta's platform terms, and messages to people who do not follow the account land in their message requests. Keep the pace low and stop when Instagram warns.

### Replies and the Telegram bot

**Messages → Replies** lists, per Instagram account, the chats where the other person wrote last, with their message. While a campaign's browser is open its inbox is read every 30 minutes, and once more before the browser closes; **Abhi check karo** opens a browser just for that (it closes 10 minutes after its last job, so answers typed one after another share it). Between a campaign's DMs the browser stays open for any wait under an hour, since reloading Instagram over the India proxy costs about as much as an hour of open browser. Each account that sent DMs in the last 3 days is also read once at 16:00, 19:00 and 22:00 India time (within the hour; `DM_CHECK_HOURS`, e.g. `16,19,22` or `none`), unless Instagram logged it out or stopped it. A logout, security check or warning seen while reading is reported as such and pauses the account's campaigns; when Instagram sends the browser away from the inbox (for example to its home page with "Continue as …"), that counts as a logout, not an empty inbox. An answer typed under a reply is sent from the same account by the worker (tried up to 3 times, never twice if it is already in the chat). Saved answers (up to 8, `{username}` allowed) appear as one-tap buttons.

With `TELEGRAM_BOT_TOKEN` (and optionally `TELEGRAM_BOT_USERNAME`) set, the Replies page shows **Telegram jodo**: a one-time link (15 minutes) connects the owner's private chat. The bot then posts each new reply with buttons for saved answers; replying to that message sends the answer. Commands: `/menu`, `/replies`, `/check`, `/aaj`, `/kal`, `/campaigns`, `/jawab`. It also alerts when a campaign or finder search pauses or finishes, when a creator sends a WhatsApp number or Telegram ID (with WhatsApp/Telegram buttons), sends a short summary at 22:00 India time, and at 09:00 a report of the day before (DMs, replies, answers, cost and cost per reply, each account, the best message version, Instagram warnings, stopped campaigns, the finder and the Joined list), skipped when nothing happened; `/kal` shows it any time. Telegram calls the website at `/telegram/webhook`, checked with a secret header derived from the token.

## Joined creators

**Creators → Joined** keeps the creators who answered a DM with a way to reach them. Every new or changed reply is scanned (`lib/leads.js`): an Indian mobile number (10 digits from 6–9, with or without +91/0, spaces or dashes, or a `wa.me` link) and a Telegram ID (a `t.me` link, "Telegram … @name", "Telegram id: name", or a line that is only `@name`) make or complete that creator's entry, and the Telegram bot announces it. Replies without one get a **Joined mein daalo** button, and anyone can be added by hand. Each entry links to the Instagram profile, WhatsApp (`wa.me`) and Telegram, and moves through Naya → Baat hui → Logo bheja → Kaam shuru (or Mana), with a note. Counts per status, today's new ones, a status filter and **Report copy karo** (a short summary for the brand) sit on top.

**Purane creators ek saath daalo** takes a pasted list from the phone, one creator per line in any order: a name and a number, an Instagram link or `@username` (`@name` means the Instagram page here), and optionally a `t.me` link; up to 2,000 lines. A creator already listed (same username, else same number) is only completed, never duplicated. Every entry can carry **Kaun laya** (the manager or creator who brought it); the Kaun laya panel counts pages and working pages per name (case does not matter) with the referral amount due at each page's first payment, and tapping a name shows only their pages. The **Target** box (default 50, with an optional date) shows how many have started work, days left in India time and how many a day are still needed; the morning Telegram report adds the target once it is set.

## Workwithme bot (creators)

With `WORKWITHME_BOT_TOKEN` set (and optionally `WORKWITHME_BOT_USERNAME`), a second Telegram bot talks to creators (`lib/creator-bot.js`, webhook `/telegram/workwithme`, checked with a secret header derived from its token). Every message reads as the bot's own.

1. **Start** shows the offer and a menu (Kaam shuru karo, Payment kab?, Rules, Manager bano, Support). Support opens the owner's Telegram username set on the website. A guide video, if set, is sent first.
2. **Kaam shuru karo** asks for the Instagram profile link (a link, not a username). The page is matched with Creators → Joined or added there (source `bot`, status Logo bheja, Telegram username, and the manager as Kaun laya when the creator came through a manager's link). A page already tied to another Telegram account is refused. The creator then gets the logo, the rules and, once, the note for the first Reel (bio link or hashtag).
3. **The first Reel's link** goes to the owner's own bot with **Approve** / **Reject** (also on the website, Creators → Joined → Workwithme bot). Approval sets the page to Kaam shuru and asks for a UPI ID for the advance; rejection asks for a new Reel.
4. After approval every Reel link is taken (reel, reels, p or tv links), each link once by anyone, with no daily limit; the creator sees today's, this week's (from Monday, India time) and total count. A UPI ID sent later replaces the old one.
5. **Manager bano** gives a link `t.me/<bot>?start=m_<code>`; pages that join through it carry the manager's name and code as Kaun laya, and the manager sees how many of his pages joined and started.

The owner's Telegram account (the chat linked to his own bot) sends the bot the logo (a photo or file with caption `/logo`) and the guide video (caption `/video`). The website card shows the bot's state, counts, first Reels waiting for approval, and the support username, rules and first-Reel note.

## Creator finder

**Creators → Finder** finds new creators without messaging anyone. A search has seed usernames (up to 50), follower range, how recent the last post must be, how deep to follow "Similar accounts" (1–3 levels), a daily limit (10–300), a gap between profiles (30–600 s, ±30%), hours (India time), proxy and warm-up. It reads each profile through Instagram's web JSON inside one open Instagram page (`lib/instagram-finder.js`: followers, following, posts, private, category, bio, newest post, average views, similar accounts), falling back to the profile page and its Similar accounts button. Seeds and profiles that fit are followed one level deeper; the queue reads the most-mentioned accounts first. A profile read by any search in the last 14 days is copied instead of read again.

It uses its own Browser Use profile with a separate Instagram login: a profile used by DM campaigns cannot run searches, and a finder profile cannot start DM campaigns. Warm-up allows 50 profiles a day in the first week, +50 a week (25 after an Instagram warning). Logout, security check or rate limit pause the search. Results can be filtered (fit, approved, not fit, queue), marked ✓/✕, and the approved or fitting usernames copied.

## Creator list check

**Creators → List check** takes a pasted list or a .txt/.csv file of usernames or profile links (when links are present, only the links count, so a sheet's name column is ignored) and checks each one through Instagram's Business Discovery API: whether it is still a professional account, its followers and when it last posted. Results are split into active (a post within the chosen number of days, default 30), old, and not found (renamed, deleted or no longer professional). The active ones, biggest first, can be copied or put straight into a new DM campaign.

It needs one account connected through **Facebook Login with the extra `instagram_manage_insights` permission** (the "Facebook se permission do" link, `/auth/meta/start?extra=insights`); normal connections do not ask for it. The background worker checks one username every 20 seconds (`CHECK_INTERVAL_SECONDS`), about 180 an hour, waits 30 minutes when Instagram reports its rate limit, and pauses when the connection expires or the permission is missing.

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
| `GET /api/dm` | DM Sender status (key set or not) and every campaign with counts and cost |
| `GET /api/dm/profiles` | Browser Use profiles to send from; a profile renamed in Browser Use also gets its new name on saved campaigns and finder runs (`renamed` counts them) |
| `POST /api/dm/campaigns` | Create a campaign (paused) from settings and pasted usernames; needs `requested_contact: true` |
| `GET`/`PUT`/`DELETE /api/dm/campaigns/:id` | A campaign with its list; change settings or delete while it is not running |
| `POST /api/dm/campaigns/:id/targets` | Add usernames to a campaign |
| `GET`/`POST /api/checks`, `GET /api/checks/:id[?filter=]`, `GET .../usernames`, `POST .../pause\|start`, `DELETE /api/checks/:id` | Creator list check: create, results (active/old/not_found/pending/error), usernames, pause/start, delete |
| `POST /api/dm/campaigns/:id/start`, `.../pause`, `.../retry-failed` | Start (optional `stop_after`), pause, or put failed usernames back in the list |
| `GET /api/dm/stats?period=1\|7\|30\|all` | Hisaab: totals, per account and per message version |
| `GET /api/dm/replies`, `POST /api/dm/replies/check`, `POST /api/dm/replies/:id/answer`, `POST /api/dm/replies/:id/done` | Replies per account, ask for an inbox check, queue an answer, mark a reply done |
| `GET`/`POST /api/dm/templates`, `DELETE /api/dm/templates/:id` | Saved answers |
| `GET /api/telegram`, `POST /api/telegram/link`, `DELETE /api/telegram`; `POST /telegram/webhook` | Telegram bot status, one-time link, unlink; Telegram's webhook (secret header, no session) |
| `GET /api/leads[?status=&referrer=]`, `POST /api/leads`, `PUT`/`DELETE /api/leads/:id` | Joined creators with counts, the Kaun laya summary and the target; add (`username`, `name`, `phone`, `telegram`, `referrer`, or `reply_id` from a reply; at least a username, number or Telegram ID); change `status` (new/talking/logo_sent/working/declined), `username`, `name`, `phone`, `telegram`, `referrer`, `note`; remove |
| `GET`/`PUT /api/creator-bot`, `POST /api/creator-bot/reels/:id/review`; `POST /telegram/workwithme` | Workwithme bot: state, counts, first Reels waiting; save `support_username`, `rules`, `first_reel_note`; approve or reject a first Reel (`approve: true/false`); Telegram's webhook (secret header, no session) |
| `POST /api/leads/import`, `PUT /api/leads/target` | Paste old creators (`text`, one per line, optional `referrer`); set the target (`target`, optional `deadline` YYYY-MM-DD) |
| `GET`/`POST /api/finder`, `GET`/`PUT`/`DELETE /api/finder/:id[?filter=]`, `POST .../seeds\|start\|pause\|review`, `GET .../usernames` | Creator finder: searches, results (match/approved/rejected/other/queue/missing/all), seeds, start (optional `stop_after`), pause, ✓/✕, usernames to copy |

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
