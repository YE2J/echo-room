# 变更记录

本项目按里程碑推进；版本号与里程碑对应。日期为里程碑验收日。

## v0.5.0 — M5 匿名性改造（2026-11-23）

把「内容治理」和「身份治理」彻底切开，后台不再有任何能反推真人的线索。

- 新增 `server/services/privacy.ts`：`adminLabel`/`approverLabel`（`admin#N`）、`sanitizeAuditActor`、`sanitizeAuditMeta`（递归剥离 username/userId/alias/ip/ua/email/phone）、`shortRef`/`aliasRefOf`、`dateKeyOf`/`timeSlotOf`、`migrateAuditPrivacy`
- `GET /api/admin/messages` 移除 `aliasName` 与毫秒时间，改返回 `ref` + `dateKey` + `timeSlot` + 归一化文本；关键词只搜内容
- 审计写路径内置脱敏（普通用户 `actor=null`，管理员 `admin#N`），启动时幂等迁移存量
- 溯源台/房间审批台返回 `targetRef`、`审批人#N`、脱敏后的申请人
- 前端：内容管理去掉昵称列/昵称搜索/按昵称封禁；顶栏两个齿轮合并为单设置菜单；UI 一致性 9 项修复（图标尺寸、移动端顶栏、表格横向滚动、a11y 标签等）
- 生产两次部署（主体改造 15:49、审计 meta 清理 16:01），生产库 24 条 `room.*` 审计均为 `{"roomRef":"xxxxxxxx"}` 形态

## v0.4.0 — M4 生产上线（2026-11-23）

- 生产环境交付：PostgreSQL + Redis + 反向代理，健康检查与启动诊断横幅
- 审计 meta 房间身份残留清理（`roomName` / 完整 UUID → 短引用）
- 启动日志压缩与噪声清理

## v0.3.0 — M3 多聊天室（2026-11-20）

- 房间模型：公共/私有、成员、未读、在线人数
- 房间申请与审批（`/api/rooms/requests`、`/api/admin/room-requests/*`）
- 管理端房间生命周期：归档/恢复/彻底删除（事务内级联清理 messages / room_members / room_requests / pending trace_requests）
- `requireAdminOrRoomOwner` 守卫；归档房间对所有人不可访问
- 前端房间面板（`src/pages/room-panels.ts`）

## v0.2.0 — M2 管理后台与溯源审批（2026-11-16）

- 管理后台：保险库状态/解封/封存、邀请码签发与列表、归一化开关、内容管理
- 溯源审批工作台：申请 → 多人审批 → 达门限解密 → 关闭，全程审计
- 保险库分片加密备份表（`VAULT_AUTO_BOOTSTRAP` 引导时写入）

## v0.1.0 — M1 可运行 MVP（2026-10-12）

- 邀请码 + 本地账号准入（scrypt）、OIDC 接口预留
- 随机匿名昵称 + 确定性头像
- 公共聊天室 WebSocket 实时收发（首帧鉴权、心跳、限流、乐观发送）
- LLM 语气归一化（OpenAI 兼容 / Ollama / 本地确定性规则）
- 消息 AES-256-GCM 密文落库，对外只返回归一化文本
- 身份保险库：映射整表加密 + Shamir K/N 分片，门限 reveal 现场重组
- Docker Compose 一键部署、部署文档、安全基线

---

## 公开前清理（随本版本一起提交）

- `scripts/m3-smoke.sh`：移除硬编码的管理员账号/口令与邀请码，改为 `SMOKE_ADMIN_USER` / `SMOKE_ADMIN_PASS` / `SMOKE_INVITE_CODE` 环境变量
- 移除内部改写智能体域名：`LLM_COZE_API_URL` 在 `config.ts`(×2) / `docker-compose.yml` / `.env.example` 的默认值一律置空，改由部署方自己填写
- 删除内部任务文档 `assets/coze_provider_task.md`
- `VAULT_AUTO_BOOTSTRAP` 默认 `true` → **`false`**（否则启动即自动解封，与"平时无法溯源"矛盾）
- 生产态拒绝 `.env.example` 的占位密钥（`please-generate…` / `REPLACE_WITH…`），避免"看着配了其实没配"
- 暴露密钥来源：`/api/health` 新增 `secretSource`（`env` / `ephemeral`）。原先配置非法时会**静默**用随机密钥继续启动（重启后旧密文永久不可解），现在降级路径打 `FATAL-DEGRADED` 并在健康检查里显性可见
- 启动日志不再逐条打印全部环境变量名（含 `*_API_KEY` / `*_TOKEN`），只打数量 + 关注项 `[set]/[unset]`
- 修复 `pnpm start` / 容器启动路径与 tsup 实际产物不一致（实际是 `dist-server/server/server.js`、`dist-server/scripts/vault-cli.js`）
- 修复 `src/pages/admin.ts` 未使用变量导致 `eslint` 失败（CI 会红）
- `/api/health/diag` 生产默认 404，需要时用 `HEALTH_DIAG_TOKEN` + `x-diag-token` 打开
- Dockerfile：去掉不存在的 `pnpm-workspace.yaml`（会让 `docker build` 直接失败）
- 新增 `LICENSE`（MIT）、`SECURITY.md`、`.github/workflows/ci.yml`（tsc + eslint + stylelint + build + gitleaks）
