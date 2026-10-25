/**
 * Workers Paid list prices (https://developers.cloudflare.com/workers/platform/pricing/, checked 2026-10-25).
 * Only usage above the monthly allowance is billed; the $5 base fee is not counted here.
 * Workers Logs moves to Cloudflare Observability pricing on 2026-12-01: update LOG_EVENT then.
 */
export const PRICES = {
  requests: { included: 10_000_000, perMillion: 0.3 },
  cpuMs: { included: 30_000_000, perMillion: 0.02 },
  kvRead: { included: 10_000_000, perMillion: 0.5 },
  kvWrite: { included: 1_000_000, perMillion: 5 },
  kvDelete: { included: 1_000_000, perMillion: 5 },
  kvList: { included: 1_000_000, perMillion: 5 },
  /** Approximated as one event per invocation (a lower bound: console.log lines add more). */
  logEvents: { included: 20_000_000, perMillion: 0.6 },
  kvStorageGb: { included: 1, perUnit: 0.5 },
} as const;

export type Usage = {
  requests: number;
  cpuMs: number;
  kvRead: number;
  kvWrite: number;
  kvDelete: number;
  kvList: number;
  logEvents: number;
  kvStorageGb: number;
};

export type CostLine = { item: keyof Usage; quantity: number; usd: number };

const overage = (quantity: number, included: number) => Math.max(0, quantity - included);

/** Estimated usage-based charges for the month so far, per item and in total (USD). */
export function estimateCost(usage: Usage): { total: number; lines: CostLine[] } {
  const lines: CostLine[] = (Object.keys(PRICES) as (keyof Usage)[]).map((item) => {
    const price = PRICES[item];
    const extra = overage(usage[item], price.included);
    const usd = "perMillion" in price ? (extra / 1_000_000) * price.perMillion : extra * price.perUnit;
    return { item, quantity: usage[item], usd };
  });
  const total = lines.reduce((sum, l) => sum + l.usd, 0);
  return { total, lines };
}

/** First day of the current UTC month and today, as GraphQL Date strings. */
export function monthToDate(now: Date): { month: string; start: string; end: string } {
  const iso = now.toISOString();
  return { month: iso.slice(0, 7), start: `${iso.slice(0, 7)}-01`, end: iso.slice(0, 10) };
}
