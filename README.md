# 匿名回音 · Echo Room

> 企业内部**匿名意见收集与问题举报**聊天室：实名准入、匿名发声、平时无法溯源、追责需门限授权。
> 自托管、可审计、全开源（MIT）。

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![node](https://img.shields.io/badge/node-24-brightgreen.svg)
![ci](https://github.com/YE2J/echo-room/actions/workflows/ci.yml/badge.svg)

**当前版本 v0.5.0（M5 匿名性改造已完成，已上线运行）** · [变更记录](CHANGELOG.md)

---

## 1. 它解决什么问题

传统意见箱要么"完全匿名"导致无法对恶意内容负责，要么"实名发言"导致没人敢说真话。
Echo Room 用**密码学隔离**把两者拆开：

| 阶段 | 谁看得见什么 |
| --- | --- |
| 准入 | 只有持有效邀请码的内部员工能注册登录（scrypt 密码哈希） |
| 使用 | 系统签发随机匿名昵称 + 确定性头像；聊天界面、历史消息、WebSocket 广播里**永不出现**真实身份 |
| 存储 | 消息原文 AES-256-GCM 密文入库，接口只返回**语气归一化后**的文本 |
| 治理 | 管理后台看不到昵称，只看到不可逆短引用 `ref` 与粗化时间（`dateKey` + `timeSlot`）；审计里管理员只显示 `admin#N` |
| 追责 | `user ↔ alias` 映射整表加密，主密钥 Shamir K/N 分割、运行态默认封存；需 ≥K 份分片**现场重组** + 事由 + 审计才可反查 |

## 2. 功能清单（v0.5）

| 模块 | 能力 |
| --- | --- |
| 认证准入 | 邀请码 + 本地账号（scrypt）；HttpOnly Cookie JWT + 短期 WS Token；OIDC 授权码流程（默认关闭） |
| 匿名身份 | 注册即随机中文匿名词 + 混淆码 + 确定性色相/几何头像（SHA-256 派生，前后端一致） |
| 多聊天室 | 公共/私有房间、成员管理、未读与在线人数、房间申请审批、归档/恢复/彻底删除（级联清理） |
| 实时聊天 | 单端口 `/ws/chat`（首帧鉴权、30s 心跳、自动重连、乐观发送 + ack、令牌桶限流）、Redis Pub/Sub 跨实例扇出 |
| 语气归一化 | 广播前抹平口头禅/标点/句式指纹；provider 支持 `openai`（任意 OpenAI 兼容）/ `ollama` / `coze`（扣子智能体）/ `off`；未配模型时走确定性本地规则 |
| 加密存储 | 原文 AES-256-GCM（含 IV/tag）落库；库中只有密文 + 归一化文本 |
| 身份保险库 | 映射整表加密（HMAC 盲索引 + AES）；Shamir GF(256) K/N；启动默认封存，break-glass 解封/再封存；分片门限 reveal 用后即焚 |
| 匿名治理 | `admin#N` 与短引用脱敏（`server/services/privacy.ts`）、存量审计幂等迁移、内容管理页无昵称列 |
| 溯源审批 | 申请→多人审批→达门限才解密；审批人显示 `审批人#N`，全程审计 |
| LLM 运维 | 管理后台配置 provider/base_url/model/key（key 加密入库，接口只回掩码）、连通性自检、用量统计 |
| 运维 | Docker Compose（app + postgres + redis + 可选 ollama）、多阶段镜像、非 root、健康检查、生产 fail-fast |

## 3. 技术架构

```
┌──────────────┐  HTTPS + WSS
│  Vite + TS   │  /ws/chat（首帧 auth 携带 WS Token）
│  （无框架）   │  /api/*（HttpOnly Cookie JWT）
└──────┬───────┘
┌──────▼──────────────────────────────────────────────┐
│              Node.js + Fastify 5 + TypeScript        │
│  auth │ chat │ rooms │ admin │ trace │ health │ oidc │
│  WS gateway（ws noServer，与 HTTP 共用单端口）        │
│  ┌──────────┐ ┌────────────┐ ┌───────────┐ ┌───────┐ │
│  │ Rewriter │ │IdentityVault│ │RateLimiter│ │Privacy│ │
│  │LLM/本地  │ │AES-GCM+Shamir│ │Redis/内存 │ │脱敏   │ │
│  └──────────┘ └─────┬───────┘ └───────────┘ └───────┘ │
└──────────┬──────────┼──────────────┬─────────────────┘
   ┌───────▼────┐ ┌───▼──────┐ ┌─────▼────────┐
   │ PostgreSQL │ │(仅解封时  │ │ Redis Pub/Sub│
   │ 密文/审计   │ │ 内存主密钥)│ │ 跨实例扇出    │
   └────────────┘ └──────────┘ └──────────────┘
```

- **前端**：Vite + 原生 TypeScript（无 UI 框架，CSS 变量设计系统）；所有用户/服务端数据走 `textContent`，仅内置静态图标允许 SVG。
- **后端**：Fastify 5 + TS strict；`ws` noServer 模式与 HTTP 共用端口。
- **数据库**：PostgreSQL 16（时间统一 BIGINT 毫秒）；无 `DATABASE_URL` 时开发/评估态回退 PGlite(WASM)。
- **实时**：Redis Pub/Sub；无 Redis 时降级为进程内 EventBus（仅单实例）。

> ⚠️ PGlite 与内存总线只适合本地/评估；生产请用 docker-compose 里的 PostgreSQL + Redis。

## 4. 快速开始

### 方式 A：Docker Compose（推荐）

```bash
cp .env.example .env
# 必改：JWT_SECRET / MESSAGE_ENCRYPTION_KEY / ADMIN_USERNAMES / BOOTSTRAP_INVITE_CODES
openssl rand -base64 32   # MESSAGE_ENCRYPTION_KEY
openssl rand -base64 48   # JWT_SECRET

docker compose up -d --build
# 打开 http://localhost:5000
```

首次启动保险库处于**封存**状态：默认 `VAULT_AUTO_BOOTSTRAP=false`，需要显式引导（分片只打印一次，
请离线分发给不同持有人）。引导与解封流程见 [部署文档](docs/DEPLOYMENT.md)。
PoC 想启动即解封：把 ≥K 个分片填进 `VAULT_AUTO_UNSEAL_SHARES`（**不要用于生产**）。

需要本地大模型：

```bash
docker compose --profile ollama up -d --build
docker compose exec ollama ollama pull qwen2.5:7b   # 然后 LLM_PROVIDER=ollama
```

### 方式 B：本地开发（PGlite，无需 Docker）

```bash
pnpm install
pnpm dev     # tsx watch + Vite middleware，:5000
```

开发态会在 `.data/` 自动生成密钥、自动初始化并解封保险库、分片写入 `.data/dev-vault-shares.json`
（仅开发态）。邀请码不再有内置默认值：请自行在 `.env` 设置 `BOOTSTRAP_INVITE_CODES`（例如 `DEV-$(openssl rand -hex 4)`），
或先把某个用户名加入 `ADMIN_USERNAMES` 后由后台签发。

```bash
pnpm build   # dist/（前端）+ dist-server/（server/server.js、scripts/vault-cli.js）
pnpm start   # bash scripts/start.sh → node dist-server/server/server.js
pnpm validate  # tsc + eslint + stylelint
```

## 5. 关键环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `JWT_SECRET` | — | 生产必填；`.env.example` 的占位值会被识别并拒绝加载配置 |
| `MESSAGE_ENCRYPTION_KEY` | — | base64 编码 32 字节（AES-256）；同样拒绝占位值 |
| （密钥降级） | — | 平台要求端口必须监听，所以配置非法时服务**仍会启动**，但改用临时随机密钥：`/api/health` 返回 `secretSource:"ephemeral"`，日志打 `FATAL-DEGRADED`。此时重启后旧密文永久不可解——**看到 ephemeral 必须立刻修配置并重建数据** |
| `ADMIN_USERNAMES` | 空 | 逗号分隔的管理员用户名（大小写不敏感）；只有这里或 `users.is_admin` 的人能进后台 |
| `BOOTSTRAP_INVITE_CODES` | 空 | 启动时写入的引导邀请码（**无内置默认值**，由部署方自行生成）；上线后请轮换并清空 |
| `VAULT_K` / `VAULT_N` | 2 / 3 | Shamir 门限 |
| `VAULT_AUTO_BOOTSTRAP` | `false` | 首次启动是否自动建库并打印分片（生产保持 false） |
| `VAULT_AUTO_UNSEAL_SHARES` | 空 | 启动即解封（仅 PoC） |
| `LLM_PROVIDER` | `off` | `off` / `openai` / `ollama` / `coze` |
| `LLM_OPENAI_BASE_URL` | `https://api.openai.com/v1` | 任意 OpenAI 兼容网关（代码拼 `/chat/completions`） |
| `LLM_OPENAI_API_KEY` / `LLM_OPENAI_MODEL` | 空 / `gpt-4o-mini` | key 为空时仅允许 localhost 网关 |
| `LLM_COZE_API_URL` / `LLM_COZE_API_TOKEN` | 空 / 空 | 你自己的扣子改写智能体域名与 token（**仓库不提供默认域名**） |
| `LLM_ON_FAILURE` | `passthrough` | 失败策略：`passthrough`（放行原文，保可用）/ `reject`（拒绝发送，保匿名强度） |
| `HEALTH_DIAG_TOKEN` | 空 | 设置后 `/api/health/diag` 需带 `x-diag-token`；生产未设置时该接口 404 |

完整列表见 [.env.example](.env.example) 与 [部署文档](docs/DEPLOYMENT.md)。

## 6. 一分钟体验

1. 用邀请码注册 `alice` → 得到随机昵称（如"隐于市的松貂-17CD"）。
2. 无痕窗口注册 `bob`，两人互发消息：界面只有昵称与色相。
3. 把 `alice` 加入 `ADMIN_USERNAMES` 并重启，`alice` 再登录即管理员：
   - 保险库状态/封存/解封、邀请码签发、归一化开关、LLM 配置；
   - 内容管理：只看到 `ref` + 日期 + 上午/下午/夜间，没有昵称；
   - 溯源审批：发起申请 → 他人审批 → 凑齐 K 份分片才解密，审批人显示 `审批人#N`。

## 7. API 概览

| 分组 | 端点 |
| --- | --- |
| 健康 | `GET /api/health`、`GET /api/health/diag`（生产需 `HEALTH_DIAG_TOKEN`） |
| 认证 | `POST /api/auth/register`、`POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/me`、`GET /api/auth/oidc/{config,authorize,callback}` |
| 聊天室 | `GET /api/rooms`、`PUT /api/rooms/:id`、`GET /api/rooms/:id/members`、`POST /api/rooms/requests`、`GET /api/chat/history` |
| 实时 | `WS /ws/chat`（首帧 `{"type":"auth","payload":{"token":"<JWT>"}}`） |
| 管理·保险库 | `GET /api/admin/vault/status`、`POST /api/admin/vault/{unseal,seal,break-glass-unseal}` |
| 管理·内容 | `GET /api/admin/messages`、`DELETE /api/admin/messages/:id`、`POST /api/admin/aliases/:alias/{ban,unban}` |
| 管理·房间 | `GET /api/admin/rooms`、`POST .../archive`、`POST .../restore`、`DELETE /api/admin/rooms/:id`、`GET /api/admin/room-requests`、`POST .../{approve,reject}` |
| 管理·溯源 | `POST /api/admin/trace-requests`、`GET .../:id`、`POST .../{approve,reject,close}`、`POST /api/admin/reveal` |
| 管理·系统 | `GET /api/admin/audit`、`GET/POST /api/admin/invites`、`GET/PUT /api/admin/rewrite`、`GET /api/admin/llm/{config,usage}`、`POST /api/admin/llm/test` |

WebSocket 信封固定为 `{ "type": string, "payload": unknown }`：

- 客户端 → 服务端：`auth`（首帧必须）、`chat:send`、`ping`
- 服务端 → 客户端：`auth:ok`、`chat:ack`、`chat:message`、`presence`、`error`、`pong`

## 8. 目录结构

```
server/        后端：routes / services / crypto / ws / db / config
src/           前端：pages（auth/chat/admin/room-panels）、api、ws、components
scripts/       构建、开发、校验、冒烟（m3-smoke.sh 需 SMOKE_* 环境变量）、vault-cli
docs/          部署文档、安全基线
Dockerfile    多阶段构建（builder → runtime，非 root）
docker-compose.yml  app + postgres + redis（+ ollama profile）
```

## 9. 文档

- [CHANGELOG.md](CHANGELOG.md) — 版本演进（M1 → M5）
- [SECURITY.md](SECURITY.md) — 漏洞报告方式、安全边界、**部署方必做清单**
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — 环境变量、初始化/解封、升级与备份、反向代理与 TLS
- [docs/SECURITY_BASELINE.md](docs/SECURITY_BASELINE.md) — 威胁模型与上线检查清单
- [DESIGN.md](DESIGN.md) — 设计语言与交互规范
- [AGENTS.md](AGENTS.md) — 工程结构与开发约定

## 10. 许可证

[MIT](LICENSE)
