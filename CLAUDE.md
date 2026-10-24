# CLAUDE.md — Creator Publishing Tool (instagram-publisher-backend)

This repository is public. Never commit secrets, passwords, tokens, cookies, account
logins or private business notes here.

## The owner and how to work with him

- One owner runs everything. He writes in **Hinglish** (Hindi in Roman script): reply in
  short, simple Hinglish, and keep website text (public/) in Hinglish too.
- He does not write code. Do the technical work end to end (branch → PR → CI → merge →
  Render deploy → check logs) and only tell him the steps that need him (logging in,
  OTPs, approvals, clicks in a dashboard), one short step at a time.
- Always show money in **₹** (convert USD with `DM_USD_INR`, default 96.5).
- **Never ask for** passwords, OTPs, API keys, bot tokens or session cookies in chat.
  Secrets live only in Render → service → Environment. The dashboard password is his alone.
- Ask before anything that costs money (starting Browser Use browsers), sends DMs,
  publishes a real post, or cannot be undone (deleting data, Browser Use profiles).

## What the app is

A single-owner dashboard (Node.js ≥ 22, Express, PostgreSQL), deployed on Render. The
website has three parts (bottom bar on a phone, left rail on a computer):

1. **Posting** — connect Instagram professional accounts with the official Meta APIs
   (Facebook Login or Instagram Login), bulk-upload Reels from the phone, schedule them
   in batches with a gap, optional **Reel frame** (ffmpeg), per-account look and default
   caption, post targets and Activity.
2. **Messages** — **DM Sender**: campaigns that DM creators who asked for promotion
   details (they commented on the owner's Reels), from an Instagram login kept in a
   **Browser Use** cloud browser profile, driven over the Chrome DevTools Protocol with
   fixed steps (no AI model per message). **Replies** per account, answers typed on the
   website, saved answers, **Hisaab** (per account and per message version: reach, replies,
   ₹ per reply), and a **Telegram bot** that announces replies, sends the owner's answers
   and posts a morning report of the day before.
3. **Creators** — **Finder**: from seed creators, read each profile (followers, last post,
   average views) and Instagram's "Similar accounts" with a separate Instagram login, and
   keep a list to review and copy (nobody is messaged). **List check**: which usernames
   still exist and post recently, through Business Discovery (needs a Facebook Login
   connection with `instagram_manage_insights`).

README.md describes each feature and the API in detail; keep it in sync when behaviour changes.

## Code map

| Path | What it is |
| --- | --- |
| `server.js` | Starts the app, retries the database, graceful shutdown |
| `lib/app.js` | Express app: security headers, owner session, every route, background worker timers |
| `lib/database.js`, `schema.sql` | Postgres pool; `schema.sql` runs at every start, so it must stay idempotent (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS`) |
| `lib/security.js` | Password check, AES-256-GCM token encryption, ids, rate limits |
| `lib/meta.js`, `lib/publishing.js` | Meta Graph client; OAuth, accounts, uploads, batches, publishing scheduler |
| `lib/media.js`, `lib/frame.js`, `lib/frames.js` | Video storage in Postgres (1 MB slices, Range), Reel frame rendering and its worker |
| `lib/browser-use.js` | Browser Use Cloud REST v4 client (start/stop browser, profiles, cost) |
| `lib/cdp.js` | Tiny DevTools client; `openPage` blocks images/media/fonts and counts bytes |
| `lib/instagram-dm.js` | DM driver: send from the Direct inbox (profile fallback), read replies, send answers |
| `lib/dm.js` | DM worker: campaigns, pacing, warm-up, replies/outbox, costs, owner API |
| `lib/telegram.js` | Telegram bot: webhook, link code, menu, replies → bot, answers ← bot, alerts, digest |
| `lib/instagram-finder.js`, `lib/finder.js` | Finder driver (web app JSON, page fallback) and worker/API |
| `lib/checks.js` | Creator list check (Business Discovery) |
| `public/` | The website: `index.html`, `app.js`, `styles.css`, `about.html`, fonts. No build step |
| `test/` | `node:test` suites; `helpers.js` builds the app on PGlite with mocked outbound calls |

## Commands

```bash
npm ci          # also downloads a pinned ffmpeg into bin/ (linux-x64; skipped elsewhere)
npm test        # all tests, PGlite in memory, no real Instagram/Meta/Browser Use/Telegram calls
DM_TEST_CHROME=/path/to/chrome npm test   # also runs the real-Chrome driver tests
npm start
```

On Windows: `set DM_TEST_CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe`.
Without it the 6 Chrome tests are skipped (and the real ffmpeg render test where ffmpeg is
missing, e.g. on Windows). CI (GitHub Actions, Node 22 and 24) runs them with
`/usr/bin/google-chrome`; when CI fails, the job annotation shows the failing tests.

## Workflow

- Work on a branch from `main`, open a PR, wait for both CI jobs, then merge. Merging to
  `main` auto-deploys on Render in about a minute.
- After a deploy, check the Render logs: the app logs one JSON object per event, e.g.
  `{"event":"dm_sent","campaign":"5","kb":48}`, `finder_read`, `telegram_ready`,
  `database_not_ready`. Background workers hold a database lease, so after a deploy the new
  instance may wait up to ~3 minutes before the DM/finder workers start.
- The production database blocks external connections; read state through the website's
  API or the logs, not SQL.
- Keep changes small and focused; add or update tests with every behaviour change.

## Conventions

- Errors: throw `AppError(status, "snake_case_code")`; the website maps codes to Hinglish
  text (`messages`, `DM_PAUSES`, `FINDER_PAUSES`, … in `public/app.js`).
- Strict CSP: no inline scripts or styles, no CDNs; everything is served from `public/`.
  Build DOM with `element()` / `textContent`, never `innerHTML` with data.
- Functions passed to `page.evaluate(fn, …args)` run in the browser: only their own source
  is sent, so they must not use anything from Node or the surrounding module.
- Workers run inside the web process: frames 10 s, DM 15 s, Telegram 20 s, list check 5 s,
  finder 5 s. Each one is idempotent per tick and recovers rows cut off by a restart.
- Costs: Browser Use browser time ≈ $0.02/hour, residential proxy ≈ ₹480/GB; the first
  Instagram page in a browser is ~4.7 MB, later DMs ~50 KB each.
- Timezone for hours, "today" and daily limits is India (IST, UTC+5:30).

## Safety rules for the Instagram automation (keep them unless the owner decides otherwise)

- DM only creators who asked to be contacted; never message anyone twice (checked across
  campaigns and in the chat itself); slow pace with random gaps, daily limits, warm-up.
- Any Instagram warning, logout, security check or rate limit **pauses** the campaign or
  search and closes the browser; the owner checks Instagram and starts it again.
- One Browser Use profile = one Instagram account. A DM profile can't run finder searches
  and a finder profile can't run DM campaigns (enforced in code). Never clear or delete a
  profile without the owner.
- Do not create Instagram accounts, solve captchas, bypass Instagram security checks, fake
  human activity, or help an account avoid being linked to suspended ones.
- Current state (24 Oct 2026): the first DM account had an Instagram "Confirm you're human"
  check (cleared by the owner) and its Browser Use login expired. DMs now go from a second,
  older account in its own profile ("DM 2"), starting with a 5-DM test, ~20/day, 12-minute
  gap, India proxy. Add more accounts one at a time, each after its own clean test. The
  finder has not run yet; its first run is a 50-profile test.

## Environment variables (names only — values are set in Render)

`DATABASE_URL`, `PGSSL`, `TOKEN_ENCRYPTION_KEY`, `DASHBOARD_PASSWORD`, `REDIRECT_URI`,
`META_APP_ID`, `META_APP_SECRET`, `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`,
`META_GRAPH_VERSION`, `MEDIA_STORAGE_LIMIT_MB`, `FFMPEG_PATH`, `SKIP_FFMPEG_DOWNLOAD`,
`BROWSER_USE_API_KEY`, `DM_PROXY_COUNTRY`, `DM_USD_INR`, `DM_SEND_METHOD` (`profile` to send
from profile pages instead of the inbox), `CHECK_INTERVAL_SECONDS`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_BOT_USERNAME`, `NODE_ENV`, `PORT`, `RENDER`.
