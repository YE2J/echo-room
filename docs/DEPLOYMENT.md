# 部署文档 · 匿名回音

本文覆盖 Docker Compose 部署、保险库初始化与解封、环境变量、反向代理/TLS、升级备份与故障排查。

---

## 1. 前置条件

- Docker 24+ 与 Docker Compose v2
- 一台能长期运行的 Linux 主机（2 vCPU / 2 GB 内存起步；启用本地 Ollama 建议 16 GB 内存或独立 GPU 主机）
- 一个仅内网可达的域名或地址（本系统用于内部场景，**不建议直接暴露公网**）

---

## 2. 快速部署

```bash
# 1) 准备配置
cp .env.example .env

# 2) 生成密钥并填入 .env
openssl rand -base64 32     # -> MESSAGE_ENCRYPTION_KEY（必须恰好解码为 32 字节）
openssl rand -base64 48     # -> JWT_SECRET
# 同时修改 POSTGRES_PASSWORD，并让 DATABASE_URL 中的密码与其一致

# 3) 启动
docker compose up -d --build
docker compose ps
curl -s http://localhost:5000/api/health
```

服务组成：

| 服务 | 端口（容器内） | 说明 |
|---|---|---|
| app | 5000 | Fastify，同时提供 HTTP API、静态前端与 `/ws/chat` |
| postgres | 5432 | 业务库（卷 `pgdata`） |
| redis | 6379 | 仅 Pub/Sub，不持久化 |
| ollama（可选 profile） | 11434 | 本地 LLM |

对外只暴露 `app` 的 `${APP_PORT:-5000}`；postgres/redis 不发布到宿主机。

---

## 3. 身份保险库初始化与解封（关键）

保险库保存 `真实用户 ↔ 匿名昵称` 的加密映射。**主密钥不入库、不入配置文件**，
首次部署需要初始化并把 Shamir 分片分发给不同保管人。

### 3.1 初始化（生成 N 个分片）

在应用容器上执行 CLI（此时数据库迁移会自动执行）：

```bash
docker compose run --rm app node dist-server/scripts/vault-cli.js init 2 3
```

输出形如：

```
保险库已初始化 vaultId=...，门限 2/3
Share 1:  v1.01-xxxxxxxx...
Share 2:  v1.02-yyyyyyyy...
Share 3:  v1.03-zzzzzzzz...
```

- 门限 `K/N`：默认 2/3，即集齐任意 2 片即可解封。
- **N 份分片必须分发给不同保管人**（例如法务、HR、安全负责人各持一片），
  通过密码管理器/密封信封等线下渠道保存，**严禁**写入服务器、镜像、数据库或聊天记录。
- 分片丢失且不足 K 片 ⇒ 映射永久不可解密（历史发言将无法追责，但系统仍可收发新消息）。

### 3.2 注册管理员（封存状态也能注册/登录）

应用启动时会把 `BOOTSTRAP_INVITE_CODES` 中的邀请码写入数据库。用其中一个码注册管理员用户名，
并确保该用户名出现在 `.env` 的 `ADMIN_USERNAMES` 中：

```
ADMIN_USERNAMES=admin
BOOTSTRAP_INVITE_CODES=WELCOME-2025
```

> 管理员身份只由 `ADMIN_USERNAMES` 决定，无法自助提权；普通注册用户 `isAdmin=false`。

### 3.3 解封（三选一）

**方式一：Break-glass HTTP（推荐，保险库封存时的标准恢复路径）**

管理员用账号密码 + K 个分片直接解封，不依赖已登录会话：

```bash
curl -X POST https://你的内网域名/api/admin/vault/break-glass-unseal \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"***","shares":["v1.01-...","v1.02-..."]}'
```

也可在前端登录后，于管理后台的"保险库"面板粘贴分片解封。

**方式二：已登录管理员会话解封**

```bash
curl -X POST https://你的内网域名/api/admin/vault/unseal \
  -H 'Content-Type: application/json' -b cookies.txt \
  -d '{"shares":["v1.01-...","v1.02-..."]}'
```

**方式三：启动自动解封（仅限 PoC/测试，不建议生产）**

在 `.env` 填入 ≥K 个分片：

```
VAULT_AUTO_UNSEAL_SHARES=v1.01-...,v1.02-...
```

重启后自动解封。该模式削弱了"分片多人保管"的意义，**生产环境请保持留空**。

### 3.4 封存

任何时候管理员可立即封存（清空进程内主密钥，不影响已落库密文）：

```bash
curl -X POST https://你的内网域名/api/admin/vault/seal -b cookies.txt
```

封存后：普通用户进入聊天室会收到 503 `vault_sealed`，但账号仍可登录、管理员可重新解封。

### 3.5 重新分片（轮换）

M1 简化处理：更换门限/保管人需要重新初始化保险库。操作前先评估历史映射可解密窗口；
后续里程碑支持 `rekey`（解封状态下用新门限重加密元数据）。

---

## 4. 邀请码管理

```bash
# CLI 直接签发（MAX_USES=0 表示不限次数）
docker compose run --rm app node dist-server/scripts/vault-cli.js invite TEAM-Q3 50

# 或管理员登录后调用 API / 在后台界面签发
curl -X POST https://域名/api/admin/invites -b cookies.txt \
  -H 'Content-Type: application/json' -d '{"maxUses":1,"ttlSeconds":604800}'
```

上线后建议：从 `.env` 清空 `BOOTSTRAP_INVITE_CODES`（已写入的码仍在库中，可在后台删除/停用），
改为按批次签发限时、限次邀请码。

---

## 5. LLM 语气归一化配置

| 变量 | 取值 |
|---|---|
| `LLM_NORMALIZE_ENABLED` | `true`/`false`，总开关，默认开 |
| `LLM_PROVIDER` | `off`（默认，走本地确定性规则）/ `openai` / `ollama` |
| `LLM_ON_FAILURE` | `passthrough`（默认，模型故障时放行原文保可用）/ `reject`（拒绝发送，保匿名强度） |
| `LLM_OPENAI_BASE_URL` / `_KEY` / `_MODEL` | 任意 OpenAI 兼容网关 |
| `LLM_OLLAMA_BASE_URL` / `_MODEL` | compose 内默认 `http://ollama:11434` |

- `provider=off` 时仍会执行**确定性本地归一化**（折叠连续感叹号/问号/省略号/多余空白等机械指纹），
  保证开关始终有效，但无法改写句式与口头禅。
- 需要真正"抹平写作风格"，配置 `openai` 或启用 ollama profile：

```bash
docker compose --profile ollama up -d --build
docker compose exec ollama ollama pull qwen2.5:7b
# .env 设 LLM_PROVIDER=ollama 后重启 app
```

运行时管理员还可在后台或 `PUT /api/admin/rewrite` 动态开关（存于 DB 设置，优先级高于系统默认）。

---

## 6. 反向代理与 TLS

生产请在前置 Nginx/Caddy/Traefik 终结 TLS 并转发到 `127.0.0.1:APP_PORT`。WebSocket 需放行升级头。
Nginx 示例：

```nginx
location / {
  proxy_pass http://127.0.0.1:5000;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_read_timeout 3600s;
}
```

Cookie 在 `NODE_ENV=production` 下带 `Secure`，请确保经 HTTPS 访问，否则 Cookie 不会被浏览器保存。

---

## 7. 升级与备份

**备份**（机密性极高，需加密离线存放）：

```bash
docker compose exec postgres pg_dump -U echo echoroom | gzip > echo-backup-$(date +%F).sql.gz
```

备份中包含密文消息与密文身份映射；没有 `MESSAGE_ENCRYPTION_KEY` 与保险库分片，备份本身不可读。
请把 `.env` 中的两把密钥与保险库分片按独立通道妥善保管，丢密钥=丢数据。

**升级**：

```bash
git pull
docker compose build app
docker compose up -d app    # 迁移启动时自动执行（CREATE TABLE IF NOT EXISTS，幂等）
```

---

## 8. 故障排查

| 现象 | 排查 |
|---|---|
| 登录后提示保险库封存 | 用 break-glass 或后台提交 K 个分片解封 |
| 注册提示邀请码无效 | 检查 `BOOTSTRAP_INVITE_CODES`；`docker compose run --rm app node dist-server/scripts/vault-cli.js status` |
| 消息发不出 | 查看接口返回；`LLM_ON_FAILURE=reject` 时模型故障会拒绝，可临时改 `passthrough` |
| WS 连不上 | 确认反代透传 `Upgrade/Connection`；同一端口 `/ws/chat` |
| 启动报密钥错误 | `MESSAGE_ENCRYPTION_KEY` 必须是 32 字节的 base64；`JWT_SECRET` 生产必填 |
| 多实例广播收不到 | 确认各实例 `REDIS_URL` 指向同一 Redis |
