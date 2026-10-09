# Instagram Publisher repair checkpoint — 9 October 2026 (IST)

## Scope and authorization

Continue the existing repository and PR #1 (`secure-oauth-review`). This review branch may be edited/tested. Do not merge, deploy production, create paid resources or publish a real Instagram post without the owner's specific approval. Never request passwords, OTPs, access tokens or card details in chat. Use official authorization and do not bypass browser warnings or Meta verification.

## Completed in this review revision

- Private owner authentication, opaque hashed sessions, password-change invalidation, exact-origin write protection and bounded request rates.
- Workspace-owned account records persist after logout/session expiry. Tokens use authenticated encryption bound to provider/account identity. Existing populated prototype tables trigger a migration block rather than silent takeover/deletion.
- Browser-bound OAuth attempts with an atomic claim, expiration, safe duplicate/cancel/error handling and clean callback redirects. Separate Facebook and Instagram product credentials. Facebook account discovery paginates trusted Graph endpoints.
- Persistent idempotency for photos and reels; processing checks and atomic publish claims. Ambiguous outcomes are retained for read-only recovery without blindly repeating a publish request. Reconnect/expiry handling and eligible Instagram token refresh before use.
- Mobile dashboard with account management, explicit publish confirmation, durable request history and safe text rendering. No local file uploader, scheduled publishing service or proactive unattended token-refresh worker is included.
- Database readiness, verified TLS by default, outbound request deadlines, sanitized errors/logging, reproducible dependency lockfile and setup/migration documentation.

## Verification completed locally

- `npm test`: **22 tests passed**, 0 failed. Express HTTP integration tests use a real local PostgreSQL engine (PGlite); external Meta responses are mocked.
- Covered concurrent OAuth replay, 30-account paginated discovery, logout persistence, wrong-browser/expired/cancelled states, separate Instagram credentials, ciphertext tampering and account binding, large-ID precision, origin rejection, rate limiting, concurrent publishing, uncertain results, token refresh/revocation and a lost database write after Meta publishing.
- Headless Chromium: 390px mobile and 1365px desktop screenshots visually inspected. Owner sign-in, account list, mocked publish receipt and sign-out passed. No JavaScript page errors or mobile horizontal overflow. This is not a test on the owner's physical Android device or with real Meta authorization.
- `npm audit --omit=dev`: 0 reported production dependency vulnerabilities at the time of checking. This is not a security certification.
- JavaScript syntax checks and `git diff --check` passed. No GitHub CI checks were present on the preceding PR head; do not describe local results as GitHub CI results.

## Observed external state

- PR #1 was open and unmerged at inspection; the preceding head was `2ab957414739db4fabe044b0e0627ff7da6eccfd`. Verify the current head before subsequent edits and use an expected-head lease.
- Render workspace `tea-db3p0jrncjis73b9j2lg`, service `srv-db3p42rtqb8s73esptv0`, still reported live deployment `dep-db3ptvqjnfac738cbn40`, commit `14dd0326ad2b7118c6e5a6915314f63e9f3382ed`. These repairs have not been deployed.
- A fresh public `/health` fetch returned HTTP 200 and `{"ok":true,"service":"instagram-publisher-backend"}` after an initial timeout. A healthy old deployment does not verify the new OAuth flow.
- Render's database listing returned no PostgreSQL instances. No database was created or charged.
- Google's public Transparency Report HTML loaded but did not expose a site verdict through the available read. Chrome's reported Dangerous site warning remains unresolved. No bypass was attempted.

## Next gates

1. Select/approve persistent database hosting and the complete cost before provisioning. Configure the stable encryption key, private owner password and database connection in Render's secret settings. Confirm both Meta products' credentials/redirects privately. Do not print existing environment values.
2. Review the concrete PR and approve a production rollout separately. Meta app access/permissions, required privacy/deletion setup and Safe Browsing investigation must be checked. After safe deployment, perform fresh official authorization with an owner/test account, then obtain approval of an exact account/media/caption before any real publishing smoke test.

Keep the remaining limitations explicit: single owner rather than public multi-tenant access; URL-based media input; manual resumption after closing the dashboard; no guarantee of permanent tokens, no verification/suspension prevention, and no exactly-once guarantee across independently created requests/devices. Do not invent a completion percentage or call the project live-ready until these external checks pass.
