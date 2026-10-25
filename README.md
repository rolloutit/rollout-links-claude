# Rollout Links for Claude

Talk to [Rollout Links](https://link.rolloutit.net) from Claude:

> *"Készíts egy trackelhető linket erre a Drive deckre, és a #sales-signals channelen legyen követhető."*
> *"Who opened my links this week? Group them by company."*
> *"Here's a Linked Helper export, add these people to the contacts."*

Claude asks for anything missing (Slack channel, preview card, short name…), creates the link and hands you the
Linked Helper URL to paste into your campaign.

This repo contains:

| Path | What |
|---|---|
| [`worker/`](worker) | Remote **MCP server** on Cloudflare Workers (free plan), OAuth 2.1 sign-in through Rollout Links |
| [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) | **Claude Code plugin marketplace** |
| [`plugins/rollout-links/`](plugins/rollout-links) | The plugin: connector config + skills |
| [`plugins/rollout-links/skills/`](plugins/rollout-links/skills) | **Skills**: `tracked-link` (create/edit/analyse links), `link-contacts` (contact upload) |

## Connect (users)

You need a Rollout Links account (@rolloutit.net Google sign-in). Your **Profile** page in Rollout Links shows the
same steps with the right URL.

**Claude.ai / Claude Desktop / mobile**
1. Settings → Connectors → **Add custom connector** → URL: `https://<worker>/mcp` → Connect.
2. Approve, sign in with Google, click **Allow** on link.rolloutit.net.
3. Recommended: download `tracked-link.zip` and `link-contacts.zip` from the
   [latest release](../../releases/latest) and upload them in Settings → Capabilities → Skills.

**Claude Code**
```
/plugin marketplace add rolloutit/rollout-links-claude
/plugin install rollout-links@rollout-links
```
Then `/mcp` → `rollout-links` → authenticate.

## Tools

| Tool | Scope | |
|---|---|---|
| `create_tracked_link` | links:write | Target URL, title, Slack channel, notify mode, preview title/description/image, slug, `s=` tag |
| `update_tracked_link` | links:write | Change or switch off your own link (admins: any) |
| `list_slack_channels` | links:read | Channels you can attach (+ link to connect a new one) |
| `check_slug` | links:read | Is a short name free? Suggests one if not |
| `list_tracked_links` | links:read | Team links with open counts |
| `get_link_stats` | links:read | Who opened a link, how often, when |
| `recent_opens` | links:read | Opens across links in the last N hours |
| `search_contacts` | contacts:read | Look up people in the shared contact list |
| `upload_contacts` | contacts:write | Add/update up to 500 contacts per call |
| `whoami` | links:read | Which account Claude is connected as |

The server also ships MCP `instructions` and a `create-tracked-link` prompt, so Claude asks the right questions
even without the skill.

## How it works

```
Claude ──MCP + OAuth 2.1 (PKCE, DCR/CIMD)──▶ Worker (this repo) ──OAuth 2.1 (PKCE, client secret)──▶ link.rolloutit.net
                                              consent page                                         Google sign-in, consent,
                                              tokens in KV (hashed)                                /api/v1 (scopes, ownership)
```

- The Worker is the OAuth authorization server for MCP clients
  ([`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)) and a
  confidential OAuth client of the Rollout Links app, which signs the user in with Google and checks every
  API call. Details and threat model: [SECURITY.md](SECURITY.md).
- Stateless Streamable HTTP MCP endpoint, no Durable Objects: Workers Free (100k requests/day) and KV Free
  are plenty for a team.

## Deploy (admins)

Prerequisites: a Cloudflare account, Node 22+, admin access to the Rollout Links hosting (env variables).

1) Cloudflare:

```bash
cd worker
npm ci
npx wrangler login
npx wrangler kv namespace create OAUTH_KV        # paste the id into wrangler.jsonc
npx wrangler deploy                               # prints https://rollout-links-mcp.<subdomain>.workers.dev
../scripts/set-server-url.sh https://rollout-links-mcp.<subdomain>.workers.dev
openssl rand -hex 32 | npx wrangler secret put CONSENT_SECRET
openssl rand -hex 32                               # → the shared client secret, use it twice:
npx wrangler secret put LINKS_CLIENT_SECRET        #   1) here
npx wrangler deploy
```

2) In the Rollout Links app (Vercel/Railway env), then redeploy it:

```
MCP_OAUTH_CLIENT_ID=rollout-links-mcp
MCP_OAUTH_CLIENT_SECRET=<the same secret>
MCP_OAUTH_REDIRECT_URIS=https://rollout-links-mcp.<subdomain>.workers.dev/callback
MCP_SERVER_URL=https://rollout-links-mcp.<subdomain>.workers.dev/mcp
MCP_PLUGIN_REPO=rolloutit/rollout-links-claude
```

3) Commit the updated `.mcp.json`, and tag a release (`git tag v1.0.0 && git push --tags`) so the skill zips are
published.

**Kill switch:** removing `MCP_OAUTH_CLIENT_ID` from the app instantly rejects every connector token.
Users can disconnect individually on their Profile page.

### Custom domain (optional)

`workers.dev` works fine. For e.g. `mcp.rolloutit.net` the zone must be on Cloudflare; add a
`routes: [{ "pattern": "mcp.rolloutit.net", "custom_domain": true }]` entry, set `workers_dev: false`, and run
`set-server-url.sh` with the new URL (and update `MCP_OAUTH_REDIRECT_URIS` in the app).

## Develop

```bash
cd worker
cp .dev.vars.example .dev.vars   # point LINKS_BASE_URL at a local Rollout Links (MCP_OAUTH_REDIRECT_URIS=http://localhost:8787/callback there)
npm run dev                      # http://localhost:8787/mcp
npm test && npm run typecheck
npx @modelcontextprotocol/inspector   # connect to http://localhost:8787/mcp
```
