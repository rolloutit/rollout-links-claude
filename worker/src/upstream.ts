import { OAuthError } from "@cloudflare/workers-oauth-provider";
import { type Env, origin, type Props, type Scope, SCOPES } from "./env";

// The Rollout Links app is the upstream OAuth server: it signs the user in with Google (@rolloutit.net only),
// shows its own consent page and issues short-lived access tokens + a refresh token to this Worker.

const TIMEOUT_MS = 10_000;

export const callbackUrl = (env: Env) => `${origin(env.PUBLIC_URL)}/callback`;

export function upstreamAuthorizeUrl(env: Env, state: string, codeChallenge: string): string {
  const url = new URL(`${origin(env.LINKS_BASE_URL)}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.LINKS_CLIENT_ID);
  url.searchParams.set("redirect_uri", callbackUrl(env));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", SCOPES.join(" "));
  return url.toString();
}

export async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function randomVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(48));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

type TokenResponse = { access_token: string; refresh_token?: string; expires_in: number; scope?: string };

async function tokenRequest(env: Env, body: Record<string, string>): Promise<{ ok: true; data: TokenResponse } | { ok: false; status: number; error: string }> {
  const res = await fetch(`${origin(env.LINKS_BASE_URL)}/api/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${btoa(`${encodeURIComponent(env.LINKS_CLIENT_ID)}:${encodeURIComponent(env.LINKS_CLIENT_SECRET)}`)}`,
    },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string };
  if (!res.ok || !data.access_token) return { ok: false, status: res.status, error: data.error ?? `http_${res.status}` };
  return { ok: true, data: data as TokenResponse };
}

/** Called at /callback. Returns the props for completeAuthorization() and the scopes the user granted upstream. */
export async function exchangeCode(env: Env, code: string, verifier: string): Promise<{ props: Props; scope: Scope[] }> {
  const res = await tokenRequest(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl(env),
    code_verifier: verifier,
  });
  if (!res.ok || !res.data.refresh_token) throw new Error(`Rollout Links token exchange failed (${res.ok ? "no refresh token" : res.error})`);
  const me = await apiFetch<{ id: number; email: string; name: string | null }>(env, res.data.access_token, "GET", "/api/v1/me");
  if (!me.ok) throw new Error(`Rollout Links /me failed (${me.status})`);
  const granted = (res.data.scope ?? "").split(" ").filter((s): s is Scope => (SCOPES as readonly string[]).includes(s));
  return {
    scope: granted,
    props: {
      userId: me.data.id,
      email: me.data.email,
      name: me.data.name,
      upstream: {
        accessToken: res.data.access_token,
        accessExpiresAt: Date.now() + res.data.expires_in * 1000,
        refreshToken: res.data.refresh_token,
      },
    },
  };
}

/** Access-token props never carry the upstream refresh token; only the grant does. */
export const accessTokenProps = (props: Props): Props => ({ ...props, upstream: { ...props.upstream, refreshToken: undefined } });

/** Our access token must not outlive the upstream access token it carries. */
export const ttlFor = (props: Props) => Math.max(60, Math.min(3600, Math.floor((props.upstream.accessExpiresAt - Date.now()) / 1000) - 30));

/** tokenExchangeCallback for refresh_token: refresh upstream, or end the grant if the user revoked it there. */
export async function refreshUpstream(env: Env, props: Props) {
  if (!props.upstream.refreshToken) throw new OAuthError("invalid_grant", { description: "No upstream refresh token" });
  let res: Awaited<ReturnType<typeof tokenRequest>>;
  try {
    res = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: props.upstream.refreshToken });
  } catch {
    throw new OAuthError("temporarily_unavailable", { description: "Rollout Links is unavailable", statusCode: 503 });
  }
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) {
      // Disconnected on the MCP Settings page, expired, or the account lost access: revoke this grant too.
      throw new OAuthError("invalid_grant", { description: "Rollout Links access was revoked" });
    }
    throw new OAuthError("temporarily_unavailable", { description: "Rollout Links is unavailable", statusCode: 503 });
  }
  const newProps: Props = {
    ...props,
    upstream: {
      accessToken: res.data.access_token,
      accessExpiresAt: Date.now() + res.data.expires_in * 1000,
      refreshToken: res.data.refresh_token ?? props.upstream.refreshToken,
    },
  };
  return { newProps, accessTokenProps: accessTokenProps(newProps), accessTokenTTL: ttlFor(newProps) };
}

export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; data: { error?: string; message?: string; [k: string]: unknown } };

/** Calls the app's /api/v1 with the user's upstream access token. */
export async function apiFetch<T>(env: Env, token: string, method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  const res = await fetch(`${origin(env.LINKS_BASE_URL)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "manual", // never follow a redirect with the bearer token attached
  });
  const data = (await res.json().catch(() => ({}))) as never;
  return res.ok ? { ok: true, status: res.status, data } : { ok: false, status: res.status, data };
}
