# 安全策略

## 报告漏洞

**请不要在公开 Issue 中提交安全问题**（尤其是匿名性/可追溯性相关的绕过手法）。
请通过仓库所有者公开的联系方式私下报告，或在 GitHub 上使用「Report a vulnerability」
（Security → Advisories）私密提交。

我们会在收到报告后尽快确认，并在修复发布后致谢（如你希望署名）。

## 本项目承诺的安全边界

| 承诺 | 实现依据 | 说明 |
| --- | --- | --- |
| 访问侧永不出现真实身份 | `server/services/privacy.ts`、`server/services/messages.ts` | 昵称/身份只以匿名 alias 与不可逆短引用（`ref`）出现 |
| 原文不落明文 | `server/crypto/aesgcm.ts`、`server/services/messages.ts` | 消息原文 AES-256-GCM 密文入库，接口只返回归一化文本 |
| 平时无法溯源 | `server/services/vault.ts` | `user ↔ alias` 映射整表加密；主密钥 Shamir K/N 分割，运行态默认封存 |
| 追责留痕且不可单人完成 | `server/routes/trace.ts`、`server/routes/admin.ts` | 需 ≥K 份分片现场重组 + 事由 + 审计 |
| 密钥不外泄到接口 | `server/services/llm-config.ts` | LLM API Key 以主密钥派生密钥加密入库，对外只返回掩码 |

## 部署方必须自己做的（默认值不安全）

| 项 | 要求 |
| --- | --- |
| `JWT_SECRET` / `MESSAGE_ENCRYPTION_KEY` | 必须用 `openssl rand` 重新生成；`.env.example` 的占位值会被生产态识别并拒绝加载配置。注意：因平台要求端口必须监听，服务会**降级**用临时随机密钥启动（`/api/health` 显示 `secretSource:"ephemeral"`、日志 `FATAL-DEGRADED`），重启后旧密文即永久不可解——**上线后第一件事就是确认该字段为 `env`** |
| `ADMIN_USERNAMES` | 换成你自己的管理员用户名；示例里的 `admin` 不要带到生产 |
| `BOOTSTRAP_INVITE_CODES` | 上线后立即在管理后台轮换并从此项清空 |
| `VAULT_AUTO_BOOTSTRAP` / `VAULT_AUTO_UNSEAL_SHARES` | 保持 `false`/留空：第一次引导时分片只打印一次，请离线分发给不同持有人 |
| TLS | 必须置于反向代理之后启用 HTTPS/WSS（见 `docs/DEPLOYMENT.md`） |
| `/api/health` 自检 | 上线后确认 `secretSource=env`，且 `vault` 不是 `uninitialized` |
| `HEALTH_DIAG_TOKEN` | 生产默认关闭 `/api/health/diag`；确实需要排障时再临时设置该 token |

## 已知设计取舍（非漏洞）

- 归一化改写依赖外部 LLM 时，原文会发送给该 provider；如需完全不外发，请用自托管 Ollama。
- `passthrough` 失败策略在模型不可用时会**放行原文**（保证可用性）；对匿名强度有硬要求请设 `LLM_ON_FAILURE=reject`。
- 单实例 + PGlite 仅用于评估，生产请用 PostgreSQL + Redis。
