import type { Env } from "./env";

// Which MCP clients may connect. Every client reaches the Rollout Links app through this Worker's single
// OAuth client, so we only hand tokens to redirect URIs we expect: Claude's hosted callbacks (exact URIs, so no
// other page on those hosts can receive a code) and, when enabled, loopback callbacks of local apps (Claude Code,
// MCP Inspector). The consent page warns about loopback ones.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

type Policy = Pick<Env, "ALLOWED_REDIRECT_URIS" | "ALLOW_LOOPBACK_REDIRECTS">;

const allowedUris = (env: Policy) =>
  env.ALLOWED_REDIRECT_URIS.split(",")
    .map((u) => u.trim())
    .filter(Boolean);

export function isAllowedRedirect(env: Policy, uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === "https:") return !url.search && allowedUris(env).includes(uri);
  if (url.protocol === "http:") return env.ALLOW_LOOPBACK_REDIRECTS === "true" && LOOPBACK_HOSTS.has(url.hostname);
  return false;
}

/** Registration is refused unless every redirect URI is acceptable. */
export function checkRegistration(env: Policy, metadata: Record<string, unknown>) {
  const uris = metadata.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === "string" && isAllowedRedirect(env, u))) {
    return {
      code: "invalid_redirect_uri",
      description: "This server only accepts Claude's own callback URIs and local loopback redirect URIs.",
    };
  }
}

/**
 * MCP Streamable HTTP: servers must validate Origin to stop DNS rebinding / drive-by browser requests.
 * Server-to-server clients send none; browsers on claude.ai, our own origin or localhost tools are allowed.
 */
export function isAllowedOrigin(env: Policy & Pick<Env, "PUBLIC_URL">, value: string | null) {
  if (!value) return true;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin === new URL(env.PUBLIC_URL).origin) return true;
  if (allowedUris(env).some((u) => new URL(u).origin === url.origin)) return true;
  return url.protocol === "http:" && env.ALLOW_LOOPBACK_REDIRECTS === "true" && LOOPBACK_HOSTS.has(url.hostname);
}
