#!/bin/bash
set -Eeuo pipefail

COZE_WORKSPACE_PATH="${COZE_WORKSPACE_PATH:-$(pwd)}"

DEPLOY_RUN_PORT="${DEPLOY_RUN_PORT:-${PORT:-5000}}"
export PORT="$DEPLOY_RUN_PORT"

cd "$COZE_WORKSPACE_PATH"

# 部署构建日志 dump：deploy build 阶段写入 ./deploy-build.log（无论成败都会留下），
# 这里 tail 到 stdout，让构建日志进入运行时日志通道（供 search_runtime_log 检索）。
if [ -f ./deploy-build.log ]; then
  echo "===== DEPLOY BUILD LOG BEGIN ====="
  tail -n 200 ./deploy-build.log || true
  echo "===== DEPLOY BUILD LOG END ====="
else
  echo "(no deploy-build.log found in $(pwd))"
fi

echo "--- workspace artifacts ---"
ls -la dist dist-server 2>&1 || true

echo "Starting Echo Room (Fastify) production server on port ${DEPLOY_RUN_PORT}..."
# tsup 输出为 dist-server/server/server.js（保留 server/ 目录结构）
node dist-server/server/server.js 2>&1 | tee ./deploy-run.log