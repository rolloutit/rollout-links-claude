#!/usr/bin/env node
// Brings back every Worker the kill switch took offline (workers.dev + cron triggers) and snoozes the kill
// switch for the rest of the month. Uses CLOUDFLARE_API_TOKEN if set, otherwise your `wrangler login`.
//   npm run restore            # do it
//   npm run restore -- --show  # only print the saved state
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const wrangler = (...args) =>
  execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const accountId = config.match(/"ACCOUNT_ID":\s*"([0-9a-f]+)"/)[1];
const token = process.env.CLOUDFLARE_API_TOKEN || wrangler("auth", "token").split("\n").pop();

const raw = wrangler("kv", "key", "get", "--binding", "STATE", "--remote", "state");
const state = raw && raw !== "Value not found" ? JSON.parse(raw) : null;
console.log(JSON.stringify(state, null, 2));
if (process.argv.includes("--show")) process.exit(0);
if (!state) {
  console.log("No saved state: nothing to restore.");
  process.exit(0);
}

async function api(method, path, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body && JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.success) throw new Error(`${method} ${path}: ${JSON.stringify(json.errors)}`);
}

const failed = [];
for (const { script, subdomain, crons } of state.disabled) {
  try {
    await api("POST", `${encodeURIComponent(script)}/subdomain`, subdomain);
    if (crons.length) await api("PUT", `${encodeURIComponent(script)}/schedules`, crons.map((cron) => ({ cron })));
    console.log(`restored ${script}`);
  } catch (err) {
    console.error(`FAILED ${script}: ${err.message}`);
    failed.push(state.disabled.find((d) => d.script === script));
  }
}

const month = new Date().toISOString().slice(0, 7);
const next = { ...state, month, tripped: failed.length > 0, disabled: failed, snoozedMonth: month };
wrangler("kv", "key", "put", "--binding", "STATE", "--remote", "state", JSON.stringify(next));
console.log(failed.length ? "Some Workers failed, run again." : `Done. Kill switch snoozed until the end of ${month}.`);
