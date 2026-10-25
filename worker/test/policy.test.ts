import { describe, expect, it } from "vitest";
import { checkRegistration, isAllowedOrigin, isAllowedRedirect } from "../src/policy";

const env = {
  ALLOWED_REDIRECT_URIS:
    "https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback,https://chatgpt.com/connector_platform_oauth_redirect",
  ALLOW_LOOPBACK_REDIRECTS: "true",
  PUBLIC_URL: "https://rollout-links-mcp.example.workers.dev",
};

describe("redirect URI policy", () => {
  it("allows Claude and loopback callbacks", () => {
    for (const uri of [
      "https://claude.ai/api/mcp/auth_callback",
      "https://claude.com/api/mcp/auth_callback",
      "https://chatgpt.com/connector_platform_oauth_redirect",
      "http://localhost:33418/callback",
      "http://127.0.0.1:6274/oauth/callback",
    ]) {
      expect(isAllowedRedirect(env, uri), uri).toBe(true);
    }
  });

  it("refuses everything else", () => {
    for (const uri of [
      "https://evil.test/cb",
      "https://claude.ai/some/other/page",
      "https://chatgpt.com/connector/oauth/attacker",
      "https://claude.ai/api/mcp/auth_callback?next=https://evil.test",
      "https://claude.ai/api/mcp/auth_callback/",
      "https://claude.ai.evil.test/cb",
      "https://evilclaude.ai/cb",
      "http://claude.ai/api/mcp/auth_callback",
      "https://user:pw@claude.ai/cb",
      "https://claude.ai/cb#frag",
      "http://localhost.evil.test/cb",
      "javascript:alert(1)",
      "cursor://anysphere.cursor-mcp/oauth/callback",
      "not a url",
    ]) {
      expect(isAllowedRedirect(env, uri), uri).toBe(false);
    }
  });

  it("loopback can be switched off", () => {
    expect(isAllowedRedirect({ ...env, ALLOW_LOOPBACK_REDIRECTS: "false" }, "http://localhost:1234/cb")).toBe(false);
  });

  it("rejects a registration if any redirect URI is not allowed", () => {
    expect(checkRegistration(env, { redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] })).toBeUndefined();
    expect(checkRegistration(env, { redirect_uris: ["https://claude.ai/api/mcp/auth_callback", "https://evil.test/cb"] })).toBeDefined();
    expect(checkRegistration(env, { redirect_uris: ["https://claude.ai/attacker-controlled"] })).toBeDefined();
    expect(checkRegistration(env, { redirect_uris: [] })).toBeDefined();
    expect(checkRegistration(env, {})).toBeDefined();
  });
});

describe("Origin check", () => {
  it("allows no Origin, Claude, our own origin and localhost tools", () => {
    for (const o of [null, "https://claude.ai", env.PUBLIC_URL, "http://localhost:6274"]) {
      expect(isAllowedOrigin(env, o), String(o)).toBe(true);
    }
  });

  it("blocks other browser origins", () => {
    for (const o of ["https://evil.test", "null", "http://claude.ai", "https://claude.ai.evil.test"]) {
      expect(isAllowedOrigin(env, o), o).toBe(false);
    }
  });
});
