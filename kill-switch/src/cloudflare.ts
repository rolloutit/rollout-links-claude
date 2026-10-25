import type { Usage } from "./cost";

const API = "https://api.cloudflare.com/client/v4";

type ApiResponse<T> = { success: boolean; errors: { code: number; message: string }[]; result: T };

export class CloudflareApi {
  constructor(
    private readonly token: string,
    private readonly accountId: string,
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", ...init.headers },
    });
    const body = (await res.json()) as ApiResponse<T>;
    if (!res.ok || !body.success) {
      throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${JSON.stringify(body.errors)}`);
    }
    return body.result;
  }

  private script = (name: string) => `/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(name)}`;

  async listScripts(): Promise<string[]> {
    const scripts = await this.call<{ id: string }[]>(`/accounts/${this.accountId}/workers/scripts`);
    return scripts.map((s) => s.id);
  }

  getSubdomain(name: string) {
    return this.call<{ enabled: boolean; previews_enabled: boolean }>(`${this.script(name)}/subdomain`);
  }

  setSubdomain(name: string, enabled: boolean, previewsEnabled: boolean) {
    return this.call(`${this.script(name)}/subdomain`, {
      method: "POST",
      body: JSON.stringify({ enabled, previews_enabled: previewsEnabled }),
    });
  }

  async getSchedules(name: string): Promise<string[]> {
    const { schedules } = await this.call<{ schedules: { cron: string }[] }>(`${this.script(name)}/schedules`);
    return schedules.map((s) => s.cron);
  }

  setSchedules(name: string, crons: string[]) {
    return this.call(`${this.script(name)}/schedules`, {
      method: "PUT",
      body: JSON.stringify(crons.map((cron) => ({ cron }))),
    });
  }

  /** Account-wide Workers and KV usage between two dates (inclusive) from GraphQL Analytics. */
  async usage(start: string, end: string): Promise<Usage> {
    const query = `query ($account: String!, $start: Date!, $end: Date!) {
      viewer { accounts(filter: { accountTag: $account }) {
        workers: workersInvocationsAdaptive(limit: 10000, filter: { date_geq: $start, date_leq: $end }) {
          sum { requests cpuTimeUs }
        }
        kvOps: kvOperationsAdaptiveGroups(limit: 10000, filter: { date_geq: $start, date_leq: $end }) {
          sum { requests } dimensions { actionType }
        }
        kvStorage: kvStorageAdaptiveGroups(limit: 10000, filter: { date_geq: $start, date_leq: $end }) {
          max { byteCount } dimensions { namespaceId }
        }
      } }
    }`;
    const res = await fetch(`${API}/graphql`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables: { account: this.accountId, start, end } }),
    });
    const body = (await res.json()) as {
      data?: {
        viewer: {
          accounts: {
            workers: { sum: { requests: number; cpuTimeUs: number } }[];
            kvOps: { sum: { requests: number }; dimensions: { actionType: string } }[];
            kvStorage: { max: { byteCount: number }; dimensions: { namespaceId: string } }[];
          }[];
        };
      };
      errors?: { message: string }[] | null;
    };
    const account = body.data?.viewer.accounts[0];
    if (!res.ok || body.errors?.length || !account) {
      throw new Error(`GraphQL: ${res.status} ${JSON.stringify(body.errors)}`);
    }

    const requests = account.workers.reduce((n, w) => n + w.sum.requests, 0);
    const cpuMs = account.workers.reduce((n, w) => n + w.sum.cpuTimeUs, 0) / 1000;
    const kv = (action: string) =>
      account.kvOps.filter((k) => k.dimensions.actionType === action).reduce((n, k) => n + k.sum.requests, 0);
    const bytesPerNamespace = new Map<string, number>();
    for (const s of account.kvStorage) {
      const id = s.dimensions.namespaceId;
      bytesPerNamespace.set(id, Math.max(bytesPerNamespace.get(id) ?? 0, s.max.byteCount));
    }
    const kvBytes = [...bytesPerNamespace.values()].reduce((n, b) => n + b, 0);

    return {
      requests,
      cpuMs,
      kvRead: kv("read"),
      kvWrite: kv("write"),
      kvDelete: kv("delete"),
      kvList: kv("list"),
      logEvents: requests,
      kvStorageGb: kvBytes / 1e9,
    };
  }
}
