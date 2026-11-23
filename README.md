# 匿名回音 · Echo Room

> 企业内部**匿名意见收集与问题举报**聊天室。员工实名准入、发言匿名；身份映射整表加密并以 Shamir 密钥分割（K/N）保管——**平时任何人都无法把一句话追溯到某个员工**，只有满足门限的多方审批才能揭示。它和普通聊天室的区别：准入实名、发言完全匿名、追溯需要密码学门限授权。

本仓库为 **M5 可运行版本**：多房间 + 房间申请审批流、实时 WebSocket 房间路由、消息 AES-256-GCM 加密落库、LLM 语气归一化、邀请码准入、管理后台（含溯源审批台与 LLM 配置台）、审计全链路匿名脱敏。

---

## 1. 它解决什么问题

传统意见箱要么"完全匿名"导致无法对恶意内容负责，要么"实名发言"导致没人敢说真话。本系统通过**密码学隔离**取得平衡：

- **准入是实名的**：只有持有效邀请码的内部员工能注册登录。
- **使用是匿名的**：系统签发随机匿名昵称，聊天室、历史消息、广播中**永不出现**真实身份。
- **平时无法溯源**：`user ↔ alias` 映射整表以 AES-256-GCM 加密，主密钥被切成 N 片（Shamir 门限 K/N），由不同角色分别保管；服务器运行态内存里也没有主密钥，除非集齐 K 片解封。
- **追责需门限授权**：管理员发起溯源申请后，由 **K 名不同审批人各自现场提交份额**，达到门限才临时重组主密钥反查真实身份，**每次追责强制审计留痕**。

---

## 2. 功能矩阵（M5）

| 模块 | 能力 |
|---|---|
| 多聊天室 | 公共房/私有房、房主与成员管理、房间改名/改简介、归档（可见性移除）/恢复/**彻底删除**（级联清理消息、成员、申请与 pending 溯源请求；默认大厅为系统房间禁删） |
| 建房工作流 | 普通用户发起建房申请 → 管理员审批（通过即同一事务建房间并把申请人设为房主）/ 驳回（带理由） |
| 实时聊天 | WebSocket（`/ws/chat`）房间路由：`room:join/room:leave` 切换房间并校验可见性、`chat:send` 仅允许在已加入房间发送、心跳断线重连、房间维度 presence 在线人数、跨实例 Redis Pub/Sub 按房间扇出 |
| 消息加密落库 | 消息原文 AES-256-GCM 密文入库，库中**只有密文 + 归一化文本**，任何接口默认不返回原文 |
| 匿名身份 | 注册即一次性签发随机昵称（如「沉默的雪豹-7F3A」），**全局唯一、跨房间一致**，配确定性几何头像（昵称哈希派生色相/形状）；同一用户在所有房间显示同一昵称，无任何明文外键 |
| 邀请码准入 | 一次性/可复用邀请码（最大使用次数、有效期），管理员后台或 CLI 签发；启动可注入引导码 |
| 语气归一化 | 消息广播前经 LLM 改写以抹平写作指纹；provider 支持 `off`（本地确定性规则）/ `openai` / `ollama` / `coze`，故障策略可配置（放行原文或拒绝发送） |
| 管理后台 | 房间管理（含归档/恢复/删除）、消息管理（游标分页 + 关键词检索，仅归一化文本）、**溯源审批台**、LLM 配置台（热生效、Key 加密存储只回掩码、连通性测试、用量统计）、别名封禁/解封、邀请码签发、保险库解封/封存、审计日志 |
| 溯源审批工作流 | 管理员创建溯源申请 → 多名审批人各自提交份额（内存累计、不落库）→ **达到门限 K 现场重组还原**，仅提交成功的那次响应返回真实身份；申请人不能自批 |
| 匿名性脱敏层 | `server/services/privacy.ts` 集中治理：审计 actor 一律 `admin#N`、meta 递归剥离身份键、房间短引用、时间粗化（详见 §3） |

---

## 3. 安全模型

这是本项目的核心卖点，请务必读透。

### 3.1 密钥分片与门限（Shamir K/N）

- 身份主密钥在保险库初始化时被切成 **N 片**，任意 **K 片** 可重组（默认 2-of-3，`VAULT_K`/`VAULT_N` 可调）。
- 平时**无人持有足够份额**：分片由不同角色分别保管（部署时人工拆分发到不同邮箱/U 盘/密码管理器），服务器只在解封瞬间持有内存主密钥，封存即清空。
- 消息加密独立使用 `MESSAGE_ENCRYPTION_KEY`（AES-256-GCM），与追溯主密钥分离。

### 3.2 溯源流程（门限揭示）

1. 管理员在溯源审批台创建申请：填写**匿名昵称** + **事由**。系统只为昵称生成不可逆短引用 `targetRef`（sha256 前 8 位），审计里绝不出现昵称原文。
2. 多名**不同**审批人进入申请，各自现场提交自己保管的份额（同时输入自己的管理员账密）。份额只进入**内存份额库**（`TraceShareDepository`），**不落库、重启即失效**。
3. 累计份额达到门限 K 时，系统现场重组主密钥并校验（错误份额会被拒绝并回滚该审批人提交）。校验通过才反查真实身份，**且仅在此次响应中返回**；申请详情/列表/审计永远只显示 `targetRef` 与审批进度。
4. **申请人不能审批自己的申请**（`403`），同一审批人重复提交会被拒绝（`409`），非 K 名审批人无法单独揭示。

### 3.3 审计与脱敏规则（`server/services/privacy.ts`）

所有审计日志（写路径 + 存量迁移 `migrateAuditPrivacy`）强制执行以下规则：

| 规则 | 说明 |
|---|---|
| actor 一律匿名化 | 管理员显示为稳定标记 `admin#N`（按 `ADMIN_USERNAMES` 名单顺序，同人恒同号）；普通用户一律为 `null`。幂等，不会二次改写 |
| meta 递归剥离身份键 | 递归删除 `username / userId / user_id / alias / aliasName / targetAlias / ip / ipAddress / ua / userAgent / email / phone`，只保留 `ok / hit / status / count` 等治理必要字段 |
| 房间审计短引用 | `room.*` 类 action 的 `roomId`（完整 UUID）改写成不可逆短引用 `roomRef`（前 8 位），并抹除 `roomName / description / name` 业务痕迹——审计里只剩「哪个房间发生了动作」，不含房间内容 |
| 溯源目标短引用 | 审计与列表只出现 `targetRef`（sha256 前 8 位），不出现目标昵称 |
| 时间粗化 | 管理台消息列表不显示毫秒时间戳，只显示 `dateKey`（如 `2026-11-23`）与 `timeSlot`（上午/下午/夜间），降低时间关联攻击面 |

> 设计原则：管理后台只做**内容治理**，不做**身份治理**——日常可见数据里不得出现任何能把「某条内容/某个行为」与「某个真实账号」关联起来的线索。

### 3.4 `VAULT_AUTO_BOOTSTRAP` 的语义与风险（重要）

- `VAULT_AUTO_BOOTSTRAP=false`（**默认，推荐**）：首次启动保险库保持 uninitialized，注册被拒绝，必须由 ≥K 名分片持有人通过 break-glass 接口人工解封。**这是"平时不可追溯"承诺的基石。**
- `VAULT_AUTO_BOOTSTRAP=true`：启动时自动生成 K/N 分片 → 内存解封 → 把**加密后的分片落库备份**。等于把全部份额放进了同一个数据库，**放弃「平时不可追溯」**。仅适合受信单管理员环境 / PoC。
- **生产如需自动解封，请显式设 `true` 并配合 `VAULT_AUTO_UNSEAL_SHARES` 严格保管分片**，禁止依赖代码默认值。

### 3.5 首次引导的明文分片

无论哪种引导方式，**首次 bootstrap 生成的 K/N 明文分片只在启动日志打印一次**：自动引导（`VAULT_AUTO_BOOTSTRAP=true`）日志包含 `SHARES PRINTED ONLY ONCE — BACK THEM UP NOW BEFORE CONTINUING` 横幅；CLI（`scripts/vault-cli.ts init`）打印「请将下列分片【分别】交给不同保管人，切勿保存在服务器」。**务必立即抄走并离线保管**（离线密码管理器/纸质/多名持有人邮箱），之后请勿让日志流入生产日志收集系统——明文分片本身即最高机密。

### 3.6 其它安全要点

- 密码使用 **scrypt** 哈希；JWT（HS256）HttpOnly Cookie。
- 消息、审计、LLM 用量均不记录消息原文出库；`/api/health/diag`（返回 env 键名/路径/可写性诊断）**生产环境仅管理员可见**。
- 前端渲染用户内容一律 `textContent`，防 XSS；不引入第三方 CDN。
- 速率限制（令牌桶，Redis 或内存）与消息长度上限防止垃圾刷屏。

---

## 4. 快速开始

### 方式 A：Docker Compose（推荐，生产/试用）

```bash
cp .env.example .env
# 编辑 .env，至少设置三个生产必填项：
openssl rand -base64 32     # 输出作为 MESSAGE_ENCRYPTION_KEY（必须 32 字节 base64）
openssl rand -base64 48     # 输出作为 JWT_SECRET
# 还需保证 DATABASE_URL 指向你的 PostgreSQL（docker-compose 自带 postgres 服务）

docker compose up -d --build
# 打开 http://localhost:5000
```

首次启动保险库处于**封存**状态，两种解封方式见
[部署文档 · 初始化与解封](docs/DEPLOYMENT.md)。想要启动即自动解封（仅 PoC），在 `.env` 设 `VAULT_AUTO_BOOTSTRAP=true`（风险见 §3.4）。

需要本地大模型做语气归一化：

```bash
docker compose --profile ollama up -d --build
docker compose exec ollama ollama pull qwen2.5:7b
# 并在 .env 设置 LLM_PROVIDER=ollama
```

### 方式 B：本地开发（PGlite，零外部依赖）

```bash
pnpm install
pnpm dev          # 等价 bash scripts/dev.sh：tsx watch + 内嵌 Vite middleware，:5000，HMR :6000
```

开发态（未配置 `DATABASE_URL`）自动回退 [PGlite](https://github.com/electric-sql/pglite)（WASM Postgres），数据落 `.data/`；自动生成开发密钥并持久化到 `.data/dev-secrets.json`，自动初始化并解封保险库、分片写到 `.data/dev-vault-shares.json`（**仅开发态**，生产绝不执行此逻辑）。`BOOTSTRAP_INVITE_CODES` 配置的引导邀请码会在启动时注入；未配置时启动会提示通过管理后台签发。

生产构建：

```bash
pnpm build        # dist/（前端）+ dist-server/（server.js、vault-cli.js）
pnpm start        # node dist-server/server.js
```

> ⚠️ PGlite 为单机嵌入式库，仅用于本地/演示；生产请始终使用 docker-compose 中的 PostgreSQL 或多实例部署。

---

## 5. 配置项

全部配置以 `.env.example` 为权威清单（复制为 `.env` 后由 docker compose 自动加载）。按功能分组：

### 必填（生产缺失会启动失败或功能不可用）

| 变量 | 默认 | 说明 |
|---|---|---|
| `JWT_SECRET` | 空 | 会话签名密钥，**生产必填**；`openssl rand -base64 48` |
| `MESSAGE_ENCRYPTION_KEY` | 空 | 消息/身份主密钥，**生产必填**；必须是 base64 编码的 32 字节（AES-256），`openssl rand -base64 32` |
| `DATABASE_URL` | 空（compose 中自动指向 `postgres` 服务） | PostgreSQL 连接串；生产必填（未设置时降级 PGlite，仅限本地） |
| `REDIS_URL` | 空（compose 中 `redis://redis:6379`） | 多实例实时广播必填；未设置用进程内总线（单实例可） |

### 数据库

| 变量 | 默认 | 说明 |
|---|---|---|
| `DB_DRIVER` | 空 | `pg`（需 `DATABASE_URL`）/ `pglite`（强制本地）；留空按 `DATABASE_URL` 自动判定 |
| `DATA_DIR` | 空 | 本地数据目录（PGlite/密钥/分片/审计）。探测顺序：`DATA_DIR` → `${COZE_WORKSPACE_PATH}/.data` → `cwd/.data` → `os.tmpdir()/echo-room-data` |

### 身份保险库（Shamir）

| 变量 | 默认 | 说明 |
|---|---|---|
| `VAULT_K` | `2` | 门限：重组主密钥所需最小分片数 |
| `VAULT_N` | `3` | 分片总数 |
| `VAULT_AUTO_BOOTSTRAP` | `false` | 启动自动生成分片并解封（自动运维/PoC）。**生产如需请显式设 true**，会削弱匿名性保证（§3.4） |
| `VAULT_AUTO_UNSEAL_SHARES` | 空 | 填 ≥K 个分片实现启动自动解封（免人工）；生产建议留空 |

### 管理员与准入

| 变量 | 默认 | 说明 |
|---|---|---|
| `ADMIN_USERNAMES` | `admin` | 逗号分隔的用户名，登录后自动拥有管理员角色（仍须邀请码注册） |
| `BOOTSTRAP_INVITE_CODES` | 空 | 启动时写入的引导邀请码；留空则需后台/CLI 签发 |
| `RATE_LIMIT_PER_MINUTE` | `12` | 每用户每分钟最大发消息条数 |
| `MAX_MESSAGE_LENGTH` | `1000` | 单条消息最大字数 |
| `TOKEN_TTL_SECONDS` | `43200` | 登录会话有效期（秒） |

### LLM 语气归一化

| 变量 | 默认 | 说明 |
|---|---|---|
| `LLM_NORMALIZE_ENABLED` | `true` | 总开关；关闭则完全不改写 |
| `LLM_PROVIDER` | `off` | `off`（本地确定性规则）/ `openai` / `ollama` / `coze` |
| `LLM_ON_FAILURE` | `passthrough` | 故障策略：`passthrough`=放行原文（保可用）/ `reject`=拒绝发送（保匿名强度） |
| `LLM_TIMEOUT_MS` | `8000` | LLM 调用超时 |
| `LLM_OPENAI_BASE_URL` / `LLM_OPENAI_API_KEY` / `LLM_OPENAI_MODEL` | `https://api.openai.com/v1` / 空 / `gpt-4o-mini` | OpenAI 兼容（含任意兼容网关） |
| `LLM_OLLAMA_BASE_URL` / `LLM_OLLAMA_MODEL` | `http://ollama:11434` / `qwen2.5:7b` | 本地 Ollama（compose 中服务名 ollama） |
| `LLM_COZE_API_URL` | 空 | **provider=coze 时必填**：你的扣子智能体部署域名（不含末尾斜杠） |
| `LLM_COZE_PROJECT_ID` | 空 | **provider=coze 时必填**：扣子平台项目 ID（19 位整数） |

> ⚠️ `LLM_PROVIDER=coze` 时 `LLM_COZE_API_URL` 与 `LLM_COZE_PROJECT_ID` **都必填**；生产缺失会在启动校验阶段**拒绝启动**（不静默 fallback）。开发环境缺失仅告警并降级本地规则。

### OIDC（预留，默认关闭）

| 变量 | 默认 | 说明 |
|---|---|---|
| `OIDC_ENABLED` | `false` | 单点登录总开关（当前未实现完整流程，接口占位 501） |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URI` | 空 | 配置位先行就位 |

### 平台注入

| 变量 | 默认 | 说明 |
|---|---|---|
| `COZE_WORKSPACE_PATH` | 空 | 部署平台注入的会话工作区路径（数据默认落其 `.data`）；自托管忽略 |

---

## 6. API 一览

共 **50 个 HTTP 端点**（其中 2 个 OIDC 占位 501，可进入业务流程的 48 个）+ 1 个 WebSocket。鉴权列：`用户` = 需登录（Cookie JWT），`管理员` = 需 `ADMIN_USERNAMES` 名单内账号。

### 认证

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/auth/register` | 邀请码 | 注册（保险库封存时返回 503），返回匿名昵称 + WS Token |
| POST | `/api/auth/login` | 账密 | 登录，Set-Cookie + WS Token（封存时也能登录，附 `vaultSealed`） |
| GET | `/api/auth/me` | 用户 | 当前匿名身份（昵称 + 头像色） |
| POST | `/api/auth/logout` | 用户 | 登出 |
| GET | `/api/auth/oidc/config` | 无 | OIDC 是否启用 |
| GET | `/api/auth/oidc/authorize`、`/api/auth/oidc/callback` | 无 | OIDC 占位（返回 501，未实现） |

### 健康检查

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/health` | 无 | 健康检查，各子系统状态如实上报（DB 挂了也 200，供部署后 HTTP 自查） |
| GET | `/api/health/diag` | 生产需管理员（Bearer JWT） | 环境变量键名/路径/可写性等诊断；生产仅管理员可见 |

### 房间（用户侧）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/rooms` | 用户 | 可见房间列表（公开房全员 / 私密房仅成员 / 管理员全部） |
| POST | `/api/rooms/requests` | 用户 | 发起建房申请（名称/类型/简介） |
| GET | `/api/rooms/requests?status=` | 用户 | 我的建房申请列表 |
| PUT | `/api/rooms/:id` | 房主/管理员 | 改名/改简介 |
| DELETE | `/api/rooms/:id?reason=` | 房主/管理员 | **归档**房间（可见性移除，可恢复） |
| GET/POST/DELETE | `/api/rooms/:id/members` | 房主/管理员 | 成员列表 / 添加成员 / 移除成员（post 传 username；delete 走 query） |

### 房间（管理侧）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/admin/rooms` | 管理员 | 全部房间（含归档；`hasOwner` 布尔脱敏） |
| POST | `/api/admin/rooms` | 管理员 | 管理员直建房间 |
| POST | `/api/admin/rooms/:id/archive` | 管理员/房主 | 归档 |
| POST | `/api/admin/rooms/:id/restore` | 管理员/房主 | 恢复 |
| DELETE | `/api/admin/rooms/:id` | 管理员 | **彻底删除**（级联消息/成员/申请/pending 溯源；大厅禁删 400） |
| GET | `/api/admin/room-requests` | 管理员 | 全部建房申请（申请人脱敏为 null） |
| POST | `/api/admin/room-requests/:id/approve` | 管理员 | 审批通过（同事务建房并设申请人为主） |
| POST | `/api/admin/room-requests/:id/reject` | 管理员 | 审批驳回（带理由） |

### 聊天

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/chat/history?roomId=&before=&limit=` | 用户 | 历史消息分页（缺省回退默认大厅；只返回归一化文本 + 昵称 + 头像色） |

### 管理（保险库 / 准入 / 内容 / LLM）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/admin/vault/status` | 管理员 | 保险库状态（解封/封存/未初始化 + K/N） |
| POST | `/api/admin/vault/unseal` | 管理员 | 会话内提交分片解封 |
| POST | `/api/admin/vault/break-glass-unseal` | 管理员账密 + 分片 | 封存态唯一恢复入口 |
| POST | `/api/admin/vault/seal` | 管理员 | 立即封存（清空内存主密钥） |
| GET/POST | `/api/admin/invites` | 管理员 | 邀请码列表 / 签发 |
| GET/PUT | `/api/admin/rewrite` | 管理员 | 查询 / 开关语气归一化 |
| POST | `/api/admin/reveal` | 管理员 | 昵称 + 事由 + **≥K 份分片**门限反查（审计只记事由与命中结果） |
| GET | `/api/admin/audit` | 管理员 | 审计日志（actor `admin#N`、meta 已脱敏） |
| GET | `/api/admin/messages?cursor=&limit=&keyword=` | 管理员 | 消息浏览（游标分页；只返回归一化文本 + `ref` + `dateKey`/`timeSlot`，不支持按 alias 搜） |
| DELETE | `/api/admin/messages/:id` | 管理员 | 删除消息（支持完整 id 或 8 位 ref；reason 走 query） |
| POST | `/api/admin/aliases/:alias/ban`、`/unban` | 管理员 | 封禁/解封匿名昵称（封禁后拒发；审计只记 `aliasRef`） |
| GET/PUT | `/api/admin/llm/config` | 管理员 | LLM 配置读取（Key 只回掩码）/ 保存（settings > env > 默认，热生效） |
| POST | `/api/admin/llm/test` | 管理员 | 用当前配置真发一条改写做连通性测试 |
| GET | `/api/admin/llm/usage?limit=` | 管理员 | LLM 调用量与 token 用量统计 |

### 溯源审批工作流

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/admin/trace-requests` | 管理员 | 创建溯源申请（昵称 + 事由；审计只记 `targetRef`） |
| GET | `/api/admin/trace-requests?status=` | 管理员 | 申请列表（目标 `targetRef`、审批人 `审批人#N`） |
| GET | `/api/admin/trace-requests/:id` | 管理员 | 申请详情（含审批进度，无真实身份） |
| POST | `/api/admin/trace-requests/:id/approve` | 管理员 | 提交本人份额（内存累计；申请人不可自批；达 K 现场还原并仅此次返回身份） |
| POST | `/api/admin/trace-requests/:id/reject` | 管理员 | 驳回（带理由） |
| POST | `/api/admin/trace-requests/:id/close` | 管理员 | 强制关闭（即使未达 K） |

### WebSocket（`/ws/chat`，首帧必须 `auth`）

每个连接同一时刻只在一个房间；连接后默认加入默认大厅。消息均为 `{ "type": string, "payload": unknown }`：

- 客户端 → 服务端：`auth`（首帧，含 token）、`room:join`（校验可见性）、`room:leave`（回大厅）、`chat:send`（仅限已加入房间；原文先归一化再密文落库）、`ping`
- 服务端 → 客户端：`auth:ok`（含昵称/头像色/当前房间）、`room:joined`、`room:left`、`presence`（房间在线数）、`chat:ack`、`chat:message`、`error`、`pong`

---

## 7. 项目结构

```
├── index.html              # Vite 入口
├── vite.config.ts          # Vite（middleware 模式内嵌后端，HMR 6000 /hot/vite-hmr）
├── src/                    # 前端（原生 TS + CSS，无框架）
│   ├── index.ts/main.ts    # 引导与登录态路由（auth/chat/admin 视图）
│   ├── session.ts/api.ts   # 会话与 HTTP 封装
│   ├── ws.ts               # WS 客户端（首帧 auth + 心跳 + 自动重连）
│   ├── components.ts       # 无框架 DOM 组件（一律 textContent 防 XSS）
│   └── pages/              # auth / chat / admin / room-panels 页面模块
├── server/
│   ├── server.ts           # Fastify 入口（HTTP + WS upgrade + Vite/静态托管）
│   ├── config.ts           # 环境变量集中解析与默认值
│   ├── db.ts / bus.ts       # PG（生产）/ PGlite（开发）适配 + Redis（生产）/内存总线
│   ├── crypto/             # aesgcm / shamir / passwords(scrypt) / token(HS256 JWT)
│   ├── services/           # 业务层：auth、vault、alias、messages、rooms、rewriter、
│   │                       #   rate-limit、audit、settings、privacy（脱敏核心）、trace、llm-config
│   ├── routes/             # HTTP 路由：auth / chat / rooms / admin / trace / health / oidc / helpers
│   └── ws/                 # /ws/chat 端点（noServer 模式，首帧 auth，房间路由）
├── scripts/                # build/dev/start/prepare 脚本 + vault-cli.ts + m3-smoke.sh 冒烟
├── docs/                   # DEPLOYMENT.md、SECURITY_BASELINE.md
└── docker-compose.yml      # app + postgres + redis + ollama(profile)
```

## 8. 部署

### Docker / Compose

- `docker compose up -d --build` 一键起 `app + postgres + redis`；`docker compose --profile ollama up -d` 额外拉起本地 LLM。
- 容器以**非 root** 运行（`USER echo`），镜像内置 HEALTHCHECK（请求 `/api/auth/oidc/config`，HTTP 200 即健康）；人工探活用 `GET /api/health`（DB 挂了也 200，供部署后自查）。
- **`/api/health/diag` 在生产环境需管理员鉴权**（`Authorization: Bearer <JWT>`），开发环境开放，供排障。

### 平台部署要点

- 密钥类（`JWT_SECRET`、`MESSAGE_ENCRYPTION_KEY`、`LLM_COZE_API_TOKEN`）通过部署平台 env 注入，**切勿写进代码/仓库**。
- `VAULT_AUTO_BOOTSTRAP` 默认 `false`；生产如需自动解封请显式设 `true` 并做好分片保管（§3.4/§3.5）。
- 多实例部署需配置 `REDIS_URL`，否则为单实例内存总线。
- 首次部署后：
  1. 用 `scripts/vault-cli.ts init` 或 break-glass 接口初始化并解封保险库；
  2. 抄走启动日志/CLI 打印的 K/N 明文分片并离线保管；
  3. 通过管理后台或 `vault-cli.ts invite` 签发首个邀请码（或设 `BOOTSTRAP_INVITE_CODES` 后重启）。

---

## 9. 开发与贡献

### 脚本命令

```bash
pnpm install      # 安装依赖
pnpm dev          # 开发（tsx watch + Vite middleware，:5000，HMR :6000）
pnpm build        # 生产构建（dist/ + dist-server/）
pnpm start        # 生产启动
pnpm lint         # ESLint
pnpm lint:style   # Stylelint
pnpm ts-check     # 前后端双 tsconfig 类型检查
```

### 测试说明

- 沙箱/本地无 Docker/PG/Redis 时使用 **PGlite + 内存总线**自测；生产路径通过 docker-compose 验证。
- 冒烟脚本 `scripts/m3-smoke.sh` 覆盖 `/api/auth/*`、`/api/chat/history`、`/api/admin/*`、`/ws/chat`（管理员账号/密码通过环境变量 `ADMIN_USER`/`ADMIN_PASS` 注入，脚本内不落任何真实凭据）。

### 贡献流程（简版）

1. Fork 并检出 `main`，建特性分支；
2. 修改后确保 `pnpm lint`、`pnpm lint:style`、`pnpm ts-check`、`pnpm build` 全部通过；
3. 更新相关测试与文档，**任何涉及管理接口/脱敏的改动必须附接口冒烟结果**；
4. 开 PR 到 `main`，CI（GitHub Actions：`pnpm install --frozen-lockfile` → `lint` → `ts-check` → `build`，Node 24）绿了才可合并。

> 安全红线：PR 中**严禁**出现真实凭据（密钥/Token/邀请码/账号密码/生产域名/项目 ID）。审计字段新增务必经过 `privacy.ts` 脱敏。

---

## 10. 许可证与安全披露

- 开源协议：[MIT](LICENSE)（版权所有 © 2026 Echo Room Contributors）。
- 漏洞披露：本项目为安全产品，请通过 **SECURITY.md** 中描述的渠道**私下报告**（勿开公开 issue），我们承诺 72 小时内确认响应。

## 文档

- [部署文档](docs/DEPLOYMENT.md)：环境变量、初始化/解封流程、升级与备份、反向代理与 TLS。
- [安全基线](docs/SECURITY_BASELINE.md)：威胁模型、密钥管理、默认安全配置与上线检查清单。
- [安全披露](SECURITY.md)：支持版本、报告渠道与响应时限。
- [DESIGN.md](DESIGN.md)：设计语言与交互规范。
- [AGENTS.md](AGENTS.md)：工程结构与开发约定。