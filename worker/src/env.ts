import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  /** KV namespace used by workers-oauth-provider (clients, grants, hashed tokens, encrypted props). */
  OAUTH_KV: KVNamespace;
  /** Injected by OAuthProvider into the default handler. */
  OAUTH_PROVIDER: OAuthHelpers;

  /** This Worker's public origin, e.g. https://rollout-links-mcp.example.workers.dev (no trailing slash). */
  PUBLIC_URL: string;
  /** The Rollout Links app, e.g. https://link.rolloutit.net */
  LINKS_BASE_URL: string;
  /** OAuth client id registered in the app (MCP_OAUTH_CLIENT_ID there). */
  LINKS_CLIENT_ID: string;
  /** Secret: `wrangler secret put LINKS_CLIENT_SECRET` (MCP_OAUTH_CLIENT_SECRET in the app). */
  LINKS_CLIENT_SECRET: string;
  /** Secret, 32+ chars: signs the "remember this client" consent cookie. */
  CONSENT_SECRET: string;
  /** Comma-separated exact https redirect URIs MCP clients may use (Claude's OAuth callbacks). */
  ALLOWED_REDIRECT_URIS: string;
  /** "true" lets local apps (Claude Code, MCP Inspector) use http://localhost / 127.0.0.1 callbacks. */
  ALLOW_LOOPBACK_REDIRECTS: string;
}

/** Everything the scopes on this server can grant; mirrors the app's /api/v1 scopes. */
export const SCOPES = ["links:read", "links:write", "contacts:read", "contacts:write"] as const;
export type Scope = (typeof SCOPES)[number];

/** Encrypted by workers-oauth-provider and handed to the MCP handler as ctx.props. */
export type Props = {
  userId: number;
  email: string;
  name: string | null;
  upstream: {
    accessToken: string;
    /** Epoch ms. */
    accessExpiresAt: number;
    /** Only kept in the grant's props, never in an access token's props. */
    refreshToken?: string;
  };
};

export const origin = (url: string) => url.replace(/\/+$/, "");
