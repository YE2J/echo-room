#!/bin/bash
# 本地开发启动（供不在扣子平台上的人使用，例如直接 clone 本仓库的开发者）。
# 与 scripts/dev.sh 的区别：不引用任何 COZE_* 变量、不 spawn detached 进程、
# 不清理端口、不设 watchdog，直接前台运行 tsx watch，Ctrl+C 自然退出。
# 扣子平台内开发请继续使用 `pnpm dev`。
set -Eeuo pipefail

# 解析仓库根（以本脚本位置为基准，不写死路径）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${PROJECT_ROOT}"

# 端口：PORT 环境变量可覆盖，默认 5000
PORT="${PORT:-5000}"

echo "[dev-local] echo-room 本地开发启动 @ http://127.0.0.1:${PORT}"
echo "[dev-local] PGlite 数据目录（.data/）如不存在会自动创建"
echo "[dev-local] Ctrl+C 停止（前台运行，无 watchdog）"

# 直接前台执行，Ctrl+C 信号直达 tsx watch
exec pnpm exec tsx watch server/server.ts