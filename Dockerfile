# syntax=docker/dockerfile:1
# ---- 构建阶段：前端静态产物 + 后端编译产物 + CLI ----
FROM node:24-bookworm-slim AS builder
WORKDIR /app
RUN corepack enable
# 优先复制依赖清单以利用层缓存
COPY package.json pnpm-lock.yaml .npmrc* ./
RUN pnpm install --frozen-lockfile
COPY . .
# 前端 vite build -> dist/；后端 tsup -> dist-server/server/server.js；保险库 CLI -> dist-server/scripts/vault-cli.js
RUN pnpm run build

# ---- 运行阶段 ----
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV COZE_PROJECT_ENV=PROD
# 非 root 运行
RUN useradd -m -u 10001 echo && mkdir -p /app/.data && chown -R echo:echo /app
USER echo
# 仅拷贝生产所需文件
COPY --from=builder --chown=echo:echo /app/node_modules ./node_modules
COPY --from=builder --chown=echo:echo /app/package.json ./package.json
COPY --from=builder --chown=echo:echo /app/dist ./dist
COPY --from=builder --chown=echo:echo /app/dist-server ./dist-server
COPY --from=builder --chown=echo:echo /app/scripts ./scripts
EXPOSE 5000
# 容器健康检查：命中无需 DB 的 OIDC 配置接口
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/auth/oidc/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# tsup 保留入口目录结构，产物是 dist-server/server/server.js（不是 dist-server/server.js）
CMD ["node", "dist-server/server/server.js"]
