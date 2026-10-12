# 匿名回音 · Echo Room

> 企业内部**匿名意见收集与问题举报**聊天室。员工实名准入、发言匿名；身份映射整表加密并以 Shamir 密钥分割（K/N）保管，**平时任何人都无法把一句话追溯到某个员工**，仅在达到门限的合规授权下才可解封追责。

本仓库为 **M1 里程碑可运行 MVP**：单公共房间、实时 WebSocket、消息加密落库、LLM 语气归一化、邀请码准入、Docker Compose 一键部署。

---

## 1. 它解决什么问题

传统意见箱要么"完全匿名"导致无法对恶意内容负责，要么"实名发言"导致没人敢说真话。本系统通过**密码学隔离**取得平衡：

- **准入是实名的**：只有持有效邀请码的内部员工能注册登录。
- **使用是匿名的**：系统签发随机匿名昵称，聊天室、历史消息、广播中**永不出现**真实身份。
- **平时无法溯源**：`user ↔ alias` 映射整表以 AES-256-GCM 加密，主密钥被切成 N 片（Shamir 门限 K/N），由不同角色分别保管；服务器运行态内存里也没有主密钥，除非集齐 K 片解封。
- **追责需授权**：管理员输入匿名昵称 + 事由，且保险库处于解封状态，才能反查真实身份，**每次追责强制审计留痕**。

---

## 2. 功能清单（M1）

| 模块 | 能力 |
|---|---|
| 认证准入 | 邀请码 + 本地用户名/密码（scrypt 哈希）；登录签发 HttpOnly Cookie JWT + 短期 WS Token；OIDC 接口已预留（默认关闭） |
| 匿名身份 | 注册即随机中文匿名词 + 4 位混淆码 + 稳定色相；公开侧只有昵称，无任何明文外键 |
| 公共聊天室 | WebSocket（`/ws/chat`）实时收发、在线人数、心跳断线重连、历史消息分页 |
| 语气归一化 | 消息广播前经归一化，抹平口头禅/标点/句式等写作指纹；支持 OpenAI 兼容与本地 Ollama，可开关；未配置模型时走确定性本地规则兜底 |
| 加密存储 | 消息原文 AES-256-GCM 密文入库，库中**只有密文 + 归一化文本**，任何接口默认不返回原文 |
| 身份保险库 | 映射整表加密；Shamir K/N 分片；启动默认封存，break-glass 解封、可随时再封存 |
| 管理后台 | 保险库状态/解封/封存、邀请码签发、归一化开关、**带事由的身份追责**、审计日志查询 |
| 运维 | Docker Compose（app + postgres + redis + 可选 ollama）、非 root 容器、健康检查、限流 |

---

## 3. 技术架构

```
┌──────────────┐   HTTPS + WSS
│  React 18 +  │  /ws/chat（首帧 auth 携带 WS Token）
│  Vite + TS   │  /api/*（HttpOnly Cookie JWT）
└──────┬───────┘
       │
┌──────▼───────────────────────────────────────────┐
│            Node.js + Fastify + TypeScript         │
│  auth routes │ chat routes │ admin routes │ OIDC* │
│  WS gateway (ws, noServer, /ws/*)                 │
│ ┌────────────┐  ┌──────────────┐  ┌─────────────┐ │
│ │ Rewriter   │  │ IdentityVault│  │ RateLimiter │ │
│ │LLM/本地规则 │  │ AES-GCM+Shamir│  │ (Redis/内存)│ │
│ └────────────┘  └──────┬───────┘  └─────────────┘ │
└──────────┬─────────────┼───────────────┬──────────┘
           │             │               │
   ┌───────▼──────┐ ┌────▼─────┐  ┌───────▼────────┐
   │ PostgreSQL   │ │(仅解封时  │  │ Redis Pub/Sub  │
   │ 消息密文/用户 │ │ 内存主密钥)│  │ 跨实例实时扇出  │
   │ 保险库密文/审计│ └──────────┘  └────────────────┘
   └──────────────┘
```

- **前端**：React 18 + Vite 7 + TypeScript（无重型 UI 框架，组件化原生 TS + CSS 变量设计系统）。
- **后端**：Node.js + Fastify 5 + TypeScript，`ws` 库 noServer 模式与 HTTP 共用单端口。
- **数据库**：PostgreSQL 16；时间统一存 BIGINT 毫秒。
- **实时**：Redis Pub/Sub 扇出（多实例）；无 Redis 的开发态自动降级为进程内 EventBus。
- **本地开发**：未配置 `DATABASE_URL` 时回退 [PGlite](https://github.com/electric-sql/pglite)（WASM Postgres），零外部依赖即可跑通。

> ⚠️ PGlite 为**单机嵌入式**库，仅用于本地/演示；生产请始终使用 docker-compose 中的 PostgreSQL。

---

## 4. 快速开始

### 方式 A：Docker Compose（推荐，生产/试用）

```bash
cp .env.example .env
# 编辑 .env：至少设置 JWT_SECRET、MESSAGE_ENCRYPTION_KEY、POSTGRES_PASSWORD
openssl rand -base64 32     # 用其输出作为 MESSAGE_ENCRYPTION_KEY
openssl rand -base64 48     # 用其输出作为 JWT_SECRET

docker compose up -d --build
# 打开 http://localhost:5000
```

首次启动保险库处于**封存**状态。两种解封方式见
[部署文档 · 初始化与解封](docs/DEPLOYMENT.md)。
想要启动即自动解封（仅适合 PoC），在 `.env` 的 `VAULT_AUTO_UNSEAL_SHARES` 填入 ≥K 个分片。

需要本地大模型做语气归一化：

```bash
docker compose --profile ollama up -d --build
docker compose exec ollama ollama pull qwen2.5:7b
# 并在 .env 设置 LLM_PROVIDER=ollama
```

### 方式 B：本地开发（PGlite，无需 Docker/Postgres/Redis）

```bash
pnpm install
pnpm dev          # 等价 bash scripts/dev.sh，tsx watch + Vite middleware，:5000
```

开发态会在 `.data/` 自动生成本地密钥、自动初始化并解封保险库、分片写到
`.data/dev-vault-shares.json`（**仅开发态**，生产绝不执行此逻辑）。默认引导邀请码：
`CN-INVITE` / `CN-INVITE-A` / `CN-INVITE-B`。

生产构建：

```bash
pnpm build        # dist/（前端）+ dist-server/（server.js、vault-cli.js）
pnpm start        # node dist-server/server.js
```

---

## 5. 一分钟体验流程

1. 用邀请码注册账号 `alice`（昵称随机，如"隐于市的松貂-17CD"）。
2. 再开一个无痕窗口，注册 `bob`。
3. 双方进入聊天室互发消息：界面只显示随机昵称与色相，看不到任何账号信息。
4. 管理员账号（用户名加入 `ADMIN_USERNAMES`）登录后可在管理区：
   - 查看保险库状态、封存/解封；
   - 签发一次性邀请码；
   - 开关语气归一化；
   - 输入某昵称 + 事由 + **K 份密钥分片**做门限追责反查（平时无法溯源，凑齐 K 个托管人分片才在内存临时重组主密钥，产生 `identity.reveal` 审计）。

---

## 6. API 概览

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/health` | 无 | 健康检查 |
| POST | `/api/auth/register` | 邀请码 | 注册，返回匿名昵称与 WS Token |
| POST | `/api/auth/login` | 账密 | 登录，Set-Cookie + WS Token（封存时也能登录） |
| GET | `/api/auth/me` | 用户 | 当前匿名身份 |
| POST | `/api/auth/logout` | 用户 | 登出 |
| GET | `/api/auth/oidc/config` | 无 | OIDC 是否启用（M1 预留） |
| GET | `/api/chat/history` | 用户 | 历史消息（仅归一化文本） |
| WS | `/ws/chat` | 首帧 `auth` | 实时聊天通道 |
| GET | `/api/admin/vault/status` | 无 | 保险库状态 |
| POST | `/api/admin/vault/unseal` | 管理员 | 会话内提交分片解封 |
| POST | `/api/admin/vault/break-glass-unseal` | 账密+分片 | 封存态恢复入口 |
| POST | `/api/admin/vault/seal` | 管理员 | 立即封存（清空内存主密钥） |
| GET/POST | `/api/admin/invites` | 管理员 | 列出/签发邀请码 |
| GET/PUT | `/api/admin/rewrite` | 管理员 | 查询/设置归一化开关 |
| POST | `/api/admin/reveal` | 管理员 | 昵称 + 事由 + **K 份分片**门限反查真实身份（重组密钥用后即焚，强审计） |
| GET | `/api/admin/audit` | 管理员 | 审计日志 |

WebSocket 消息均为 `{ "type": string, "payload": unknown }`：

- 客户端 → 服务端：`auth`（首帧，含 token）、`chat:send`（含 text）、`ping`
- 服务端 → 客户端：`auth:ok`、`chat:ack`、`chat:message`、`presence`、`error`、`pong`

---

## 7. 文档

- [部署文档](docs/DEPLOYMENT.md)：环境变量、初始化/解封流程、升级与备份、反向代理与 TLS。
- [安全基线](docs/SECURITY_BASELINE.md)：威胁模型、密钥管理、默认安全配置与上线检查清单。
- [DESIGN.md](DESIGN.md)：设计语言与交互规范。
- [AGENTS.md](AGENTS.md)：工程结构与开发约定。

## 8. 许可证

MIT。
