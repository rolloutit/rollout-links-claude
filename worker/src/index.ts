import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { authHandler } from "./auth";
import { type Env, origin, type Props, SCOPES } from "./env";
import { mcpHandler } from "./mcp";
import { checkRegistration } from "./policy";
import { accessTokenProps, refreshUpstream, ttlFor } from "./upstream";

// Rollout Links remote MCP server.
//   /mcp                      MCP endpoint (Streamable HTTP), bearer token required
//   /authorize, /callback     consent + sign-in through link.rolloutit.net (src/auth.ts)
//   /token, /register         OAuth 2.1 token + Dynamic Client Registration (workers-oauth-provider)
//   /.well-known/*            RFC 8414 / RFC 9728 discovery (workers-oauth-provider)

let provider: OAuthProvider<Env> | undefined;

function getProvider(env: Env): OAuthProvider<Env> {
  provider ??= new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcpHandler,
    defaultHandler: authHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [...SCOPES],
    resourceMetadata: { resource: `${origin(env.PUBLIC_URL)}/mcp`, resource_name: "Rollout Links" },
    accessTokenTTL: 3600,
    // Same absolute lifetime as the upstream grant: after 30 days Claude must sign in with Google again.
    refreshTokenTTL: 30 * 24 * 3600,
    clientRegistrationTTL: 90 * 24 * 3600,
    clientRegistrationCallback: ({ clientMetadata }) => checkRegistration(env, clientMetadata),
    tokenExchangeCallback: async ({ grantType, props, env: callEnv }) => {
      const p = props as Props;
      if (grantType === "authorization_code") return { accessTokenProps: accessTokenProps(p), accessTokenTTL: ttlFor(p) };
      if (grantType === "refresh_token") return refreshUpstream(callEnv as Env, p);
    },
    onError: ({ code, description, status }) => {
      if (status >= 500) console.error("[oauth]", code, description);
    },
  });
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    for (const name of ["PUBLIC_URL", "LINKS_BASE_URL", "LINKS_CLIENT_ID", "LINKS_CLIENT_SECRET", "CONSENT_SECRET", "ALLOWED_REDIRECT_URIS"] as const) {
      if (!env[name]) return Promise.resolve(new Response(`Server misconfigured: ${name} is not set`, { status: 500 }));
    }
    if (env.CONSENT_SECRET.length < 32 || !env.PUBLIC_URL.startsWith("https://") || !env.LINKS_BASE_URL.startsWith("https://")) {
      if (!new URL(request.url).hostname.match(/^(localhost|127\.0\.0\.1)$/)) {
        return Promise.resolve(new Response("Server misconfigured: https URLs and a 32+ char CONSENT_SECRET are required", { status: 500 }));
      }
    }
    return getProvider(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
