// ABOUTME: 管理路由（需 admin）：保险库状态/解封/封存、邀请码签发、改写开关、
// 匿名身份追责（强审计）、审计日志查看。保险库分片只在内存中使用，绝不入库/入日志。
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { requireAdmin } from './helpers';
import { authenticate, createInvite, listInvites, AuthError } from '../services/auth';
import { writeAudit } from '../services/audit';
import { getSetting, setSetting, SETTING_KEYS } from '../services/settings';

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
  // 保险库状态：允许匿名探测（登录页据此提示注册可用性），只暴露状态枚举与门限参数
  app.get('/api/admin/vault/status', async (_request, reply) => {
    return reply.send(await ctx.vault.status());
  });

  app.post('/api/admin/vault/unseal', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    const parsed = unsealSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '请提供至少一个密钥分片' });
    try {
      await ctx.vault.unseal(parsed.data.shares);
      await writeAudit(ctx.db, {
        actor: admin.username,
        action: 'vault.unseal',
        meta: { sharesProvided: parsed.data.shares.length },
      });
      return reply.send(await ctx.vault.status());
    } catch (err) {
      await writeAudit(ctx.db, { actor: admin.username, action: 'vault.unseal_failed' });
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
        await writeAudit(ctx.db, { actor: admin.username, action: 'vault.break_glass_denied' });
        return reply.code(403).send({ error: '需要管理员权限' });
      }
      await ctx.vault.unseal(parsed.data.shares);
      await writeAudit(ctx.db, {
        actor: admin.username,
        action: 'vault.break_glass_unseal',
        meta: { sharesProvided: parsed.data.shares.length },
      });
      return reply.send(await ctx.vault.status());
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      await writeAudit(ctx.db, { actor: parsed.data.username, action: 'vault.break_glass_failed' }).catch(() => undefined);
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post('/api/admin/vault/seal', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    ctx.vault.seal();
    await writeAudit(ctx.db, { actor: admin.username, action: 'vault.seal' });
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
    await writeAudit(ctx.db, { actor: admin.username, action: 'invite.create', meta: { maxUses: invite.maxUses } });
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
    await writeAudit(ctx.db, {
      actor: admin.username,
      action: 'identity.reveal',
      meta: {
        reason: parsed.data.reason,
        sharesProvided: parsed.data.shares.length,
        hit: identity !== null,
        status,
      },
    });
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
        actor: r.actor,
        action: r.action,
        meta: r.meta ? (JSON.parse(r.meta) as unknown) : null,
        createdAt: r.created_at,
      })),
    });
  });
}
