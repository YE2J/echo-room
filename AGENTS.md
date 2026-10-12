# AGENTS.md — 匿名回音 Echo Room

开源匿名聊天室（企业内部意见收集与问题举报）MVP。登录准入 → 签发匿名昵称 → WebSocket 公共聊天室 → 消息经 LLM 语气归一化 → AES-256-GCM 密文落库 → 身份映射整表加密 + Shamir(K/N) 密钥分割。

## 技术栈

- 前端：Vite 7 + TypeScript（原生 TS + CSS，无框架），构建到 `dist/`
- 后端：Node.js 24 + Fastify 5 + TypeScript（`tsx` 开发运行，`tsc` 编译到 `dist-server/`）
- 实时：`ws`（noServer 模式挂到 Fastify 的 http.Server），端点 `/ws/chat`
- 数据库：PostgreSQL（生产）/ PGlite WASM（无 PG 时的开发兜底，数据落 `.data/pglite/`）
- 消息总线/限流：Redis（生产，ioredis）/ 进程内 EventEmitter（开发兜底）
- LLM：OpenAI 兼容接口或 Ollama（可开关，失败策略可配置）

## 目录结构

```
├── index.html               # Vite 入口
├── vite.config.ts           # Vite 配置（middleware 模式由后端接管，HMR 6000 /hot/vite-hmr）
├── src/                     # 前端源码
│   ├── index.ts             # 入口（引导 styles.css + main.ts）
│   ├── styles.css           # 全局样式与 Design Tokens
│   ├── main.ts              # 启动与登录态路由（auth/chat/admin 视图切换）
│   ├── session.ts           # 会话存储（cookie 登录态 + wsToken）
│   ├── api.ts               # HTTP API 封装
│   ├── ws.ts                # WebSocket 客户端（首帧 auth + 心跳 + 自动重连）
│   ├── components.ts        # 无框架 DOM 组件工具（一律 textContent，防 XSS）
│   └── pages/{auth,chat,admin}.ts  # 登录注册 / 聊天室 / 管理台
├── server/
│   ├── server.ts            # Fastify 入口（HTTP + WS upgrade + Vite/静态托管）
│   ├── config.ts            # 环境变量集中解析
│   ├── db.ts                # PG / PGlite 适配层 + 建表
│   ├── bus.ts               # Redis / 进程内 PubSub 适配层
│   ├── crypto/
│   │   ├── aesgcm.ts        # AES-256-GCM 消息加解密
│   │   ├── shamir.ts        # GF(256) Shamir 密钥分割/恢复
│   │   ├── passwords.ts     # scrypt 密码哈希
│   │   └── token.ts         # HS256 JWT（node:crypto）
│   ├── services/
│   │   ├── auth.ts          # 注册/登录/邀请码校验
│   │   ├── vault.ts         # 身份保险库（整表加密 + master key 封存/解封）
│   │   ├── alias.ts         # 匿名昵称生成与确定性头像色
│   │   ├── messages.ts      # 消息存储/历史
│   │   ├── rewriter.ts      # LLM 语气归一化
│   │   ├── rate-limit.ts    # 令牌桶限流（Redis 或内存）
│   │   ├── audit.ts         # 审计日志（尽力而为，不抛错）
│   │   └── settings.ts      # 运行时配置（改写开关等）
│   ├── routes/              # HTTP 路由（auth/chat/admin/oidc）
│   └── ws/{index,registry,chat}.ts  # /ws/chat 端点（noServer，首帧 auth）
├── scripts/vault-cli.ts     # 保险库初始化/解封/邀请码 CLI（tsx 运行）
├── scripts/{build,start,dev,prepare}.sh
├── Dockerfile               # 多阶段构建（vite build + tsc）
├── docs/{DEPLOYMENT,SECURITY_BASELINE}.md
└── docker-compose.yml       # app + postgres + redis + ollama(profile)
```

## 常用命令

- 安装依赖：`pnpm install`
- 开发：`pnpm dev`（脚本以 `tsx watch server/server.ts` 启动；Vite middleware 内嵌，单端口 `${DEPLOY_RUN_PORT:-5000}`，HMR 6000）
- 生产构建：`pnpm build`（= `scripts/build.sh`：前端 vite build → 后端 tsc 到 dist-server）
- 生产启动：`pnpm start`（= `node dist-server/server/server.js`）
- 类型检查：`pnpm ts-check`（前端 + 后端双 tsconfig 都要过）
- Lint：`pnpm lint`（ESLint），样式 `pnpm lint:style`
- 保险库 CLI：`npx tsx scripts/vault-cli.ts init|unseal|sealed|invite`

## 关键配置（环境变量，见 .env.example）

- `DATABASE_URL`：生产必填；未设置时开发态自动用 PGlite（`.data/`）
- `REDIS_URL`：多实例部署必填；未设置用进程内总线
- `JWT_SECRET`：生产必填（开发态自动生成并持久化到 `.data/dev-secrets.json`）
- `MESSAGE_ENCRYPTION_KEY`：消息 AES-256-GCM 密钥（base64 32B）；未设置时由 JWT_SECRET 派生（生产建议显式设置）
- `VAULT_K` / `VAULT_N`：Shamir 门限（默认 2/3）；`VAULT_AUTO_UNSEAL_SHARES` 仅供开发/单管理员环境
- `LLM_NORMALIZE_ENABLED`、`LLM_PROVIDER`（`openai`|`ollama`|`off`）、`LLM_*` 连接参数、`LLM_ON_FAILURE`（`passthrough`|`reject`）
- `ADMIN_USERNAMES`：管理员用户名逗号分隔（可 unseal/签发邀请码）
- `BOOTSTRAP_INVITE_CODES`：启动时自动注入的邀请码（默认含 `CN-INVITE`）

## 代码规范

- TypeScript strict；禁止隐式 any / `as any`；函数参数、Fastify req/reply、catch error 需明确类型或收窄。
- 标点半角；不允许未使用的导入/变量（ESLint recommended + import/no-cycle）。
- 前端渲染用户内容**必须**用 `textContent`（防 XSS），严禁 `innerHTML` 拼接服务端/用户数据。
- 安全红线：真实身份（username/userId/email）绝不出现在 WS 广播 payload、消息表可读列、前端界面；映射只存于加密保险库。
- 日志不得输出明文密码、token、密钥分片、消息原文。

## 测试说明

- 沙箱无 Docker/PG/Redis，使用 PGlite + 内存总线开发自测；生产路径通过 docker-compose 验证。
- 接口冒烟测试覆盖 `/api/auth/*`、`/api/chat/history`、`/api/admin/*`、`/ws/chat`。
