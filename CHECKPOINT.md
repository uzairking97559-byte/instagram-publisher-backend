# Instagram Publisher repair checkpoint — 9 October 2026 (IST)

## Scope and authorization

Continue the existing repository and PR #1 (`secure-oauth-review`). The review branch may be edited and tested. Do not merge, deploy production, create paid resources or publish a real Instagram post without the owner's specific approval. Never request passwords, OTPs, access tokens or card details in chat. Use official authorization and do not bypass browser warnings or Meta verification.

## Completed in this review revision

- Private owner authentication, opaque hashed sessions, password-change invalidation, exact-origin write protection and bounded request rates.
- Workspace-owned account records persist after logout/session expiry. Tokens use authenticated encryption bound to provider/account identity. Existing populated prototype tables trigger a migration block rather than silent takeover/deletion.
- Browser-bound OAuth attempts with an atomic claim, expiration, safe duplicate/cancel/error handling and clean callback redirects. Separate Facebook and Instagram product credentials. Facebook account discovery paginates trusted Graph endpoints.
- Persistent idempotency for photos and reels; processing checks and atomic publish claims. Ambiguous outcomes are retained for read-only recovery without blindly repeating a publish request. Reconnect/expiry handling and eligible Instagram token refresh before use.
- Mobile dashboard with account management, explicit publish confirmation, durable request history and safe text rendering. No local file uploader, scheduled publishing service or proactive unattended token-refresh worker is included.
- Database readiness, verified TLS by default, outbound request deadlines, sanitized errors/logging, reproducible dependency lockfile and setup/migration documentation.

## Verification completed

- `npm test`: **22 tests passed**, 0 failed. Express HTTP integration tests use PGlite, a local PostgreSQL engine; external Meta responses are mocked.
- Covered concurrent OAuth replay, 30-account paginated discovery, logout persistence, wrong-browser/expired/cancelled states, separate Instagram credentials, ciphertext tampering and account binding, large-ID precision, origin rejection, rate limiting, concurrent publishing, uncertain results, token refresh/revocation and a lost database write after Meta publishing.
- Headless Chromium: 390px mobile and 1365px desktop screenshots visually inspected. Owner sign-in, account list, mocked publish receipt and sign-out passed. No JavaScript page errors or mobile horizontal overflow. This was not a test on the owner's physical Android device or with real Meta authorization.
- `npm audit --omit=dev`: 0 reported production dependency vulnerabilities at the time of checking. This is not a security certification.
- JavaScript syntax checks and `git diff --check` passed.
- GitHub Actions passed on reviewed implementation head `1f155a06b57c8567fdb3e3bbb7466e46b2046c43` under Node 22.x and 24.x. Meta responses were mocked; no live Instagram account or post was tested. A checkpoint-only follow-up commit may trigger a fresh CI run.

## Observed external state

- PR #1 was open, unmerged and mergeable at inspection. The reviewed code/CI head was `1f155a06b57c8567fdb3e3bbb7466e46b2046c43`; inspect the live PR head before later edits and use an expected-head lease.
- Render workspace `tea-db3p0jrncjis73b9j2lg`, service `srv-db3p42rtqb8s73esptv0`, is `instagram-publisher-backend` on Free in Ohio, with auto-deploy from `main`. The only live deploy found was `dep-db3ptvqjnfac738cbn40`, commit `14dd0326ad2b7118c6e5a6915314f63e9f3382ed`. The review changes are not deployed; merging would trigger a production deploy.
- Render's Postgres listing returned no instances. No database was created.
- The existing public `/health` endpoint returned HTTP 200 in the prior verified check; this verifies only the old deployment's liveness, not the review OAuth flow.
- Chrome's reported Dangerous site warning remains unresolved. The available public Transparency Report check did not provide a site verdict. No bypass was attempted.

## Remaining gates

1. A PostgreSQL database is still needed for persistent token/account storage on Render. A payment method being present in Render does not mean a database exists or approve its recurring price. Before provisioning, choose and explicitly approve the exact database plan and total cost.
2. Configure `DATABASE_URL`, a stable `TOKEN_ENCRYPTION_KEY`, a private `DASHBOARD_PASSWORD`, the canonical `REDIRECT_URI`, and Facebook/Instagram product credentials privately in Render. Never print existing environment values.
3. Resolve the Safe Browsing warning, verify Meta app access/permissions, privacy and data deletion setup, then review PR #1 and approve a production rollout separately. After safe deployment, perform fresh official authorization using an owner/test account. Any real publishing smoke test needs separate approval of the exact account and content.

Keep the remaining limitations explicit: single owner rather than public multi-tenant access; URL-based media input; manual resumption after closing the dashboard; no guarantee of permanent tokens, no verification/suspension prevention, and no exactly-once guarantee across independently created requests/devices. Do not invent a completion percentage or call the project live-ready until external checks pass.
