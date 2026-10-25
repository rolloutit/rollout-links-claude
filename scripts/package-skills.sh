#!/usr/bin/env bash
# Builds one zip per skill (dist/<skill>.zip) for claude.ai → Settings → Capabilities → Skills → Upload.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist && mkdir -p dist
for dir in plugins/rollout-links/skills/*/; do
  name=$(basename "$dir")
  (cd plugins/rollout-links/skills && zip -qr "../../../dist/${name}.zip" "$name")
  echo "dist/${name}.zip"
done
