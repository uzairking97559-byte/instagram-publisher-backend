# Instagram Publisher

Node.js and Express backend with a small account dashboard for official Instagram publishing.

## Requirements

- Node.js 18 or later
- A Meta developer app configured for Facebook Login and/or Instagram Login
- A persistent PostgreSQL database
- An HTTPS media URL that Meta can fetch for every image or video being published

The service deliberately disables OAuth and publishing until PostgreSQL and token encryption are configured. The health route stays available and reports `secureStorageReady: false` when storage is missing.

## Configure locally

1. Copy `.env.example` to `.env`.
2. Add the Meta app ID and secret and make `REDIRECT_URI` match the callback configured in Meta.
3. Set `DATABASE_URL` to a PostgreSQL connection string.
4. Generate a base64 encryption key locally. For example, run `node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))"` and put the output in `TOKEN_ENCRYPTION_KEY`. Do not commit or share the key.
5. Install dependencies with `npm install`, then run `npm start`.

On first startup, the service creates its required PostgreSQL tables. Keep the encryption key stable: replacing it makes previously stored tokens unreadable.

## Meta app setup

Configure the exact callback URI:

`https://YOUR-SERVICE.onrender.com/auth/meta/callback`

Enable the relevant official API products and permissions:

- Facebook Login: `instagram_basic`, `instagram_content_publish`, `pages_show_list`, and `pages_read_engagement`. The Instagram professional account must be linked to a Facebook Page accessible to the authorizing user.
- Instagram Login: `instagram_business_basic` and `instagram_business_content_publish`. This is the direct Instagram sign-in flow and does not require the Facebook Page route.

The Meta app must have the products and permissions enabled for the intended testers or approved users. Graph API version defaults to `v24.0` and can be changed with `META_GRAPH_VERSION`.

## Routes

- `GET /health` — health status and whether secure storage is ready.
- `GET /` — account connection dashboard.
- `GET /auth/meta/start` — start Facebook Login.
- `GET /auth/instagram/start` — start Instagram Login.
- `GET /auth/meta/callback` — shared OAuth callback; validates and consumes a one-time state value.
- `GET /api/accounts` — list accounts connected to the browser session. Tokens are never returned.
- `POST /auth/logout` — end the current browser session and remove its saved accounts.
- `POST /api/publish/image` — publish an image.
- `POST /api/publish/reels` — create a reel container; returns its `creation_id`.
- `POST /api/publish/reels/:creationId/publish` — check container processing and publish once it is ready.

Publishing requests use the dashboard's session cookie and must include the same-origin `Origin` header. Example image body:

```json
{
  "account_id": "CONNECTED_INSTAGRAM_ACCOUNT_ID",
  "image_url": "https://your-cdn.example/photo.jpg",
  "caption": "Post caption"
}
```

Example reel body:

```json
{
  "account_id": "CONNECTED_INSTAGRAM_ACCOUNT_ID",
  "video_url": "https://your-cdn.example/reel.mp4",
  "caption": "Reel caption"
}
```

The video URL must be publicly reachable by Meta while the container is processing. Poll the publish route with the returned `creation_id`; it responds with a processing status until Meta reports the container is ready.

## Security notes

- OAuth state is random, stored hashed in PostgreSQL, expires after ten minutes, and is consumed once. It is bound to the browser session.
- Session cookies are HTTP-only, SameSite=Lax, and Secure on Render.
- Access tokens are encrypted with AES-256-GCM before they are written to PostgreSQL.
- OAuth errors and access tokens are not written to application logs or returned to the dashboard.
- Do not expose `META_APP_SECRET`, `TOKEN_ENCRYPTION_KEY`, `DATABASE_URL`, or access tokens in chat, source control, or browser code.
