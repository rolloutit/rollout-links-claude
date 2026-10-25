import type { OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Env, Props, Scope } from "./env";
import { isAllowedOrigin } from "./policy";
import { apiFetch } from "./upstream";

// Stateless MCP server (Streamable HTTP, JSON responses): a fresh McpServer per request, no Durable Objects.
// OAuthProvider has already verified the bearer token; ctx.props carries the user's Rollout Links token.
// Authorization is enforced again by the app on every API call (scopes, ownership, e-mail domain).

export const INSTRUCTIONS = `Rollout Links creates tracked links for LinkedIn outreach (Linked Helper). Each open is logged and can notify a Slack channel, e.g. "John Smith (CEO, Acme) opened: AI Launch Day".

Creating a link — collect before calling create_tracked_link, asking the user for anything missing (one short question at a time, offer sensible defaults):
1. target_url: where the link should lead (required).
2. title: shown in Slack notifications and the dashboard (suggest one from context).
3. Slack channel: call list_slack_channels and let the user pick, or "no notification". If the channel they want is missing, it must be connected first in the browser (connectNewChannelUrl).
4. Optional: preview_title / preview_description / preview_image_url for the LinkedIn/Slack preview card (image ideally 1200×627, https), slug (short name), notify_mode ("every" open by default, or only the "first" open per person), source_tag (s=, e.g. k for Kitti, b for Balázs).
Then confirm the summary, create it, and give the user linkedHelperUrl to paste into the Linked Helper message: {memberId} must stay literally as is, and no punctuation may follow the link.`;

type Ctx = OAuthResourceContext<Props>;

const text = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

function buildServer(env: Env, props: Props, scopes: Scope[]): McpServer {
  const server = new McpServer({ name: "rollout-links", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  const can = (s: Scope) => scopes.includes(s);

  async function api<T>(method: string, path: string, body?: unknown) {
    const res = await apiFetch<T>(env, props.upstream.accessToken, method, path, body);
    if (res.ok) return { ok: true as const, data: res.data };
    if (res.status === 401) {
      return { ok: false as const, error: "Rollout Links rejected the connection (expired or disconnected). Reconnect the Rollout Links connector in Claude." };
    }
    const d = res.data;
    const details = [d.message ?? d.error ?? `HTTP ${res.status}`];
    if (d.fields) details.push(`fields: ${JSON.stringify(d.fields)}`);
    if (d.issues) details.push(`issues: ${JSON.stringify(d.issues)}`);
    if (d.suggestion) details.push(`suggested free slug: ${String(d.suggestion)}`);
    return { ok: false as const, error: details.join("; ") };
  }

  const link = z.union([z.number().int().positive(), z.string().min(1).max(64)]).describe("Link id or slug");
  const optionalUrl = z.string().url().max(2000);

  const withSource = <T extends { link?: { linkedHelperUrl?: string } }>(data: T, source?: string) => {
    const s = source?.replace(/[^a-zA-Z0-9_-]/g, "");
    if (s && data.link?.linkedHelperUrl) data.link.linkedHelperUrl += `&s=${s}`;
    return data;
  };

  // ---- read-only -------------------------------------------------------------------------------
  if (can("links:read")) {
    server.registerTool(
      "whoami",
      {
        title: "Who am I",
        description: "The Rollout Links account Claude is connected as, and its permissions.",
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async () => {
        const r = await api("GET", "/api/v1/me");
        return r.ok ? text(r.data) : fail(r.error);
      },
    );

    server.registerTool(
      "list_slack_channels",
      {
        title: "List Slack channels",
        description:
          "Slack channels that can receive open notifications for a link (team channels plus your own DMs). New channels can only be connected in the browser via connectNewChannelUrl.",
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async () => {
        const r = await api("GET", "/api/v1/slack/channels");
        return r.ok ? text(r.data) : fail(r.error);
      },
    );

    server.registerTool(
      "check_slug",
      {
        title: "Check short name",
        description: "Whether a short name (slug, the part after link.rolloutit.net/) is free; suggests an alternative if not.",
        inputSchema: { slug: z.string().min(1).max(64) },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ slug }) => {
        const r = await api("GET", `/api/v1/slugs/${encodeURIComponent(slug)}`);
        return r.ok ? text(r.data) : fail(r.error);
      },
    );

    server.registerTool(
      "list_tracked_links",
      {
        title: "List tracked links",
        description: "The team's tracked links with open counts, newest first. Filter by text or to your own links.",
        inputSchema: {
          query: z.string().max(200).optional().describe("Matches title, slug or target URL"),
          mine: z.boolean().optional().describe("Only links you own"),
          limit: z.number().int().min(1).max(200).optional(),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ query, mine, limit }) => {
        const qs = new URLSearchParams();
        if (query) qs.set("q", query);
        if (mine) qs.set("mine", "true");
        if (limit) qs.set("limit", String(limit));
        const r = await api("GET", `/api/v1/links?${qs}`);
        return r.ok ? text(r.data) : fail(r.error);
      },
    );

    server.registerTool(
      "get_link_stats",
      {
        title: "Link statistics",
        description: "Who opened a link (name, company, position, LinkedIn profile, number of opens, first/last open), totals and a daily breakdown.",
        inputSchema: { link },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ link }) => {
        const r = await api("GET", `/api/v1/links/${encodeURIComponent(String(link))}`);
        return r.ok ? text(r.data) : fail(r.error);
      },
    );

    server.registerTool(
      "recent_opens",
      {
        title: "Recent opens",
        description: "Opens across links in the last N hours (bots excluded), newest first, with the person when known. Good for 'who opened my links this week?'.",
        inputSchema: {
          hours: z.number().int().min(1).max(2160).optional().describe("Look-back window, default 168 (7 days)"),
          mine: z.boolean().optional().describe("Only your own links (default true)"),
          limit: z.number().int().min(1).max(500).optional(),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ hours, mine, limit }) => {
        const qs = new URLSearchParams({ hours: String(hours ?? 168), mine: String(mine ?? true) });
        if (limit) qs.set("limit", String(limit));
        const r = await api("GET", `/api/v1/opens?${qs}`);
        return r.ok ? text(r.data) : fail(r.error);
      },
    );
  }

  // ---- links:write -----------------------------------------------------------------------------
  if (can("links:write")) {
    server.registerTool(
      "create_tracked_link",
      {
        title: "Create tracked link",
        description:
          "Create a tracked link that redirects to target_url and (optionally) notifies a Slack channel on every open. Ask the user for missing details first (see the server instructions). Returns linkedHelperUrl to paste into Linked Helper.",
        inputSchema: {
          title: z.string().min(1).max(200).describe("Shown in Slack notifications and the dashboard"),
          target_url: optionalUrl.describe("Where visitors are redirected, e.g. a Google Drive link"),
          slug: z.string().max(64).optional().describe("Short name; derived from the title when omitted"),
          slack_channel_id: z.number().int().positive().optional().describe("id from list_slack_channels; omit for no notification"),
          notify_mode: z.enum(["every", "first"]).optional().describe("every (default, max once per 30 min per person) or first open only"),
          preview_title: z.string().max(200).optional().describe("Preview card title (defaults to title)"),
          preview_description: z.string().max(300).optional(),
          preview_image_url: optionalUrl.optional().describe("Public https image URL, ideally 1200×627"),
          source_tag: z.string().max(32).optional().describe("Optional s= tag added to the Linked Helper URL, e.g. k or b"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async (a) => {
        const r = await api<{ link: { linkedHelperUrl: string } }>("POST", "/api/v1/links", {
          title: a.title,
          targetUrl: a.target_url,
          slug: a.slug,
          slackDestinationId: a.slack_channel_id ?? null,
          notifyMode: a.notify_mode ?? "every",
          ogTitle: a.preview_title ?? null,
          ogDescription: a.preview_description ?? null,
          ogImage: a.preview_image_url ?? null,
        });
        return r.ok ? text(withSource(r.data, a.source_tag)) : fail(r.error);
      },
    );

    server.registerTool(
      "update_tracked_link",
      {
        title: "Update tracked link",
        description:
          "Change one of your own links (admins: any). Only the given fields change; pass null to clear a preview field or the Slack channel. Set active=false to switch a link off (it then returns 404) instead of deleting it.",
        inputSchema: {
          link,
          title: z.string().min(1).max(200).optional(),
          target_url: optionalUrl.optional(),
          slug: z.string().max(64).optional().describe("Changing it breaks links already sent out"),
          slack_channel_id: z.number().int().positive().nullable().optional(),
          notify_mode: z.enum(["every", "first"]).optional(),
          preview_title: z.string().max(200).nullable().optional(),
          preview_description: z.string().max(300).nullable().optional(),
          preview_image_url: optionalUrl.nullable().optional(),
          active: z.boolean().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (a) => {
        const r = await api("PATCH", `/api/v1/links/${encodeURIComponent(String(a.link))}`, {
          title: a.title,
          targetUrl: a.target_url,
          slug: a.slug,
          slackDestinationId: a.slack_channel_id,
          notifyMode: a.notify_mode,
          ogTitle: a.preview_title,
          ogDescription: a.preview_description,
          ogImage: a.preview_image_url,
          isActive: a.active,
        });
        return r.ok ? text(r.data) : fail(r.error);
      },
    );

    server.registerPrompt(
      "create-tracked-link",
      {
        title: "Create a tracked link",
        description: "Walks through creating a tracked link with Slack notifications.",
        argsSchema: { target_url: z.string().optional(), channel: z.string().optional() },
      },
      ({ target_url, channel }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Create a Rollout Links tracked link${target_url ? ` to ${target_url}` : ""}${channel ? `, notifying the Slack channel ${channel}` : ""}. Ask me for anything you still need, one question at a time, then show a summary before creating it.`,
            },
          },
        ],
      }),
    );
  }

  // ---- contacts --------------------------------------------------------------------------------
  if (can("contacts:read")) {
    server.registerTool(
      "search_contacts",
      {
        title: "Search contacts",
        description: "Search the team's shared contact list (LinkedIn member id → person) by name, company, position or member id.",
        inputSchema: { query: z.string().max(200), limit: z.number().int().min(1).max(100).optional() },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ query, limit }) => {
        const qs = new URLSearchParams({ q: query, limit: String(limit ?? 25) });
        const r = await api("GET", `/api/v1/contacts?${qs}`);
        return r.ok ? text(r.data) : fail(r.error);
      },
    );
  }

  if (can("contacts:write")) {
    server.registerTool(
      "upload_contacts",
      {
        title: "Upload contacts",
        description:
          "Add or update people in the shared contact list so opens show names in Slack. member_id is Linked Helper's {memberId} (the h= value). Existing values are never overwritten with empty ones. Max 500 per call; for big Linked Helper CSV exports the Contacts page in the browser is faster.",
        inputSchema: {
          contacts: z
            .array(
              z.object({
                member_id: z.string().min(1).max(128),
                first_name: z.string().max(200).optional(),
                last_name: z.string().max(200).optional(),
                full_name: z.string().max(400).optional(),
                profile_url: z.string().max(1000).optional(),
                company: z.string().max(400).optional(),
                position: z.string().max(400).optional(),
                headline: z.string().max(1000).optional(),
              }),
            )
            .min(1)
            .max(500),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ contacts }) => {
        const r = await api("POST", "/api/v1/contacts", {
          contacts: contacts.map((c) => ({
            memberId: c.member_id,
            firstName: c.first_name ?? null,
            lastName: c.last_name ?? null,
            fullName: c.full_name ?? null,
            profileUrl: c.profile_url ?? null,
            company: c.company ?? null,
            position: c.position ?? null,
            headline: c.headline ?? null,
          })),
        });
        return r.ok ? text(r.data) : fail(r.error);
      },
    );
  }

  return server;
}

export const mcpHandler = {
  async fetch(request: Request, env: Env, execCtx: ExecutionContext): Promise<Response> {
    const ctx = execCtx as Ctx; // OAuthProvider sets props + auth on the context of apiHandler requests
    if (!isAllowedOrigin(env, request.headers.get("origin"))) {
      return new Response("Forbidden origin", { status: 403 });
    }
    const scopes = ctx.auth.scope.filter((s): s is Scope => ["links:read", "links:write", "contacts:read", "contacts:write"].includes(s));
    const server = buildServer(env, ctx.props, scopes);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};

