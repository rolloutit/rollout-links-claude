# Security

Report vulnerabilities privately to security@rolloutit.net (please don't open a public issue).

## Model

No operation runs unless the caller is **authenticated** (signed in with a Google Workspace account of an
allowed domain) **and authorized** (granted scope + per-resource permission). Both are enforced by the Rollout
Links app on every API call; the Worker adds its own checks in front.

### Authentication chain

1. **MCP client → Worker.** OAuth 2.1 via `@cloudflare/workers-oauth-provider`: authorization code + PKCE (S256
   only), Dynamic Client Registration and Client ID Metadata Documents, RFC 8707 audience-bound tokens, RFC 9207
   `iss`. Tokens are stored only as hashes in KV; `props` (which hold the upstream token) are encrypted with a key
   derived from the token itself, so a KV dump reveals nothing usable.
2. **Worker → Rollout Links.** The Worker is the app's only OAuth client (confidential, client secret, exact
   redirect URI match, PKCE S256 mandatory). The user signs in with Google there (only allowed domains) and
   approves on the app's consent page, where scopes can be unticked.
3. **Every API call** (`/api/v1`, bearer only, no cookies → no CSRF) re-checks: token hash exists and is not
   expired (1 h), grant not revoked or expired, connector still configured (kill switch), user's e-mail domain
   still allowed, required scope granted. Then per-resource rules: you can edit only your own links (API callers
   never get admin rights, so a prompt-injected Claude can't retarget a teammate's link);
   Slack DMs connected by someone else can't be attached; input is validated with strict schemas.

### Confused deputy / proxy risks (MCP security best practices)

- Per-client consent on the Worker **before** redirecting upstream, showing the client name, its verified domain
  (CIMD), and the redirect host, with a loopback warning.
- The consent form and the upstream `state` are single-use and **bound to the browser** with `__Host-` cookies,
  so a consent page can't be forged and a callback can't be replayed in a victim's browser.
- Redirect URIs are allow-listed at registration and at every authorization: Claude's exact callback URIs
  (`ALLOWED_REDIRECT_URIS`, no other path on those hosts) and loopback (`localhost`/`127.0.0.1`, for Claude
  Code; can be disabled with `ALLOW_LOOPBACK_REDIRECTS=false`).
- The consent pages can't be framed (`frame-ancestors 'none'`, `X-Frame-Options: DENY`) and escape every
  client-supplied string.
- The MCP endpoint rejects browser requests from unexpected `Origin`s (DNS rebinding).

### Tokens and lifetimes

| Token | Where | Lifetime |
|---|---|---|
| App authorization code | app DB (SHA-256) | 5 min, single use (deleted atomically) |
| App access token | app DB (SHA-256) | 1 h |
| App refresh token | app DB (SHA-256), Worker grant props (encrypted) | 30 days after sign-in (absolute); needs the client secret |
| Worker access token | KV (hashed) | ≤ the upstream access token |
| Worker refresh token | KV (hashed), rotated | 30 days (absolute) |

The 30-day cap means a person who left the company loses connector access within a month even if nobody
revokes it; admins can disconnect anyone immediately on their Profile page (offboarding).

Revoking (Profile page → Disconnect, or the app's RFC 7009 endpoint) takes effect on the next request; the
Worker's next refresh then fails with `invalid_grant` and revokes its own grant, so Claude must sign in again.

### Secrets

`LINKS_CLIENT_SECRET` and `CONSENT_SECRET` are Worker secrets (`wrangler secret put`), never in the repo. The
same client secret is `MCP_OAUTH_CLIENT_SECRET` in the app. Rotate by setting a new value in both places; existing
grants then stop refreshing and users reconnect.

### Known limits

- No dedicated rate limiting; Cloudflare's platform protections apply. Consider a WAF rate-limiting rule on
  `/token` and `/register` if abuse appears.
- Anyone in the allowed Google Workspace domain can connect; scopes and ownership limit what they can do, as in
  the web app.
- Loopback redirects accept any port (RFC 8252), so a local process on the user's machine could register a client;
  the consent page warns about it. Disable with `ALLOW_LOOPBACK_REDIRECTS=false` if nobody uses Claude Code.
- Tool output contains text from outside (contact names, link titles). Claude treats it as data, and the API's
  ownership rules bound what a misled client could do to the caller's own links and the shared contact list.
