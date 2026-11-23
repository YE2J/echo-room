// ABOUTME: 聊天相关 HTTP 路由：历史消息分页（只返回归一化文本 + 匿名昵称）。
// M3：支持 roomId 参数（缺省回退到默认大厅，保证老前端不炸）。
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { listRecentMessages } from '../services/messages';
import { requireRoomAccess } from './helpers';
import { aliasVisual } from '../services/alias';
import { getSetting, SETTING_KEYS } from '../services/settings';
import { getDefaultRoomId, getRoomById } from '../services/rooms';

const historyQuerySchema = {
  type: 'object',
  properties: {
    before: { type: 'string' },
    limit: { type: 'number' },
    roomId: { type: 'string' },
  },
  additionalProperties: true,
} as const;

export function registerChatRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/chat/history', { schema: { querystring: historyQuerySchema } }, async (request, reply) => {
    // requireRoomAccess 内含 requireUser 鉴权 + 房间可见性校验（公开房全员/私密房仅成员/管理员全部）
    const query = request.query as { before?: string; limit?: number; roomId?: string };
    // 缺省 roomId → 默认大厅（老前端不带 roomId 时行为不变）
    let roomId = query.roomId && query.roomId.length > 0 ? query.roomId : await getDefaultRoomId(ctx.db);
    const room = await getRoomById(ctx.db, roomId);
    if (!room || room.archivedAt !== null) {
      return reply.code(404).send({ error: '房间不存在' });
    }
    const accessCheck = await requireRoomAccess(request, reply, ctx, roomId, 'public');
    if (!accessCheck) return reply;
    roomId = room.id;

    const before = query.before ? Number(query.before) : undefined;
    const messages = await listRecentMessages(ctx.db, {
      roomId,
      before: before && Number.isFinite(before) ? before : undefined,
      limit: query.limit ?? 50,
    });

    const rewriteOverride = await getSetting(ctx.db, SETTING_KEYS.llmNormalizeEnabled);
    const rewriteEnabled =
      rewriteOverride === null ? ctx.rewriter.isEnabled() : rewriteOverride === 'on';

    return reply.send({
      roomId,
      messages: messages.map((m) => ({ ...m, hue: aliasVisual(m.aliasName).hue })),
      rewriteEnabled,
    });
  });
}