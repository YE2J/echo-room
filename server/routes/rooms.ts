// ABOUTME: M3 多聊天室路由（普通用户 + 管理员）。
// 用户侧：可见房间列表、建房申请、成员加入/退出、房间改名/归档（房主或管理员）。
// 管理侧：审批建房申请（通过即在同一事务创建房间并把申请人设为 owner）、管理员直建房间。
// 安全红线：列表与详情只返回房间元信息与 isOwner/isMember 等派生布尔，绝不暴露真实身份/成员用户名。
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext, AuthenticatedUser } from '../context';
import { requireAdmin, requireRoomAccess, requireUser } from './helpers';
import { writeAudit } from '../services/audit';
import { adminLabel, shortRef } from '../services/privacy';
import {
  createRoom,
  createRoomRequest,
  addRoomMember,
  removeRoomMember,
  renameRoom,
  archiveRoom,
  unarchiveRoom,
  approveRoomRequest,
  rejectRoomRequest,
  listRoomRequests,
  listRoomMembers,
  listVisibleRooms,
  listAdminRooms,
  deleteRoomPermanent,
  getRoomById,
  type RoomRow,
} from '../services/rooms';

const createRoomSchema = z.object({
  name: z.string().trim().min(1).max(32),
  type: z.enum(['public', 'private']).default('public'),
  description: z.string().trim().max(200).optional(),
});

const renameRoomSchema = z.object({
  name: z.string().trim().min(1).max(32),
  description: z.string().trim().max(200).optional(),
});

const memberSchema = z.object({
  username: z.string().trim().min(1).max(64),
});

const rejectRequestSchema = z.object({
  reason: z.string().trim().min(1).max(300),
});

/** 服务层业务错误 → HTTP 状态码 */
function errorStatus(message: string): number {
  switch (message) {
    case 'NOT_FOUND':
      return 404;
    case 'ALREADY_DECIDED':
      return 409;
    case 'ROOM_NAME_TAKEN':
      return 409;
    case 'REQUEST_EXISTS':
      return 409;
    case 'USER_NOT_FOUND':
      return 404;
    case 'NOT_A_MEMBER':
      return 404;
    case 'CANNOT_REMOVE_OWNER':
      return 400;
    case 'REQUESTER_NOT_FOUND':
      return 400;
    case 'CANNOT_DELETE_SYSTEM_ROOM':
      return 400;
    default:
      return 500;
  }
}

/**
 * 归档/恢复的权限判定：管理员可操作任意房间；房主只能操作自己创建的房间。
 * 注意不能用 resolveAccess（已归档房间对所有人返回 none），直接按 owner_user_id 判定。
 */
async function requireAdminOrRoomOwner(
  request: Parameters<typeof requireUser>[0],
  reply: Parameters<typeof requireUser>[1],
  ctx: AppContext,
  roomId: string,
): Promise<{ user: AuthenticatedUser; room: RoomRow } | null> {
  const user = await requireUser(request, reply, ctx);
  if (!user) return null;
  const room = await getRoomById(ctx.db, roomId);
  if (!room) {
    await reply.code(404).send({ error: '房间不存在' });
    return null;
  }
  if (!user.isAdmin && room.ownerUserId !== user.id) {
    await reply.code(403).send({ error: '权限不足：仅管理员或房主可操作' });
    return null;
  }
  return { user, room };
}

export function registerRoomRoutes(app: FastifyInstance, ctx: AppContext): void {
  // 可见房间列表：管理员全部 / 公开房全部 / 私密房仅成员
  app.get('/api/rooms', async (request, reply) => {
    const user = await requireUser(request, reply, ctx);
    if (!user) return reply;
    const rooms = await listVisibleRooms(ctx.db, user);
    return reply.send({ rooms });
  });

  // 建房申请（普通用户发起，管理员审批）
  app.post('/api/rooms/requests', async (request, reply) => {
    const user = await requireUser(request, reply, ctx);
    if (!user) return reply;
    const parsed = createRoomSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '请提供房间名（1-32 字）与类型' });
    try {
      const created = await createRoomRequest(ctx.db, {
        name: parsed.data.name,
        type: parsed.data.type,
        description: parsed.data.description ?? null,
        requester: user.username,
      });
      await writeAudit(ctx.db, {
        actor: null,
        action: 'room_request.create',
        meta: { roomName: created.name, type: created.type },
      });
      return reply.code(201).send(created);
    } catch (err) {
      const message = err instanceof Error ? err.message : '服务器内部错误';
      return reply.code(errorStatus(message)).send({ error: errorMessage(message) });
    }
  });

  // 我的建房申请列表（普通用户侧；管理员侧见 /api/admin/room-requests）
  app.get('/api/rooms/requests', async (request, reply) => {
    const user = await requireUser(request, reply, ctx);
    if (!user) return reply;
    const query = request.query as { status?: string };
    const status = query.status && ['pending', 'approved', 'rejected'].includes(query.status)
      ? (query.status as 'pending' | 'approved' | 'rejected')
      : undefined;
    const requests = await listRoomRequests(ctx.db, { status, requester: user.username, limit: 50 });
    return reply.send({ requests });
  });

  // 房间改名/改简介：仅房主或管理员
  app.put('/api/rooms/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const access = await requireRoomAccess(request, reply, ctx, id, 'owner');
    if (!access) return reply;
    const parsed = renameRoomSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '请提供房间名（1-32 字）' });
    try {
      const room = await renameRoom(ctx.db, id, parsed.data.name, parsed.data.description);
      await writeAudit(
        ctx.db,
        {
          actor: access.user.username,
          action: 'room.update',
          meta: {
            roomId: id,
            roomName: parsed.data.name,
            description: parsed.data.description ?? null,
          },
        },
        ctx.config.adminUsernames,
      );
      return reply.send({ room });
    } catch (err) {
      const message = err instanceof Error ? err.message : '服务器内部错误';
      return reply.code(errorStatus(message)).send({ error: errorMessage(message) });
    }
  });

  // 归档房间：仅房主或管理员（reason 走 query，预览网关不剥离 GET/DELETE 的 query）
  app.delete('/api/rooms/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const access = await requireRoomAccess(request, reply, ctx, id, 'owner');
    if (!access) return reply;
    const query = request.query as { reason?: string };
    try {
      const room = await archiveRoom(ctx.db, id);
      await writeAudit(
        ctx.db,
        {
          actor: access.user.username,
          action: 'room.archive',
          meta: { roomId: id, roomName: room.name, reason: query.reason ?? null },
        },
        ctx.config.adminUsernames,
      );
      return reply.send({ room });
    } catch (err) {
      const message = err instanceof Error ? err.message : '服务器内部错误';
      return reply.code(errorStatus(message)).send({ error: errorMessage(message) });
    }
  });

  // 成员列表（私密房成员管理）：仅房主或管理员。返回 username+role，仅在管理弹层使用
  app.get('/api/rooms/:id/members', async (request, reply) => {
    const { id } = request.params as { id: string };
    const access = await requireRoomAccess(request, reply, ctx, id, 'owner');
    if (!access) return reply;
    try {
      const members = await listRoomMembers(ctx.db, id);
      return reply.send({ members });
    } catch (err) {
      const message = err instanceof Error ? err.message : '服务器内部错误';
      return reply.code(errorStatus(message)).send({ error: errorMessage(message) });
    }
  });

  // 添加成员（私密房邀请）：仅房主或管理员
  app.post('/api/rooms/:id/members', async (request, reply) => {
    const { id } = request.params as { id: string };
    const access = await requireRoomAccess(request, reply, ctx, id, 'owner');
    if (!access) return reply;
    const parsed = memberSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '请提供要加入成员的用户名' });
    try {
      await addRoomMember(ctx.db, id, parsed.data.username);
      await writeAudit(
        ctx.db,
        {
          actor: access.user.username,
          action: 'room.member.add',
          // 匿名性红线：meta 严禁写 userId，只记房间与行为本身
          meta: { roomId: id },
        },
        ctx.config.adminUsernames,
      );
      return reply.send({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : '服务器内部错误';
      return reply.code(errorStatus(message)).send({ error: errorMessage(message) });
    }
  });

  // 移除成员：仅房主或管理员（username 走 query）
  app.delete('/api/rooms/:id/members', async (request, reply) => {
    const { id } = request.params as { id: string };
    const access = await requireRoomAccess(request, reply, ctx, id, 'owner');
    if (!access) return reply;
    const query = request.query as { username?: string };
    if (!query.username || query.username.trim().length === 0) {
      return reply.code(400).send({ error: '请提供要移除成员的用户名' });
    }
    try {
      await removeRoomMember(ctx.db, id, query.username.trim());
      await writeAudit(
        ctx.db,
        {
          actor: access.user.username,
          action: 'room.member.remove',
          // 匿名性红线：meta 严禁写 username
          meta: { roomId: id },
        },
        ctx.config.adminUsernames,
      );
      return reply.send({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : '服务器内部错误';
      return reply.code(errorStatus(message)).send({ error: errorMessage(message) });
    }
  });
}

export function registerAdminRoomRoutes(app: FastifyInstance, ctx: AppContext): void {
  // 房间管理：全部房间（含已归档）+ 归档/恢复/彻底删除。
  // 安全红线：只返回脱敏视图（hasOwner 布尔 + 计数），绝不外泄真实 owner 身份。

  app.get('/api/admin/rooms', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    const rooms = await listAdminRooms(ctx.db);
    return reply.send({
      rooms: rooms.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        description: r.description,
        hasOwner: r.hasOwner,
        memberCount: r.memberCount,
        messageCount: r.messageCount,
        archivedAt: r.archivedAt,
        createdAt: r.createdAt,
      })),
    });
  });

  // 归档房间：管理员任意、房主仅自己的房间。正确写入 archived_at。
  app.post('/api/admin/rooms/:id/archive', async (request, reply) => {
    const { id } = request.params as { id: string };
    const access = await requireAdminOrRoomOwner(request, reply, ctx, id);
    if (!access) return reply;
    try {
      await archiveRoom(ctx.db, id);
      await writeAudit(
        ctx.db,
        {
          actor: access.user.username,
          action: 'room.archive',
          // 匿名性红线：meta 只放短引用，不写房间名、不写 owner
          meta: { roomRef: shortRef(id) },
        },
        ctx.config.adminUsernames,
      );
      return reply.send({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : '服务器内部错误';
      return reply.code(errorStatus(message)).send({ error: errorMessage(message) });
    }
  });

  // 恢复房间：管理员任意、房主仅自己的房间。清空 archived_at 后重新可见可进。
  app.post('/api/admin/rooms/:id/restore', async (request, reply) => {
    const { id } = request.params as { id: string };
    const access = await requireAdminOrRoomOwner(request, reply, ctx, id);
    if (!access) return reply;
    try {
      await unarchiveRoom(ctx.db, id);
      await writeAudit(
        ctx.db,
        {
          actor: access.user.username,
          action: 'room.restore',
          meta: { roomRef: shortRef(id) },
        },
        ctx.config.adminUsernames,
      );
      return reply.send({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : '服务器内部错误';
      return reply.code(errorStatus(message)).send({ error: errorMessage(message) });
    }
  });

  // 彻底删除房间：仅管理员。级联清理消息/成员/申请/pending 溯源请求。大厅（系统房间）禁删。
  app.delete('/api/admin/rooms/:id', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    const { id } = request.params as { id: string };
    try {
      const room = await getRoomById(ctx.db, id);
      if (!room) return reply.code(404).send({ error: '房间不存在' });
      if (room.ownerUserId === null) {
        return reply.code(400).send({ error: errorMessage('CANNOT_DELETE_SYSTEM_ROOM') });
      }
      await deleteRoomPermanent(ctx.db, id, room.name);
      await writeAudit(
        ctx.db,
        {
          actor: admin.username,
          action: 'room.delete',
          meta: { roomRef: shortRef(id) },
        },
        ctx.config.adminUsernames,
      );
      return reply.send({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : '服务器内部错误';
      return reply.code(errorStatus(message)).send({ error: errorMessage(message) });
    }
  });

  // 管理员直建房间（owner = 管理员；也可用于后台快速开房）
  app.post('/api/admin/rooms', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    const parsed = createRoomSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '请提供房间名（1-32 字）与类型' });
    try {
      const room = await createRoom(ctx.db, {
        name: parsed.data.name,
        type: parsed.data.type,
        description: parsed.data.description ?? null,
        ownerUserId: admin.id,
      });
      await writeAudit(
        ctx.db,
        {
          actor: admin.username,
          action: 'room.create',
          meta: { roomId: room.id, roomName: room.name, type: room.type },
        },
        ctx.config.adminUsernames,
      );
      return reply.code(201).send({ room });
    } catch (err) {
      const message = err instanceof Error ? err.message : '服务器内部错误';
      return reply.code(errorStatus(message)).send({ error: errorMessage(message) });
    }
  });

  // 建房申请列表（管理员视角，全部申请）
  app.get('/api/admin/room-requests', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    const query = request.query as { status?: string };
    const status = query.status && ['pending', 'approved', 'rejected'].includes(query.status)
      ? (query.status as 'pending' | 'approved' | 'rejected')
      : undefined;
    const requests = await listRoomRequests(ctx.db, { status, limit: 50 });
    // 管理视角脱敏：不暴露申请人/审批人真实用户名（内容治理，不做身份治理）
    return reply.send({
      requests: requests.map((r) => ({
        ...r,
        requester: null,
        reviewedBy: r.reviewedBy ? adminLabel(ctx.config.adminUsernames, r.reviewedBy) ?? null : null,
      })),
    });
  });

  // 审批通过：创建房间 + owner 成员 + 状态更新（同一事务）
  app.post('/api/admin/room-requests/:id/approve', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    const { id } = request.params as { id: string };
    if (!/^\d+$/.test(id)) return reply.code(400).send({ error: '非法的申请 ID' });
    try {
      const { room, request: updated } = await approveRoomRequest(ctx.db, id, admin.username);
      await writeAudit(
        ctx.db,
        {
          actor: admin.username,
          action: 'room_request.approve',
          meta: { requestId: id, roomId: room.id, roomName: room.name },
        },
        ctx.config.adminUsernames,
      );
      await writeAudit(
        ctx.db,
        {
          actor: admin.username,
          action: 'room.create',
          meta: { roomId: room.id, roomName: room.name, type: room.type, viaRequest: true },
        },
        ctx.config.adminUsernames,
      );
      return reply.send({
        room,
        request: { ...updated, requester: null, reviewedBy: adminLabel(ctx.config.adminUsernames, updated.reviewedBy ?? '') ?? null },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '服务器内部错误';
      return reply.code(errorStatus(message)).send({ error: errorMessage(message) });
    }
  });

  // 审批驳回
  app.post('/api/admin/room-requests/:id/reject', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    const { id } = request.params as { id: string };
    if (!/^\d+$/.test(id)) return reply.code(400).send({ error: '非法的申请 ID' });
    const parsed = rejectRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '请填写驳回事由' });
    try {
      const updated = await rejectRoomRequest(ctx.db, id, admin.username, parsed.data.reason);
      await writeAudit(
        ctx.db,
        {
          actor: admin.username,
          action: 'room_request.reject',
          meta: { requestId: id, roomName: updated.name, reason: parsed.data.reason },
        },
        ctx.config.adminUsernames,
      );
      return reply.send({ request: { ...updated, requester: null, reviewedBy: adminLabel(ctx.config.adminUsernames, updated.reviewedBy ?? '') ?? null } });
    } catch (err) {
      const message = err instanceof Error ? err.message : '服务器内部错误';
      return reply.code(errorStatus(message)).send({ error: errorMessage(message) });
    }
  });
}

/** 业务错误转用户可读文案（其余按原始 message，避免泄露内部细节） */
function errorMessage(message: string): string {
  switch (message) {
    case 'NOT_FOUND':
      return '房间或申请不存在';
    case 'ALREADY_DECIDED':
      return '该申请已处理，无法重复操作';
    case 'ROOM_NAME_TAKEN':
      return '房间名已存在';
    case 'REQUEST_EXISTS':
      return '已有同名申请待审批';
    case 'USER_NOT_FOUND':
      return '用户不存在';
    case 'NOT_A_MEMBER':
      return '该用户不是房间成员';
    case 'CANNOT_REMOVE_OWNER':
      return '不能移除房主';
    case 'REQUESTER_NOT_FOUND':
      return '申请人账号不存在';
    case 'CANNOT_DELETE_SYSTEM_ROOM':
      return '默认大厅为系统房间，不可彻底删除';
    default:
      return message;
  }
}