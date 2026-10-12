#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> Building frontend (vite -> dist/)"
pnpm vite build

echo "==> Building server + vault CLI (tsup -> dist-server/)"
pnpm tsup server/server.ts scripts/vault-cli.ts \
  --format cjs --platform node --target node20 \
  --outDir dist-server --no-splitting --no-minify \
  --external vite

echo "Build complete: dist/ + dist-server/"
