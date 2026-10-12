// ABOUTME: 认证路由：邀请码准入的本地注册/登录、当前匿名身份查询、登出。
// 任何响应都不回传真实身份给前端（/me 只返回匿名昵称）。
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { authenticate, AuthError, registerUser } from '../services/auth';
import { signToken } from '../crypto/token';
import { writeAudit } from '../services/audit';
import { requireUser } from './helpers';
import { aliasVisual } from '../services/alias';

const registerSchema = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(8).max(200),
  inviteCode: z.string().min(1).max(40),
});

const loginSchema = z.object({
  username: z.string().min(1).max(32),
  password: z.string().min(1).max(200),
});

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/auth/register', async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? '参数错误' });
    }

    if (!ctx.vault.isUnsealed()) {
      return reply.code(503).send({
        error: '身份保险库处于封存状态，暂不接受新用户注册，请联系管理员解封',
        code: 'vault_sealed',
      });
    }

    try {
      const user = await registerUser(ctx.db, ctx.vault, parsed.data);
      const token = signToken(
        { sub: user.id, username: user.username, role: user.isAdmin ? 'admin' : 'user' },
        ctx.config.jwtSecret,
        ctx.config.tokenTtlSeconds,
      );
      setAuthCookie(reply, token, ctx);
      const identity = await ctx.vault.findIdentityByUser(user.id);
      await writeAudit(ctx.db, { actor: user.username, action: 'auth.register', meta: { via: 'invite' } });
      await writeAudit(ctx.db, { actor: user.username, action: 'invite.consume' });
      return reply.code(201).send({
        alias: identity?.alias ?? null,
        visual: identity ? aliasVisual(identity.alias) : null,
        isAdmin: user.isAdmin,
        wsToken: token,
      });
    } catch (err) {
      if (err instanceof AuthError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '请输入用户名和密码' });
    }
    try {
      const user = await authenticate(ctx.db, parsed.data.username, parsed.data.password, ctx.config);
      const token = signToken(
        { sub: user.id, username: user.username, role: user.isAdmin ? 'admin' : 'user' },
        ctx.config.jwtSecret,
        ctx.config.tokenTtlSeconds,
      );
      setAuthCookie(reply, token, ctx);
      // 保险库封存时登录仍应通过（管理员需据此进入解封流程），只是取不到匿名昵称
      let identity: { alias: string } | null = null;
      if (ctx.vault.isUnsealed()) {
        identity = await ctx.vault.findIdentityByUser(user.id);
      }
      await writeAudit(ctx.db, { actor: user.username, action: 'auth.login', meta: { vault: ctx.vault.isUnsealed() ? 'unsealed' : 'sealed' } });
      return reply.send({
        alias: identity?.alias ?? null,
        visual: identity ? aliasVisual(identity.alias) : null,
        isAdmin: user.isAdmin,
        vaultSealed: !ctx.vault.isUnsealed(),
        wsToken: token,
      });
    } catch (err) {
      if (err instanceof AuthError) {
        await writeAudit(ctx.db, {
          actor: parsed.data.username,
          action: 'auth.login_failed',
        });
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get('/api/auth/me', async (request, reply) => {
    const user = await requireUser(request, reply, ctx);
    if (!user) return reply;
    return reply.send({
      alias: user.alias,
      visual: aliasVisual(user.alias),
      isAdmin: user.isAdmin,
    });
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    reply.setCookie('echo_token', '', {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.config.isProd,
      expires: new Date(0),
    });
    return reply.send({ ok: true });
  });
}

function setAuthCookie(reply: FastifyReply, token: string, ctx: AppContext): void {
  reply.setCookie('echo_token', token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.isProd,
    maxAge: ctx.config.tokenTtlSeconds,
  });
}
