#!/usr/bin/env bash
# Usage: scripts/set-server-url.sh https://rollout-links-mcp.<your-subdomain>.workers.dev
# Points the Claude Code plugin and the Worker config at your deployed Worker.
set -euo pipefail
url="${1:?Usage: $0 https://your-worker-url (no trailing slash)}"
url="${url%/}"
[[ "$url" == https://* ]] || { echo "The URL must start with https://" >&2; exit 1; }
cd "$(dirname "$0")/.."
node -e '
const fs = require("fs");
const [url] = process.argv.slice(1);
const mcp = "plugins/rollout-links/.mcp.json";
const j = JSON.parse(fs.readFileSync(mcp, "utf8"));
j.mcpServers["rollout-links"].url = `${url}/mcp`;
fs.writeFileSync(mcp, JSON.stringify(j, null, 2) + "\n");
const w = "worker/wrangler.jsonc";
fs.writeFileSync(w, fs.readFileSync(w, "utf8").replace(/"PUBLIC_URL": "[^"]*"/, `"PUBLIC_URL": "${url}"`));
console.log(`MCP URL: ${url}/mcp`);
' "$url"
