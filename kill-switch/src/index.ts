import { CloudflareApi } from "./cloudflare";
import { estimateCost, monthToDate } from "./cost";

/** Must match "name" in wrangler.jsonc: the kill switch never disables itself. */
export const SELF = "cost-kill-switch";

export interface Env {
  /** KV namespace holding the single "state" key (what was disabled, so it can be restored). */
  STATE: KVNamespace;
  ACCOUNT_ID: string;
  /** Usage-based spend (USD, month to date) at or above which every other Worker is taken offline. */
  THRESHOLD_USD: string;
  /** "true": only log and notify what would be disabled. */
  DRY_RUN: string;
  /** Comma-separated Worker names never to disable. */
  EXCLUDE_SCRIPTS: string;
  /** Secret: API token with Account → Workers Scripts: Edit and Account → Account Analytics: Read. */
  CF_API_TOKEN: string;
  /** Optional secret: Slack incoming webhook URL. */
  SLACK_WEBHOOK_URL?: string;
}

export type DisabledScript = {
  script: string;
  /** workers.dev state before the kill switch turned it off. */
  subdomain: { enabled: boolean; previews_enabled: boolean };
  /** Cron triggers removed by the kill switch. */
  crons: string[];
};

export type State = {
  /** YYYY-MM the state was last evaluated for. */
  month: string;
  tripped: boolean;
  trippedAt?: string;
  costUsd?: number;
  /** Survives month changes: restoring is always manual (npm run restore). */
  disabled: DisabledScript[];
  /** Set by the restore script: don't trip again in this month. */
  snoozedMonth?: string;
  dryRunNotifiedMonth?: string;
};

const STATE_KEY = "state";

async function notify(env: Env, text: string) {
  console.log(text);
  if (!env.SLACK_WEBHOOK_URL) return;
  const res = await fetch(env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) console.error(`Slack webhook: ${res.status} ${await res.text()}`);
}

export async function run(env: Env, now: Date, api = new CloudflareApi(env.CF_API_TOKEN, env.ACCOUNT_ID)) {
  const { month, start, end } = monthToDate(now);
  const threshold = Number(env.THRESHOLD_USD);
  const dryRun = env.DRY_RUN !== "false";
  if (!Number.isFinite(threshold)) throw new Error(`THRESHOLD_USD is not a number: ${env.THRESHOLD_USD}`);

  const usage = await api.usage(start, end);
  const { total, lines } = estimateCost(usage);
  const state: State = (await env.STATE.get<State>(STATE_KEY, "json")) ?? { month, tripped: false, disabled: [] };
  state.month = month;
  console.log(JSON.stringify({ month, costUsd: total, threshold, dryRun, tripped: state.tripped, lines }));

  if (total < threshold) return { action: "ok" as const, total };
  if (state.tripped) return { action: "already-tripped" as const, total };
  if (state.snoozedMonth === month) return { action: "snoozed" as const, total };

  const exclude = new Set([SELF, ...env.EXCLUDE_SCRIPTS.split(",").map((s) => s.trim()).filter(Boolean)]);
  const targets = (await api.listScripts()).filter((s) => !exclude.has(s));
  const summary = `Cloudflare usage this month ≈ $${total.toFixed(2)} (threshold $${threshold})`;

  if (dryRun) {
    if (state.dryRunNotifiedMonth !== month) {
      await notify(env, `:warning: [DRY RUN] ${summary}. Would take offline: ${targets.join(", ") || "(none)"}`);
      state.dryRunNotifiedMonth = month;
    }
    await env.STATE.put(STATE_KEY, JSON.stringify(state));
    return { action: "dry-run" as const, total, targets };
  }

  state.tripped = true;
  state.trippedAt = now.toISOString();
  state.costUsd = total;
  const failures: string[] = [];
  for (const script of targets) {
    try {
      const subdomain = await api.getSubdomain(script);
      const crons = await api.getSchedules(script);
      if (subdomain.enabled || subdomain.previews_enabled) await api.setSubdomain(script, false, false);
      if (crons.length) await api.setSchedules(script, []);
      state.disabled = [...state.disabled.filter((d) => d.script !== script), { script, subdomain, crons }];
    } catch (err) {
      failures.push(`${script}: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Saved after every Worker so a crash halfway still leaves an exact restore list.
    await env.STATE.put(STATE_KEY, JSON.stringify(state));
  }

  await notify(
    env,
    `:rotating_light: KILL SWITCH TRIPPED. ${summary}. Took offline (workers.dev + crons): ` +
      `${state.disabled.map((d) => d.script).join(", ") || "(none)"}.` +
      (failures.length ? ` FAILED: ${failures.join("; ")}.` : "") +
      " Restore: cd kill-switch && npm run restore",
  );
  return { action: "tripped" as const, total, targets, failures };
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      run(env, new Date()).catch((err) =>
        notify(env, `:x: Cost kill switch failed to run: ${err instanceof Error ? err.message : String(err)}`),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
