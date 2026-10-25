import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env, Props } from "../src/env";
import { mcpHandler } from "../src/mcp";
import { accessTokenProps, ttlFor } from "../src/upstream";

const env = {
  PUBLIC_URL: "https://mcp.example.test",
  LINKS_BASE_URL: "https://link.example.test",
  ALLOWED_REDIRECT_URIS: "https://claude.ai/api/mcp/auth_callback",
  ALLOW_LOOPBACK_REDIRECTS: "true",
} as Env;

const props: Props = {
  userId: 1,
  email: "kitti@rolloutit.net",
  name: "Kitti",
  upstream: { accessToken: "rla_upstream", accessExpiresAt: Date.now() + 3600_000 },
};

function ctx(scope: string[]) {
  return { props, auth: { token: "t", audience: "https://mcp.example.test/mcp", scope }, waitUntil() {}, passThroughOnException() {} } as never;
}

async function rpc(method: string, params: unknown, scope = ["links:read", "links:write", "contacts:read", "contacts:write"]) {
  const res = await mcpHandler.fetch(
    new Request("https://mcp.example.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env,
    ctx(scope),
  );
  return (await res.json()) as { result: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean } };
}

afterEach(() => vi.unstubAllGlobals());

describe("MCP tools", () => {
  it("only exposes tools the grant's scopes allow", async () => {
    const all = (await rpc("tools/list", {})).result.tools!.map((t) => t.name);
    expect(all).toContain("create_tracked_link");
    expect(all).toContain("upload_contacts");
    const readOnly = (await rpc("tools/list", {}, ["links:read"])).result.tools!.map((t) => t.name);
    expect(readOnly).toContain("get_link_stats");
    expect(readOnly).not.toContain("create_tracked_link");
    expect(readOnly).not.toContain("search_contacts");
  });

  it("creates a link through the API with the user's token and appends the source tag", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ link: { slug: "ai-day", linkedHelperUrl: "https://link.example.test/ai-day?h={memberId}" } }, { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const out = await rpc("tools/call", {
      name: "create_tracked_link",
      arguments: {
        title: "AI Day",
        target_url: "https://drive.google.com/x",
        slack_channel_id: 3,
        preview_image_url: "https://example.com/c.png",
        source_tag: "k&evil=1",
      },
    });
    expect(out.result.isError).toBeFalsy();
    expect(JSON.parse(out.result.content![0].text).link.linkedHelperUrl).toBe("https://link.example.test/ai-day?h={memberId}&s=kevil1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://link.example.test/api/v1/links");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer rla_upstream");
    expect(init.redirect).toBe("manual");
    expect(JSON.parse(init.body as string)).toMatchObject({
      title: "AI Day",
      targetUrl: "https://drive.google.com/x",
      slackDestinationId: 3,
      notifyMode: "every",
      ogImage: "https://example.com/c.png",
    });
  });

  it("rejects non-URL input before calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await rpc("tools/call", { name: "create_tracked_link", arguments: { title: "x", target_url: "not a url" } });
    expect(out.result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces API errors (e.g. a taken slug) to Claude", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ error: "invalid_link", message: "Validation failed.", fields: { slug: "This name is already taken." }, suggestion: "ai-day-2" }, { status: 400 }),
    );
    const out = await rpc("tools/call", { name: "create_tracked_link", arguments: { title: "x", target_url: "https://e.com", slug: "ai-day" } });
    expect(out.result.isError).toBe(true);
    expect(out.result.content![0].text).toContain("ai-day-2");
  });

  it("tells Claude to reconnect when the app rejects the token", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ error: "invalid_token" }, { status: 401 }));
    const out = await rpc("tools/call", { name: "whoami", arguments: {} });
    expect(out.result.isError).toBe(true);
    expect(out.result.content![0].text).toMatch(/Reconnect/);
  });

  it("blocks foreign browser origins", async () => {
    const res = await mcpHandler.fetch(
      new Request("https://mcp.example.test/mcp", { method: "POST", headers: { origin: "https://evil.test" }, body: "{}" }),
      env,
      ctx(["links:read"]),
    );
    expect(res.status).toBe(403);
  });
});

describe("token props", () => {
  it("never puts the upstream refresh token into access-token props", () => {
    const p = { ...props, upstream: { ...props.upstream, refreshToken: "rlr_secret" } };
    expect(JSON.stringify(accessTokenProps(p))).not.toContain("rlr_secret");
  });

  it("keeps our access token shorter than the upstream one", () => {
    expect(ttlFor({ ...props, upstream: { ...props.upstream, accessExpiresAt: Date.now() + 3600_000 } })).toBeLessThanOrEqual(3570);
    expect(ttlFor({ ...props, upstream: { ...props.upstream, accessExpiresAt: Date.now() - 1000 } })).toBe(60);
  });
});
