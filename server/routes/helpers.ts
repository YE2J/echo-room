// ABOUTME: Fastify 鉴权工具：从 Cookie / Authorization 头解析 JWT 并加载用户与匿名身份。
import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyToken } from '../crypto/token';
import { getUserById } from '../services/auth';
import { VaultSealedError } from '../services/vault';
import type { AppContext, AuthenticatedUser } from '../context';

function extractToken(request: FastifyRequest): string | null {
  const cookieHeader = request.headers.cookie;
  if (cookieHeader) {
    const match = cookieHeader.split(';').map((p) => p.trim()).find((p) => p.startsWith('echo_token='));
    if (match) return decodeURIComponent(match.slice('echo_token='.length));
  }
  const auth = request.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

export async function requireUser(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: AppContext,
): Promise<AuthenticatedUser | null> {
  const token = extractToken(request);
  if (!token) {
    await reply.code(401).send({ error: '未登录' });
    return null;
  }
  let payload;
  try {
    payload = verifyToken(token, ctx.config.jwtSecret);
  } catch {
    await reply.code(401).send({ error: '登录已过期，请重新登录' });
    return null;
  }
  const user = await getUserById(ctx.db, payload.sub, ctx.config);
  if (!user) {
    await reply.code(401).send({ error: '账户不存在' });
    return null;
  }

  let identity: Awaited<ReturnType<typeof ctx.vault.findIdentityByUser>>;
  try {
    identity = await ctx.vault.findIdentityByUser(user.id);
  } catch (err) {
    if (err instanceof VaultSealedError) {
      await reply.code(503).send({ error: '身份保险库已封存，暂时无法使用，请联系管理员解封', code: 'vault_sealed' });
      return null;
    }
    throw err;
  }
  if (!identity) {
    await reply.code(403).send({ error: '匿名身份缺失' });
    return null;
  }
  return {
    id: user.id,
    username: user.username,
    isAdmin: user.isAdmin,
    aliasId: identity.aliasId,
    alias: identity.alias,
  };
}

export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: AppContext,
): Promise<AuthenticatedUser | null> {
  const user = await requireUser(request, reply, ctx);
  if (!user) return null;
  if (!user.isAdmin) {
    await reply.code(403).send({ error: '需要管理员权限' });
    return null;
  }
  return user;
}
