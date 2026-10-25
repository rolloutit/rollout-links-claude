import {
  type AuthRequest,
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import { type Env, origin, SCOPES } from "./env";
import { isAllowedRedirect } from "./policy";
import { exchangeCode, randomVerifier, s256, upstreamAuthorizeUrl } from "./upstream";

// The authorization UI of this Worker (OAuthProvider's defaultHandler):
//   GET  /authorize  → validate the MCP client, show our consent page (who is asking, where tokens go)
//   POST /authorize  → user approved → redirect to the Rollout Links app (Google sign-in + its own consent)
//   GET  /callback   → exchange the app's code, then finish the MCP client's authorization
// workers-oauth-provider binds the consent handle and the upstream `state` to this browser with __Host-
// cookies, so a consent page or callback can't be forged or replayed from another browser (confused deputy).

const escape = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

function page(title: string, body: string, status = 200, headers?: Headers): Response {
  const h = new Headers(headers);
  for (const [k, v] of Object.entries(PAGE_HEADERS)) h.set(k, v);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<style>
body{font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:#fafafa;color:#18181b;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
main{background:#fff;border:1px solid #e4e4e7;border-radius:10px;max-width:440px;width:100%;padding:28px}
h1{font-size:18px;margin:0 0 12px}p{margin:8px 0;color:#3f3f46}.muted{color:#71717a;font-size:13px}
.warn{background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:8px 12px;color:#78350f;font-size:13px}
button{font:inherit;border-radius:6px;padding:8px 14px;cursor:pointer;border:1px solid #d4d4d8;background:#fff}
button.primary{background:#18181b;color:#fff;border-color:#18181b}code{font-size:13px}
</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, { status, headers: h });
}

const errorPage = (message: string, status = 400) =>
  page("Cannot connect", `<h1>Cannot connect</h1><p>${escape(message)}</p><p class="muted">Start connecting again from Claude.</p>`, status);

function consentBody(d: ConsentDescription, handle: string): string {
  const who = d.clientDomain
    ? `published by <b>${escape(d.clientDomain)}</b>`
    : `<span class="muted">(name not verified: the app registered itself)</span>`;
  return `<h1>Connect ${escape(d.clientName)} to Rollout Links?</h1>
<p><b>${escape(d.clientName)}</b> ${who} wants to use Rollout Links on your behalf: create tracked links, read open statistics and manage the shared contact list.</p>
<p>Access will be sent to <b>${escape(d.redirectHost)}</b>.</p>
${d.redirectIsLoopback ? '<p class="warn">This sends access to an app on <b>your computer</b> (e.g. Claude Code). Continue only if you just started connecting from it.</p>' : ""}
<p class="muted">Next you sign in with your @rolloutit.net Google account and confirm on link.rolloutit.net.</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escape(handle)}">
<p><button class="primary" name="decision" value="approve">Continue</button> <button name="decision" value="deny">Cancel</button></p>
</form>`;
}

/** Redirect to the Rollout Links app; `state` is bound to this browser by beginUpstream(). */
async function startUpstream(env: Env, request: AuthRequest, headers: Headers): Promise<Response> {
  const verifier = randomVerifier();
  const upstream = await env.OAUTH_PROVIDER.beginUpstream(request, { data: { verifier }, headers });
  upstream.headers.set("location", upstreamAuthorizeUrl(env, upstream.state, await s256(verifier)));
  upstream.headers.set("cache-control", "no-store");
  return new Response(null, { status: 302, headers: upstream.headers });
}

const remember = (env: Env) => ({ secret: env.CONSENT_SECRET });

async function authorizeGet(req: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const request = await oauth.parseAuthRequest(req);
  if (!isAllowedRedirect(env, request.redirectUri)) {
    return errorPage("This app is not allowed to connect to Rollout Links (unexpected redirect address).", 403);
  }
  if (await oauth.isConsentRemembered(req, request, remember(env))) {
    return startUpstream(env, request, new Headers());
  }
  const details = await oauth.describeConsent(request); // before beginConsent: a failed lookup leaves nothing in KV
  const consent = await oauth.beginConsent(request);
  return page(`Connect ${details.clientName}`, consentBody(details, consent.handle), 200, consent.headers);
}

async function authorizePost(req: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const form = await req.formData();
  const handle = String(form.get("handle") ?? "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(req, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  // Upstream consent on link.rolloutit.net decides the final scopes; here the client is approved for all of them.
  const approved = await oauth.approveConsent(req, handle, { scope: [...SCOPES], remember: remember(env) });
  if (!isAllowedRedirect(env, approved.request.redirectUri)) return errorPage("Unexpected redirect address.", 403);
  return startUpstream(env, approved.request, approved.headers);
}

async function callback(req: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(req);
  const params = new URL(req.url).searchParams;

  const deny = (description: string) => {
    headers.set("location", authorizationErrorRedirect(original, "access_denied", description));
    return new Response(null, { status: 302, headers });
  };
  if (params.get("error")) return deny("Declined on Rollout Links");
  // RFC 9207: the code must come from the server we sent the user to (Rollout Links always sends iss).
  const iss = params.get("iss");
  if (!iss || origin(iss) !== origin(env.LINKS_BASE_URL)) return deny("Unexpected issuer");
  const code = params.get("code");
  if (!code) return deny("Missing code");

  const { props, scope } = await exchangeCode(env, code, data.verifier);
  if (scope.length === 0) return deny("No permissions granted");

  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: String(props.userId),
    metadata: { email: props.email },
    scope,
    props,
  });
  headers.set("location", redirectTo);
  headers.set("cache-control", "no-store");
  return new Response(null, { status: 302, headers });
}

function home(env: Env): Response {
  return page(
    "Rollout Links MCP",
    `<h1>Rollout Links MCP server</h1>
<p>This is the MCP server of <a href="${escape(origin(env.LINKS_BASE_URL))}">Rollout Links</a>.</p>
<p>Connector URL: <code>${escape(origin(env.PUBLIC_URL))}/mcp</code></p>
<p class="muted">Setup instructions for Claude and ChatGPT are on the MCP Settings page in Rollout Links.</p>`,
  );
}

export const authHandler: ExportedHandler<Env> = {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    try {
      if (pathname === "/authorize" && req.method === "GET") return await authorizeGet(req, env);
      if (pathname === "/authorize" && req.method === "POST") return await authorizePost(req, env);
      if (pathname === "/callback" && req.method === "GET") return await callback(req, env);
      if (pathname === "/" && req.method === "GET") return home(env);
      return new Response("Not found", { status: 404 });
    } catch (error) {
      // Only a validated client + exact redirect URI may receive an error redirect; everything else is shown here.
      if (error instanceof AuthorizationError && error.redirectTo && isAllowedRedirect(env, error.redirectUri ?? "")) {
        return Response.redirect(error.redirectTo, 302);
      }
      if (error instanceof AuthorizationError) return errorPage(error.description ?? "Invalid or expired request.");
      if (error instanceof CimdFetchError) return errorPage("This app could not be verified.");
      console.error("[auth] unexpected error", pathname, error instanceof Error ? error.message : error);
      return errorPage("Something went wrong. Please try again.", 500);
    }
  },
};
