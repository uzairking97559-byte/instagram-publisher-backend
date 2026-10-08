# Instagram Publisher Backend

Starter Node/Express backend for Instagram API authorization and image publishing.

## Run locally

1. Install Node.js 18+.
2. Copy `.env.example` to `.env`.
3. Fill in:
   - META_APP_ID
   - META_APP_SECRET
   - REDIRECT_URI
4. Run:
   npm install
   npm start

## Important

For Meta OAuth, `REDIRECT_URI` must exactly match a URL configured in the Meta app.

When hosted, use an HTTPS callback such as:
`https://YOUR-SERVICE.onrender.com/auth/meta/callback`

Do not share your Meta App Secret or access tokens.

This starter currently includes image publishing. Reels/carousels can be added after the basic OAuth flow is working.
