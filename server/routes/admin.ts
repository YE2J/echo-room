// ABOUTME: 管理路由（需 admin）：保险库状态/解封/封存、邀请码签发、改写开关、
// 匿名身份追责（强审计）、审计日志查看。保险库分片只在内存中使用，绝不入库/入日志。
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { requireAdmin } from './helpers';
import { authenticate, createInvite, listInvites, AuthError } from '../services/auth';
import { writeAudit } from '../services/audit';
import {
  sanitizeAuditActor,
  sanitizeAuditMeta,
  aliasRefOf,
  dateKeyOf,
  timeSlotOf,
  shortRef,
} from '../services/privacy';
import { getSetting, setSetting, deleteSetting, SETTING_KEYS } from '../services/settings';
import {
  resolveLlmConfig,
  encryptApiKey,
  maskApiKey,
} from '../services/llm-config';

const unsealSchema = z.object({
  shares: z.array(z.string().min(3)).min(1).max(255),
});

// Break-glass：保险库封存时普通会话无法工作，管理员用“账密 + K 个分片”直接解封（不依赖 cookie/保险库）
const breakGlassSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  shares: z.array(z.string().min(3)).min(1).max(255),
});

const inviteSchema = z.object({
  code: z.string().min(4).max(40).regex(/^[A-Za-z0-9-]+$/).optional(),
  maxUses: z.number().int().min(0).max(10_000).default(1),
  ttlSeconds: z.number().int().min(60).max(60 * 60 * 24 * 365).optional(),
});

const revealSchema = z.object({
  alias: z.string().min(1).max(64),
  reason: z.string().min(2).max(300),
  // 门限追责：每次必须现场提供 ≥K 份分片，绝不复用内存解封态
  shares: z.array(z.string().min(3)).min(1).max(255),
});

const toggleSchema = z.object({
  enabled: z.boolean(),
});

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  // 保险库状态属敏感情报（匿名性产品里「当前是否可溯源」是关键情报），仅管理员可见
  app.get('/api/admin/vault/status', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    return reply.send(await ctx.vault.status());
  });

  app.post('/api/admin/vault/unseal', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    const parsed = unsealSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '请提供至少一个密钥分片' });
    try {
      await ctx.vault.unseal(parsed.data.shares);
      await writeAudit(
        ctx.db,
        {
          actor: admin.username,
          action: 'vault.unseal',
          meta: { sharesProvided: parsed.data.shares.length },
        },
        ctx.config.adminUsernames,
      );
      return reply.send(await ctx.vault.status());
    } catch (err) {
      await writeAudit(ctx.db, { actor: admin.username, action: 'vault.unseal_failed' }, ctx.config.adminUsernames);
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Break-glass 解封：用管理员账密直接认证（保险库封存导致 JWT 会话无法解析昵称时的唯一恢复入口）
  app.post('/api/admin/vault/break-glass-unseal', async (request, reply) => {
    const parsed = breakGlassSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '需要管理员用户名、密码与密钥分片' });
    try {
      const admin = await authenticate(ctx.db, parsed.data.username, parsed.data.password, ctx.config);
      if (!admin.isAdmin) {
        await writeAudit(ctx.db, { actor: admin.username, action: 'vault.break_glass_denied' }, ctx.config.adminUsernames);
        return reply.code(403).send({ error: '需要管理员权限' });
      }
      await ctx.vault.unseal(parsed.data.shares);
      await writeAudit(
        ctx.db,
        {
          actor: admin.username,
          action: 'vault.break_glass_unseal',
          meta: { sharesProvided: parsed.data.shares.length },
        },
        ctx.config.adminUsernames,
      );
      return reply.send(await ctx.vault.status());
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      await writeAudit(ctx.db, { actor: parsed.data.username, action: 'vault.break_glass_failed' }, ctx.config.adminUsernames).catch(() => undefined);
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post('/api/admin/vault/seal', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    ctx.vault.seal();
    await writeAudit(ctx.db, { actor: admin.username, action: 'vault.seal' }, ctx.config.adminUsernames);
    return reply.send(await ctx.vault.status());
  });

  app.post('/api/admin/invites', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    const parsed = inviteSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? '参数错误' });
    const invite = await createInvite(ctx.db, {
      code: parsed.data.code,
      maxUses: parsed.data.maxUses,
      ttlSeconds: parsed.data.ttlSeconds,
      createdBy: admin.username,
    });
    await writeAudit(ctx.db, { actor: admin.username, action: 'invite.create', meta: { maxUses: invite.maxUses } }, ctx.config.adminUsernames);
    return reply.code(201).send(invite);
  });

  app.get('/api/admin/invites', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    return reply.send({ invites: await listInvites(ctx.db) });
  });

  app.get('/api/admin/rewrite', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    const systemEnabled = ctx.rewriter.isEnabled();
    const override = await getSetting(ctx.db, SETTING_KEYS.llmNormalizeEnabled);
    const effective = systemEnabled && (override === null ? true : override === 'on');
    return reply.send({
      systemEnabled,
      hasProvider: ctx.rewriter.hasProvider(),
      provider: ctx.config.llm.provider,
      effectiveEnabled: effective,
      mode: ctx.rewriter.hasProvider() ? 'llm' : 'local_rules',
      override: override === null ? null : override === 'on',
    });
  });

  app.put('/api/admin/rewrite', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    const parsed = toggleSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'enabled 必须为布尔值' });
    await setSetting(ctx.db, SETTING_KEYS.llmNormalizeEnabled, parsed.data.enabled ? 'on' : 'off');
    return reply.send({ effectiveEnabled: parsed.data.enabled && ctx.rewriter.isEnabled() });
  });

  // 追责接口：由匿名昵称反查真实身份。强制要求填写事由并写入审计。
  app.post('/api/admin/reveal', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    const parsed = revealSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '请提供匿名昵称、追责事由与至少 K 份密钥分片' });
    }
    let identity: { username: string; userId: string; alias: string } | null = null;
    let status: 'ok' | 'not_found' | 'threshold' | 'invalid_shares' | 'uninitialized' = 'ok';
    try {
      identity = await ctx.vault.revealIdentityWithShares(
        parsed.data.alias.trim(),
        parsed.data.shares,
      );
      if (!identity) status = 'not_found';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('not enough shares')) status = 'threshold';
      else if (msg.includes('invalid shares')) status = 'invalid_shares';
      else if (msg.includes('uninitialized')) status = 'uninitialized';
      else throw err;
    }
    // 审计只记录事由、命中与否、分片数量与结果，绝不记录分片内容
    await writeAudit(
      ctx.db,
      {
        actor: admin.username,
        action: 'identity.reveal',
        meta: {
          reason: parsed.data.reason,
          sharesProvided: parsed.data.shares.length,
          hit: identity !== null,
          status,
        },
      },
      ctx.config.adminUsernames,
    );
    if (status === 'threshold') {
      return reply.code(400).send({ error: '密钥分片数量不足门限 K，无法重组主密钥' });
    }
    if (status === 'invalid_shares') {
      return reply.code(403).send({ error: '密钥分片无效，重组出的主密钥未通过校验' });
    }
    if (status === 'uninitialized') {
      return reply.code(503).send({ error: '身份保险库尚未初始化' });
    }
    if (!identity) return reply.code(404).send({ error: '未找到该匿名身份' });
    return reply.send({ username: identity.username, userId: identity.userId, alias: identity.alias });
  });

  app.get('/api/admin/audit', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    const rows = await ctx.db.query<{ id: string; actor: string | null; action: string; meta: string | null; created_at: number }>(
      `SELECT id, actor, action, meta, created_at FROM audit_log ORDER BY created_at DESC LIMIT 100`,
    );
    return reply.send({
      entries: rows.rows.map((r) => ({
        id: r.id,
        // 读路径兜底：任何漏网的真实用户名一律转为 null / admin#N，绝不落前端
        actor: sanitizeAuditActor(r.actor, ctx.config.adminUsernames),
        action: r.action,
        meta: r.meta ? sanitizeAuditMeta(JSON.parse(r.meta) as unknown, r.action) : null,
        createdAt: r.created_at,
      })),
    });
  });

  // ---- M2 内容管理：消息浏览（游标分页，逐页 20）。匿名性红线：不返回 alias、不返回毫秒时间戳。
  // createdAt 粗化为 dateKey + timeSlot；新增 ref（id 前 8 位不可逆短引用）供展示与删除；
  // keyword 只搜归一化内容，不支持按 alias 搜索。
  app.get('/api/admin/messages', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    const query = request.query as { cursor?: string; limit?: string; keyword?: string };
    let limit = 20;
    if (query.limit) {
      const n = Number.parseInt(query.limit, 10);
      if (Number.isNaN(n) || n < 1 || n > 100) return reply.code(400).send({ error: 'limit 需为 1-100 的整数' });
      limit = n;
    }
    let cursorAt: number | null = null;
    let cursorId: string | null = null;
    if (query.cursor) {
      try {
        const decoded = Buffer.from(query.cursor, 'base64url').toString('utf8');
        const [at, id] = decoded.split('_');
        cursorAt = Number.parseInt(at, 10);
        cursorId = id;
      } catch {
        return reply.code(400).send({ error: '非法的游标' });
      }
    }
    const params: unknown[] = [limit];
    const conds: string[] = [];
    if (cursorAt !== null && cursorId) {
      params.push(cursorAt, cursorId);
      conds.push(`(created_at < $2) OR (created_at = $2 AND id < $3)`);
    }
    // keyword 只作用于消息内容（归一化文本），绝不匹配 alias
    let kw: string | null = null;
    const keyword = typeof query.keyword === 'string' ? query.keyword.trim() : '';
    if (keyword.length > 0) {
      kw = `%${keyword}%`;
      params.push(kw);
      conds.push(`normalized_text ILIKE $${params.length}`);
    }
    const cond = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = await ctx.db.query<{
      id: string;
      normalizedText: string;
      createdAt: number;
      rewritten: boolean;
    }>(
      `SELECT id, normalized_text AS "normalizedText", created_at AS "createdAt", rewritten
       FROM messages ${cond}
       ORDER BY created_at DESC, id DESC LIMIT $1`,
      params,
    );
    const last = rows.rows[rows.rows.length - 1];
    return reply.send({
      entries: rows.rows.map((m) => ({
        id: m.id,
        ref: shortRef(m.id),
        normalizedText: m.normalizedText,
        rewritten: m.rewritten,
        dateKey: dateKeyOf(m.createdAt),
        timeSlot: timeSlotOf(m.createdAt),
      })),
      nextCursor: rows.rows.length === limit && last ? Buffer.from(`${last.createdAt}_${last.id}`).toString('base64url') : null,
    });
  });

  // 物理删除单条消息。支持完整 id 或 8 位 ref（id 前缀短引用）。
  // 审计不涉及原文：meta 只记删除行为与原因；messageId 短引用非身份线索。
  // 注意：预览网关会剥离 DELETE 请求的 body，若再带 application/json 空 body 会触发 400。
  // 因此 reason 优先从 query 读取，body 仅作兼容兜底，缺省给默认值，不报错。
  app.delete('/api/admin/messages/:id', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    const { id } = request.params as { id: string };
    if (!id) return reply.code(400).send({ error: '缺少消息 ID 或 REF' });
    const query = (request.query ?? {}) as { reason?: string };
    const body = (request.body ?? {}) as { reason?: string };
    const reason = typeof query.reason === 'string' && query.reason.length > 0 ? query.reason : body.reason;
    const result = await ctx.db.query<{ id: string }>(
      'DELETE FROM messages WHERE id::text = $1 OR left(id::text, 8) = $1 RETURNING id',
      [id],
    );
    if (result.rows.length === 0) return reply.code(404).send({ error: '消息不存在' });
    await writeAudit(
      ctx.db,
      {
        actor: admin.username,
        action: 'message.delete',
        meta: { ref: shortRef(result.rows[0].id), reason: reason ?? '未填写原因' },
      },
      ctx.config.adminUsernames,
    );
    return reply.send({ ok: true, deleted: true, ref: shortRef(result.rows[0].id) });
  });

  // 封禁匿名昵称（写 banned_at）——消息发送将拒绝，历史归一化文本仍保留
  app.post('/api/admin/aliases/:alias/ban', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    const { alias } = request.params as { alias: string };
    const body = (request.body ?? {}) as { reason?: string };
    const result = await ctx.db.query<{ banned_at: number | null }>(
      'UPDATE aliases SET banned_at = $2 WHERE alias = $1 RETURNING banned_at',
      [alias, Date.now()],
    );
    if (result.rows.length === 0) return reply.code(404).send({ error: '未找到该匿名昵称' });
    await writeAudit(
      ctx.db,
      {
        actor: admin.username,
        action: 'alias.ban',
        // meta 只记不可逆别名短引用与原因，绝不落 alias 明文
        meta: { aliasRef: aliasRefOf(alias), reason: body.reason ?? null },
      },
      ctx.config.adminUsernames,
    );
    return reply.send({ ok: true, banned: true });
  });

  // 解封匿名昵称（清 banned_at）
  app.post('/api/admin/aliases/:alias/unban', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    const { alias } = request.params as { alias: string };
    await ctx.db.query('UPDATE aliases SET banned_at = NULL WHERE alias = $1', [alias]);
    const exists = await ctx.db.query('SELECT alias FROM aliases WHERE alias = $1', [alias]);
    if (exists.rows.length === 0) return reply.code(404).send({ error: '未找到该匿名昵称' });
    await writeAudit(
      ctx.db,
      { actor: admin.username, action: 'alias.unban', meta: { aliasRef: aliasRefOf(alias) } },
      ctx.config.adminUsernames,
    );
    return reply.send({ ok: true, banned: false });
  });

  // ---------------------------------------------------------------------------
  // 模型管理：配置（GET/保存）、连通性测试、用量统计。全部 requireAdmin。
  // settings 表 > env > 默认值；改配即热生效，无需重启服务。
  // API Key 以 AES-256-GCM 密文存 llm.apiKeyEnc，任何响应/审计只含掩码。
  // ---------------------------------------------------------------------------

  const llmConfigPutSchema = z.object({
    provider: z.enum(['agent', 'coze', 'openai', 'ollama']).optional(),  // 'coze' 为历史别名
    baseUrl: z.string().max(2048).optional().nullable(),
    model: z.string().max(200).optional().nullable(),
    timeoutMs: z.number().int().min(100).max(600_000).optional(),
    onFailure: z.enum(['passthrough', 'error']).optional(),
    enabled: z.boolean().optional(),
    // 语义：省略 / null = 不改；空串 = 清除（回落 env）；非空 = 加密覆盖
    apiKey: z.string().max(4096).optional().nullable(),
  });

  // 读当前生效配置（含掩码；永不回传明文 Key）
  app.get('/api/admin/llm/config', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    const llm = await resolveLlmConfig(ctx.config, ctx.db);
    return reply.send({
      provider: llm.provider === 'off' ? 'openai' : llm.provider,
      baseUrl: llm.baseUrl,
      model: llm.model,
      timeoutMs: llm.timeoutMs,
      onFailure: llm.onFailure === 'passthrough' ? 'passthrough' : 'error',
      enabled: llm.enabled,
      apiKeyMasked: maskApiKey(llm.apiKey),
    });
  });

  // 保存配置。逐字段覆盖（省略的不动）；apiKey 按上文语义处理；改动项入审计（只记字段名不记值）。
  app.put('/api/admin/llm/config', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    const parsed = llmConfigPutSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: `配置参数不合法：${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}` });
    }
    const b = parsed.data;
    const changed: string[] = [];

    if (b.provider !== undefined) {
      await setSetting(ctx.db, SETTING_KEYS.llmProvider, b.provider);
      changed.push('provider');
    }
    if (b.baseUrl !== undefined) {
      if (b.baseUrl === null || b.baseUrl.trim() === '') {
        await deleteSetting(ctx.db, SETTING_KEYS.llmBaseUrl);
      } else {
        await setSetting(ctx.db, SETTING_KEYS.llmBaseUrl, b.baseUrl.trim());
      }
      changed.push('baseUrl');
    }
    if (b.model !== undefined) {
      if (b.model === null || b.model.trim() === '') {
        await deleteSetting(ctx.db, SETTING_KEYS.llmModel);
      } else {
        await setSetting(ctx.db, SETTING_KEYS.llmModel, b.model.trim());
      }
      changed.push('model');
    }
    if (b.timeoutMs !== undefined) {
      await setSetting(ctx.db, SETTING_KEYS.llmTimeoutMs, String(b.timeoutMs));
      changed.push('timeoutMs');
    }
    if (b.onFailure !== undefined) {
      await setSetting(ctx.db, SETTING_KEYS.llmOnFailure, b.onFailure);
      changed.push('onFailure');
    }
    if (b.enabled !== undefined) {
      await setSetting(ctx.db, SETTING_KEYS.llmNormalizeEnabled, b.enabled ? 'on' : 'off');
      changed.push('enabled');
    }
    if (b.apiKey !== undefined && b.apiKey !== null) {
      if (b.apiKey === '') {
        await deleteSetting(ctx.db, SETTING_KEYS.llmApiKeyEnc);
      } else {
        await setSetting(
          ctx.db,
          SETTING_KEYS.llmApiKeyEnc,
          encryptApiKey(b.apiKey, ctx.config.messageEncryptionKey),
        );
      }
      changed.push('apiKey');
    }
    if (changed.length === 0) {
      return reply.code(400).send({ error: '没有需要保存的配置项' });
    }
    await writeAudit(
      ctx.db,
      {
        actor: admin.username,
        action: 'llm.config.update',
        meta: { changed },
      },
      ctx.config.adminUsernames,
    );

    const fresh = await resolveLlmConfig(ctx.config, ctx.db);
    return reply.send({
      provider: fresh.provider === 'off' ? 'openai' : fresh.provider,
      baseUrl: fresh.baseUrl,
      model: fresh.model,
      timeoutMs: fresh.timeoutMs,
      onFailure: fresh.onFailure === 'passthrough' ? 'passthrough' : 'error',
      enabled: fresh.enabled,
      apiKeyMasked: maskApiKey(fresh.apiKey),
    });
  });

  // 连通性测试：用当前生效配置真发一条改写；失败回 400 + 错误摘要（同一条 usage 已落库 ok=false）
  app.post('/api/admin/llm/test', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    const result = await ctx.rewriter.runTest();
    await writeAudit(
      ctx.db,
      {
        actor: admin.username,
        action: 'llm.test',
        meta: { provider: result.provider, model: result.model, ok: result.ok, latencyMs: result.latencyMs },
      },
      ctx.config.adminUsernames,
    );
    if (!result.ok) {
      return reply.code(400).send({
        ok: false,
        provider: result.provider,
        model: result.model,
        latencyMs: result.latencyMs,
        error: result.error ?? 'LLM 服务不可用',
      });
    }
    return reply.send(result);
  });

  // 用量统计：累计汇总 + 最近 N 条明细（默认 20，上限 100）
  app.get('/api/admin/llm/usage', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    const rawLimit = Number((request.query as { limit?: unknown })?.limit ?? 20);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : 20;

    const totalRows = await ctx.db.query<{
      calls: string;
      inputTokens: string;
      outputTokens: string;
      totalTokens: string;
      avgLatencyMs: string | null;
      failCount: string;
    }>(
      `SELECT COUNT(*)::text AS "calls",
              COALESCE(SUM(input_tokens), 0)::text AS "inputTokens",
              COALESCE(SUM(output_tokens), 0)::text AS "outputTokens",
              COALESCE(SUM(total_tokens), 0)::text AS "totalTokens",
              AVG(latency_ms)::text AS "avgLatencyMs",
              COUNT(*) FILTER (WHERE ok = false)::text AS "failCount"
       FROM llm_usage`,
    );
    const t = totalRows.rows[0];
    const recentRows = await ctx.db.query<{
      id: string;
      provider: string;
      model: string;
      inputTokens: number | null;
      outputTokens: number | null;
      totalTokens: number | null;
      latencyMs: number | null;
      ok: boolean;
      error: string | null;
      createdAt: number;
    }>(
      `SELECT id, provider, model,
              input_tokens AS "inputTokens",
              output_tokens AS "outputTokens",
              total_tokens AS "totalTokens",
              latency_ms AS "latencyMs",
              ok,
              error,
              created_at AS "createdAt"
       FROM llm_usage ORDER BY created_at DESC, id DESC LIMIT $1`,
      [limit],
    );
    const avg = t?.avgLatencyMs != null && t.avgLatencyMs !== '' ? Number(t.avgLatencyMs) : null;
    return reply.send({
      total: {
        calls: Number(t?.calls ?? 0),
        inputTokens: Number(t?.inputTokens ?? 0),
        outputTokens: Number(t?.outputTokens ?? 0),
        totalTokens: Number(t?.totalTokens ?? 0),
        avgLatencyMs: avg !== null ? Math.round(avg) : 0,
        failCount: Number(t?.failCount ?? 0),
      },
      recent: recentRows.rows,
    });
  });
}
