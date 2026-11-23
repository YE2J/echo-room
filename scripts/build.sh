#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# 部署流水线可能跳过 devDependencies 或携带陈旧 node_modules，
# 检测到构建工具缺失时自愈补装（vite/tsup 已在 dependencies，含其 esbuild 传递依赖）
if [ ! -x node_modules/.bin/vite ] || [ ! -x node_modules/.bin/tsup ]; then
  echo "==> Build tools missing (vite/tsup), running pnpm install --frozen-lockfile"
  pnpm install --frozen-lockfile
fi

echo "==> Building frontend (vite -> dist/)"
pnpm vite build

echo "==> Building server + vault CLI (tsup -> dist-server/)"
pnpm tsup server/server.ts scripts/vault-cli.ts \
  --format cjs --platform node --target node20 \
  --outDir dist-server --no-splitting --no-minify \
  --external vite

echo "Build complete: dist/ + dist-server/"
