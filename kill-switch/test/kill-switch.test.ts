import { describe, expect, it } from "vitest";
import type { CloudflareApi } from "../src/cloudflare";
import { estimateCost, monthToDate, type Usage } from "../src/cost";
import { run, SELF, type Env, type State } from "../src/index";

const idle: Usage = {
  requests: 1000,
  cpuMs: 5000,
  kvRead: 0,
  kvWrite: 0,
  kvDelete: 0,
  kvList: 0,
  logEvents: 1000,
  kvStorageGb: 0.001,
};

describe("estimateCost", () => {
  it("is zero inside the Workers Paid allowances", () => {
    expect(estimateCost(idle).total).toBe(0);
  });

  it("bills only the overage", () => {
    const { total, lines } = estimateCost({ ...idle, requests: 20_000_000, logEvents: 20_000_000, kvWrite: 3_000_000 });
    expect(lines.find((l) => l.item === "requests")!.usd).toBeCloseTo(3); // 10M extra × $0.30
    expect(lines.find((l) => l.item === "kvWrite")!.usd).toBeCloseTo(10); // 2M extra × $5
    expect(total).toBeCloseTo(13);
  });
});

it("monthToDate covers the current UTC month", () => {
  expect(monthToDate(new Date("2026-10-25T13:00:00Z"))).toEqual({ month: "2026-10", start: "2026-10-01", end: "2026-10-25" });
});

function fakes(usage: Usage, initial?: State) {
  const kv = new Map<string, string>();
  if (initial) kv.set("state", JSON.stringify(initial));
  const subdomains = new Map([
    ["quick-mcp", { enabled: true, previews_enabled: true }],
    ["rollout-links-mcp", { enabled: true, previews_enabled: false }],
    [SELF, { enabled: false, previews_enabled: false }],
  ]);
  const schedules = new Map<string, string[]>([["quick-mcp", ["*/5 * * * *"]]]);
  const api = {
    usage: async () => usage,
    listScripts: async () => [...subdomains.keys()],
    getSubdomain: async (s: string) => ({ ...subdomains.get(s)! }),
    setSubdomain: async (s: string, enabled: boolean, previews_enabled: boolean) => {
      subdomains.set(s, { enabled, previews_enabled });
    },
    getSchedules: async (s: string) => schedules.get(s) ?? [],
    setSchedules: async (s: string, crons: string[]) => {
      schedules.set(s, crons);
    },
  } as unknown as CloudflareApi;
  const env = (vars: Partial<Env>): Env => ({
    STATE: {
      get: async (k: string) => (kv.has(k) ? JSON.parse(kv.get(k)!) : null),
      put: async (k: string, v: string) => void kv.set(k, v),
    } as unknown as KVNamespace,
    ACCOUNT_ID: "acc",
    THRESHOLD_USD: "100",
    DRY_RUN: "true",
    EXCLUDE_SCRIPTS: "",
    CF_API_TOKEN: "t",
    ...vars,
  });
  const state = () => JSON.parse(kv.get("state")!) as State;
  return { api, env, subdomains, schedules, state };
}

const expensive: Usage = { ...idle, requests: 400_000_000 }; // ≈ $117 requests + $228 logs
const now = new Date("2026-10-25T13:00:00Z");

describe("run", () => {
  it("does nothing below the threshold", async () => {
    const f = fakes(idle);
    expect((await run(f.env({ DRY_RUN: "false" }), now, f.api)).action).toBe("ok");
    expect(f.subdomains.get("quick-mcp")!.enabled).toBe(true);
  });

  it("dry run only reports, once per month", async () => {
    const f = fakes(expensive);
    const res = await run(f.env({}), now, f.api);
    expect(res).toMatchObject({ action: "dry-run", targets: ["quick-mcp", "rollout-links-mcp"] });
    expect(f.subdomains.get("quick-mcp")!.enabled).toBe(true);
    expect(f.state().dryRunNotifiedMonth).toBe("2026-10");
  });

  it("takes every other Worker offline and records how to restore it", async () => {
    const f = fakes(expensive);
    const res = await run(f.env({ DRY_RUN: "false", EXCLUDE_SCRIPTS: "rollout-links-mcp" }), now, f.api);
    expect(res.action).toBe("tripped");
    expect(f.subdomains.get("quick-mcp")).toEqual({ enabled: false, previews_enabled: false });
    expect(f.schedules.get("quick-mcp")).toEqual([]);
    expect(f.subdomains.get("rollout-links-mcp")!.enabled).toBe(true);
    expect(f.state()).toMatchObject({
      tripped: true,
      disabled: [{ script: "quick-mcp", subdomain: { enabled: true, previews_enabled: true }, crons: ["*/5 * * * *"] }],
    });
    expect((await run(f.env({ DRY_RUN: "false" }), now, f.api)).action).toBe("already-tripped");
  });

  it("respects a manual restore for the rest of the month", async () => {
    const f = fakes(expensive, { month: "2026-10", tripped: false, disabled: [], snoozedMonth: "2026-10" });
    expect((await run(f.env({ DRY_RUN: "false" }), now, f.api)).action).toBe("snoozed");
    expect((await run(f.env({ DRY_RUN: "false" }), new Date("2026-11-01T00:00:00Z"), f.api)).action).toBe("tripped");
  });
});
