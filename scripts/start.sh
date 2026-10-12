#!/bin/bash
set -Eeuo pipefail

COZE_WORKSPACE_PATH="${COZE_WORKSPACE_PATH:-$(pwd)}"

DEPLOY_RUN_PORT="${DEPLOY_RUN_PORT:-${PORT:-5000}}"
export PORT="$DEPLOY_RUN_PORT"

cd "$COZE_WORKSPACE_PATH"
echo "Starting Echo Room (Fastify) production server on port ${DEPLOY_RUN_PORT}..."
exec node dist-server/server.js
