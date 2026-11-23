# 变更记录

本项目按里程碑推进；版本号与里程碑对应。日期为里程碑验收日。

## v0.5.0 — M5 匿名性改造 + 开源发布（2026-11-23）

把「内容治理」和「身份治理」彻底切开，后台不再有任何能反推真人的线索；同时完成公开仓库发布前清理。

### M5 匿名性改造

- 新增 `server/services/privacy.ts`：`adminLabel`/`approverLabel`（`admin#N`）、`sanitizeAuditActor`、`sanitizeAuditMeta`（递归剥离 username/userId/alias/ip/ua/email/phone）、`shortRef`/`aliasRefOf`、`dateKeyOf`/`timeSlotOf`、`migrateAuditPrivacy`
- `GET /api/admin/messages` 移除 `aliasName` 与毫秒时间，改返回 `ref` + `dateKey` + `timeSlot` + 归一化文本；关键词只搜内容
- 审计写路径内置脱敏（普通用户 `actor=null`，管理员 `admin#N`），启动时幂等迁移存量；房间类审计 meta 只保留 `{ roomRef }`
- 溯源台/房间审批台返回 `targetRef`、`审批人#N`、脱敏后的申请人
- 前端：内容管理去掉昵称列/昵称搜索/按昵称封禁；顶栏两个齿轮合并为单设置菜单；UI 一致性 9 项修复（图标尺寸、移动端顶栏、表格横向滚动、a11y 标签等）

### M5 多聊天室（M3 里程碑按接口层面在 M5 中收口）

- 房间模型：公共/私有、成员、未读、在线人数；建房申请与审批流（`/api/rooms/requests`、`/api/admin/room-requests/*`）
- 管理端房间生命周期：归档/恢复/彻底删除（事务内级联清理 messages / room_members / room_requests / pending trace_requests）；大厅禁删
- WS 房间路由：`room:join` / `room:leave` / `chat:send`，首帧鉴权、心跳、限流

### 开源发布清理

- `scripts/m3-smoke.sh`：移除硬编码的管理员账号/口令与固定邀请码，改为环境变量注入 + 随机生成
- 移除内部改写智能体域名 `LLM_COZE_API_URL` 与 `project_id` 硬编码（config / docker-compose / .env.example 一律置空，改由部署方填写）；`rewriter.ts` 对 `LLM_COZE_PROJECT_ID` 增加 15-20 位纯数字格式校验
- 内部任务文档 `assets/coze_provider_task.md` 移出版本管理（磁盘保留）
- `VAULT_AUTO_BOOTSTRAP` 默认 `true` → `false`（否则启动即自动解封，与「平时无法溯源」矛盾）；`BOOTSTRAP_INVITE_CODES` 默认清空并在启动日志提示从管理后台签发
- 生产态拒绝 `.env.example` 的占位密钥；`/api/health` 新增 `secretSource`（`env` / `ephemeral`），配置非法降级时打显眼的 `FATAL-DEGRADED` 日志（旧密文重启后不可恢复）
- 启动日志不再逐条打印全部环境变量名（含 `*_API_KEY` / `*_TOKEN`），只打数量 + 关注项 `[set]/[unset]`
- `/api/health/diag` 生产环境加 admin 鉴权；`/api/admin/vault/status` 补 `requireAdmin`
- Dockerfile：去掉不存在的 `pnpm-workspace.yaml`（会让 `docker build` 直接失败），修正 CMD 启动路径
- 新增 `LICENSE`（MIT）、`SECURITY.md`、`.github/workflows/ci.yml`（tsc + eslint + stylelint + build + gitleaks 密钥扫描）、`README.md` 重写为 M5 现状

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
- WebSocket 实时收发（首帧鉴权、心跳、限流、乐观发送）
- LLM 语气归一化（OpenAI 兼容 / Ollama / 扣子 Coze / 本地确定性规则）
- 消息 AES-256-GCM 密文落库，对外只返回归一化文本
- 身份保险库：映射整表加密 + Shamir K/N 分片，门限 reveal 现场重组
- Docker Compose 一键部署、部署文档、安全基线