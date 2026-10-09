# Instagram Publisher repair checkpoint — 9 October 2026 (IST)

## Scope and authorization

Continue the existing repository and PR #1 (`secure-oauth-review`). The review branch may be edited and tested. Do not merge, deploy production, create paid resources or publish a real Instagram post without the owner's specific approval. Never request passwords, OTPs, access tokens or card details in chat. Use official authorization and do not bypass browser warnings or Meta verification.

## Completed in this review revision

- Private owner authentication, opaque hashed sessions, password-change invalidation, exact-origin write protection and bounded request rates.
- Workspace-owned account records persist after logout/session expiry. Tokens use authenticated encryption bound to provider/account identity. Existing populated prototype tables trigger a migration block rather than silent takeover/deletion.
- Browser-bound OAuth attempts with an atomic claim, expiration, safe duplicate/cancel/error handling and clean callback redirects. Separate Facebook and Instagram product credentials. Facebook account discovery paginates trusted Graph endpoints.
- Persistent idempotency for photos and reels; processing checks and atomic publish claims. Ambiguous outcomes are retained for read-only recovery without blindly repeating a publish request. Reconnect/expiry handling and eligible Instagram token refresh before use.
- Mobile dashboard with account management, explicit publish confirmation, durable request history and safe text rendering. No local file uploader, scheduled publishing service or proactive unattended token-refresh worker is included.
- Database readiness, explicit PostgreSQL TLS modes (`verify-full`, encrypted `require` for Render's self-signed internal certificates, and local-only `disable`), outbound request deadlines, sanitized errors/logging, reproducible dependency lockfile and setup/migration documentation.

## Verification completed

- `npm test`: **23 tests passed**, 0 failed on Node 24.19.0. Express HTTP tests use PGlite; Meta responses are mocked. The added test covers PostgreSQL TLS mode selection and confirms URL SSL flags cannot override `PGSSL`.
- Covered concurrent OAuth replay, paginated discovery of 30 test accounts, logout persistence, wrong-browser/expired/cancelled states, ciphertext tampering and account binding, origin rejection, rate limiting, concurrent publishing, ambiguous outcomes and reconnect/refresh handling.
- Headless Chromium checks recorded in the reviewed implementation passed at 390px mobile and 1365px desktop. No physical Android device or live Meta authorization was tested.
- `npm audit --omit=dev` previously reported 0 known production dependency vulnerabilities at the time checked. This is not a security certification.
- JavaScript syntax checks and `git diff --check` passed.
- GitHub Actions run #5 passed on the TLS repair/test commit `4fc8b2ff88833c5278da5e51be0aed5d966ba2e1` under Node 22.x and 24.x. No real Meta request or post was made. Read the current PR checks before merge.

## Observed external state

- At the start of this checkpoint refresh, PR #1 was open, unmerged and mergeable on `secure-oauth-review` at tested head `4fc8b2ff88833c5278da5e51be0aed5d966ba2e1`. This checkpoint-only follow-up records the verified state; check current CI and branch head before merge or any later edit, using an expected-head lease.
- Render service `srv-db3p42rtqb8s73esptv0` remains on the Free plan in Ohio and auto-deploys from `main`. Its currently live deploy is still `dep-db3ptvqjnfac738cbn40`, commit `14dd0326ad2b7118c6e5a6915314f63e9f3382ed`; the review code is not deployed.
- The owner-created Render database `instagram-publisher-db` (`dpg-db4e2ltg1s2s7394qkag-a`) is available in Ohio on plan `0.1c-256mb`, with 1 GB storage. The creation screen showed an estimated total of **$6.30/month** ($6 compute + $0.30 storage), billed by the second. The verified IP allow list is empty, blocking external access.
- The web service and database share the same Render workspace and Ohio region. Render documents that same-region services use the private internal URL regardless of the external IP allow list; this backend should use that internal URL with `PGSSL=require`. No database credentials or URLs belong in this file.
- A previous check observed HTTP 200 on the old `/health` endpoint; this confirms only old-deployment liveness. Google Transparency Report did not expose a site verdict through the available read, so Chrome's Dangerous site warning remains unresolved. No bypass was attempted.

## Remaining gates

1. Set `DATABASE_URL` to the Render internal connection URL and `PGSSL=require`, plus a stable `TOKEN_ENCRYPTION_KEY`, private `DASHBOARD_PASSWORD`, canonical `REDIRECT_URI`, and the right Facebook/Instagram product credentials, only in Render's private settings. Never ask for or print those secrets in chat. The service is still running old code, so do not wire the new database into that old deployment.
2. Resolve the Safe Browsing warning and verify Meta app access/permissions, privacy and data deletion setup. The owner must complete official Facebook/Instagram authorization in their own browser after a safe review deployment.
3. Review PR #1 and give specific approval for merge/production rollout separately. A real Instagram publishing smoke test also requires approval of the exact account, media and caption.

Keep the remaining limitations explicit: single owner rather than public multi-tenant access; URL-based media input; manual resumption after closing the dashboard; no guarantee of permanent tokens, no verification/suspension prevention, and no exactly-once guarantee across independently created requests/devices. Do not invent a completion percentage or call the project live-ready until external checks pass.
