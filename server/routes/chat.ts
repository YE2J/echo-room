// ABOUTME: 聊天相关 HTTP 路由：历史消息分页（只返回归一化文本 + 匿名昵称）。
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { listRecentMessages } from '../services/messages';
import { requireUser } from './helpers';
import { aliasVisual } from '../services/alias';
import { getSetting, SETTING_KEYS } from '../services/settings';

const historyQuerySchema = {
  type: 'object',
  properties: {
    before: { type: 'string' },
    limit: { type: 'number' },
  },
  additionalProperties: true,
} as const;

export function registerChatRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/chat/history', { schema: { querystring: historyQuerySchema } }, async (request, reply) => {
    const user = await requireUser(request, reply, ctx);
    if (!user) return reply;

    const query = request.query as { before?: string; limit?: number };
    const before = query.before ? Number(query.before) : undefined;
    const messages = await listRecentMessages(ctx.db, {
      before: before && Number.isFinite(before) ? before : undefined,
      limit: query.limit ?? 50,
    });

    const rewriteOverride = await getSetting(ctx.db, SETTING_KEYS.llmNormalizeEnabled);
    const rewriteEnabled =
      rewriteOverride === null ? ctx.rewriter.isEnabled() : rewriteOverride === 'on';

    return reply.send({
      messages: messages.map((m) => ({ ...m, hue: aliasVisual(m.aliasName).hue })),
      rewriteEnabled,
    });
  });
}
