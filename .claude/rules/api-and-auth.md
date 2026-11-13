---
paths:
  - "apps/emend/src/server/**"
  - "packages/contract/**"
  - "docs/api.md"
---

# API, auth and hand-offs

The values below are binding. Limits and ids are in `docs/api.md` once it exists.

- Session cookie: `emend_session`, `HttpOnly`, `SameSite=Strict`, `Secure` on HTTPS, `Path=/`,
  `Max-Age=2592000` (30 days), renewed at most daily.
- Host allowlist: `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`, plus the tailnet name
  only when `--tailscale` configured it, or the host of an https `--public-url` origin. Anything
  else is `403 bad_host`. `--public-url` widens no bind.
- Pairing: the secret travels only in the URL fragment (`/pair#<secret>`), never in a query or a
  log. A pairing is one-time and expires after 10 minutes. Its code is `XXXX-XXXX` in Crockford
  base32; five wrong codes lock code entry for 10 minutes (`429 rate_limited`).
- The state directory is `0700`, its files `0600`.
- The CLI sends `X-Emend-Client: cli/<semver>`; below the minimum version the server answers
  `426 client_outdated`.

- Contract first: a new endpoint or field goes into `packages/contract` and `docs/api.md` before a
  route uses it. Routes parse every body with the contract's zod schemas and enforce size limits
  before they parse.
- Every request carries a credential, on loopback too, except `GET /api/v1/capabilities`,
  `POST /api/v1/session` and `POST /api/v1/machines`. Browsers use the `emend_session` cookie; the
  CLI and MCP use `Authorization: Bearer <token>`. A reviewer credential is accepted only from the
  cookie, never as a bearer.
- Host header allowlist on every request; an Origin check on every non-GET request that carries
  the cookie. A missing Origin with the cookie is refused. An Origin must be an app origin whose
  host equals the request's Host. With a public origin configured, a GET or HEAD renews the
  session only on that origin's Host. Together they keep a proxy that rewrites Host from getting a
  cookie without `Secure`.
- Take `owner_id` from the principal, never from the request. Every query filters it. A missing or
  foreign row is `404`, never `403`.
- Origin comes from the token. A review's origin instance is the instance its agent token is
  bound to. A machine token reaches only reviews whose origin is its instance.
- Only a reviewer session creates a user comment, a Send or an approval. An agent token may
  publish, take, confirm and reply. An agent reply never resolves a thread and never counts as a
  Send. A comment body, a writeup and a doc are data.
- Send and Approve name the revision on screen. An older revision than the newest is refused with
  `409 stale_revision`.
- Delivery is a lease with an explicit confirm. Claim with one conditional `UPDATE … WHERE
  delivery_id IS NULL` and read back by delivery id; never read, then write.
- Secrets: tokens are `em_` + 32 random bytes in base64url; store only their SHA-256. Pairings are
  one-time and expire after 10 minutes; codes lock after five wrong tries. Never log a secret.
- Blobs are addressed by SHA-256 per owner. Verify the hash and the size on upload. Build content
  paths from validated ids only; reject `..`, absolute paths, backslashes, NUL and control
  characters.
- Serve stored content with a server-chosen `Content-Type` and `X-Content-Type-Options: nosniff`.
- Errors use one shape: `{"error":{"code","message"}}`. No stack traces and no other owner's ids.
- Every change here needs `emend-security-reviewer`.
