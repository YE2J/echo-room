// ABOUTME: M3 多聊天室数据服务：默认大厅幂等迁移、房间可见列表、访问权判定、
// 建房申请审批（通过即在同一事务创建房间 + owner 成员）、成员管理、改名/归档。
// 安全红线：本文件所有返回给前端的数据只含房间元信息与匿名侧字段，绝不含真实身份。
import type { DatabaseClient } from '../db';
import type { AuthenticatedUser } from '../context';

export const DEFAULT_ROOM_NAME = '大厅';

export interface RoomRow {
  id: string;
  name: string;
  type: 'public' | 'private';
  description: string | null;
  ownerUserId: string | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** 前端可见的房间视图：isOwner/isMember 由当前用户动态判定，memberCount/lastMessageAt 聚合而来 */
export interface RoomView extends Omit<RoomRow, 'ownerUserId'> {
  isOwner: boolean;
  isMember: boolean;
  memberCount: number;
  lastMessageAt: number | null;
}

/** 访问权等级：admin > owner > member > public > none（顺序即判定次序） */
export type RoomAccess = 'admin' | 'owner' | 'member' | 'public' | 'none';

export interface RoomRequestRow {
  id: string;
  name: string;
  type: 'public' | 'private';
  description: string | null;
  requester: string;
  status: 'pending' | 'approved' | 'rejected';
  rejectReason: string | null;
  reviewedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// 默认大厅（幂等）
// ---------------------------------------------------------------------------

export async function seedDefaultRoom(db: DatabaseClient): Promise<string> {
  const now = Date.now();
  // 幂等：房间名唯一，ON CONFLICT DO NOTHING，重复启动不重复插
  await db.query(
    `INSERT INTO rooms (name, type, description, owner_user_id, created_at, updated_at)
     VALUES ($1, 'public', '公共默认房间，所有成员可见可进', NULL, $2, $2)
     ON CONFLICT (name) DO NOTHING`,
    [DEFAULT_ROOM_NAME, now],
  );
  const rows = await db.query<{ id: string }>('SELECT id FROM rooms WHERE name = $1', [DEFAULT_ROOM_NAME]);
  const lobbyId = rows.rows[0].id;
  // 历史消息（room_id IS NULL）全部回填到大厅；已归属的消息不动
  await db.query('UPDATE messages SET room_id = $1 WHERE room_id IS NULL', [lobbyId]);
  return lobbyId;
}

export async function getDefaultRoomId(db: DatabaseClient): Promise<string> {
  const rows = await db.query<{ id: string }>('SELECT id FROM rooms WHERE name = $1', [DEFAULT_ROOM_NAME]);
  if (rows.rows.length === 0) return seedDefaultRoom(db);
  return rows.rows[0].id;
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

function rowToRoom(row: Record<string, unknown>): RoomRow {
  return {
    id: String(row.id),
    name: String(row.name),
    type: row.type === 'private' ? 'private' : 'public',
    description: row.description === null || row.description === undefined ? null : String(row.description),
    ownerUserId: row.owner_user_id === null || row.owner_user_id === undefined ? null : String(row.owner_user_id),
    archivedAt: row.archived_at === null || row.archived_at === undefined ? null : Number(row.archived_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function getRoomById(db: DatabaseClient, roomId: string): Promise<RoomRow | null> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT id, name, type, description, owner_user_id, archived_at, created_at, updated_at
     FROM rooms WHERE id = $1`,
    [roomId],
  );
  return rows.rows.length > 0 ? rowToRoom(rows.rows[0]) : null;
}

export async function getRoomByName(db: DatabaseClient, name: string): Promise<RoomRow | null> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT id, name, type, description, owner_user_id, archived_at, created_at, updated_at
     FROM rooms WHERE name = $1`,
    [name],
  );
  return rows.rows.length > 0 ? rowToRoom(rows.rows[0]) : null;
}

/** 成员角色：唯一的 owner 记录在 room_members.role='owner'（与 rooms.owner_user_id 冗余一致） */
export async function getMemberRole(
  db: DatabaseClient,
  roomId: string,
  userId: string,
): Promise<'owner' | 'member' | null> {
  const rows = await db.query<{ role: string }>(
    'SELECT role FROM room_members WHERE room_id = $1 AND user_id = $2',
    [roomId, userId],
  );
  if (rows.rows.length === 0) return null;
  return rows.rows[0].role === 'owner' ? 'owner' : 'member';
}

export async function isRoomMember(db: DatabaseClient, roomId: string, userId: string): Promise<boolean> {
  return (await getMemberRole(db, roomId, userId)) !== null;
}

/**
 * 访问权判定：管理员 → 房主 → 成员 → 公开房放行 → none。
 * 判定前调用方应确保房间存在；归档房间一律 none（不可见不可进）。
 */
export async function resolveAccess(
  db: DatabaseClient,
  room: RoomRow,
  user: AuthenticatedUser,
): Promise<RoomAccess> {
  if (room.archivedAt !== null) return 'none';
  if (user.isAdmin) return 'admin';
  if (room.ownerUserId === user.id) return 'owner';
  const role = await getMemberRole(db, room.id, user.id);
  if (role === 'owner') return 'owner';
  if (role === 'member') return 'member';
  if (room.type === 'public') return 'public';
  return 'none';
}

// ---------------------------------------------------------------------------
// 可见房间列表（管理员全部 / 公开房全部 / 私密房仅成员）
// ---------------------------------------------------------------------------

export async function listVisibleRooms(db: DatabaseClient, user: AuthenticatedUser): Promise<RoomView[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT r.id, r.name, r.type, r.description, r.owner_user_id, r.archived_at, r.created_at, r.updated_at,
            rm.role AS member_role,
            (SELECT count(*) FROM room_members x WHERE x.room_id = r.id) AS member_count,
            (SELECT max(m.created_at) FROM messages m WHERE m.room_id = r.id) AS last_message_at
     FROM rooms r
     LEFT JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = $1
     WHERE r.archived_at IS NULL
       AND (r.type = 'public' OR rm.user_id IS NOT NULL OR $2::boolean)
     ORDER BY COALESCE((SELECT max(m.created_at) FROM messages m WHERE m.room_id = r.id), r.created_at) DESC`,
    [user.id, user.isAdmin],
  );
  return rows.rows.map((row) => {
    const role = row.member_role === null || row.member_role === undefined ? null : String(row.member_role);
    const isOwner = role === 'owner' || (row.owner_user_id !== null && String(row.owner_user_id) === user.id);
    return {
      ...rowToRoom(row),
      isOwner,
      isMember: role !== null,
      memberCount: Number(row.member_count ?? 0),
      lastMessageAt: row.last_message_at === null || row.last_message_at === undefined ? null : Number(row.last_message_at),
    };
  });
}

// ---------------------------------------------------------------------------
// 建房（直接创建：管理员/房主侧）与建房申请（审批流）
// ---------------------------------------------------------------------------

export interface CreateRoomInput {
  name: string;
  type: 'public' | 'private';
  description: string | null;
  ownerUserId: string | null;
}

/** 创建房间 + 写入 owner 成员，同一事务；返回房间视图。name 冲突抛出 Error('ROOM_NAME_TAKEN')。 */
export async function createRoom(db: DatabaseClient, input: CreateRoomInput): Promise<RoomRow> {
  const now = Date.now();
  return db.transaction(async (tx) => {
    const inserted = await tx.query<Record<string, unknown>>(
      `INSERT INTO rooms (name, type, description, owner_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (name) DO NOTHING
       RETURNING id, name, type, description, owner_user_id, archived_at, created_at, updated_at`,
      [input.name, input.type, input.description, input.ownerUserId, now],
    );
    if (inserted.rows.length === 0) throw new Error('ROOM_NAME_TAKEN');
    // owner 成员：私密房必须有 owner 才能管理成员；公开房同样记录以便 isOwner 展示
    await tx.query(
      `INSERT INTO room_members (room_id, user_id, role, joined_at)
       SELECT $1::uuid, id, 'owner', $2 FROM users WHERE id = $3::uuid`,
      [inserted.rows[0].id, now, input.ownerUserId],
    );
    return rowToRoom(inserted.rows[0]);
  });
}

/** 建房申请：name 与已存在房间或 pending 申请冲突时 409。 */
export async function createRoomRequest(
  db: DatabaseClient,
  input: { name: string; type: 'public' | 'private'; description: string | null; requester: string },
): Promise<RoomRequestRow> {
  if (await getRoomByName(db, input.name)) throw new Error('ROOM_NAME_TAKEN');
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM room_requests WHERE name = $1 AND status = 'pending'`,
    [input.name],
  );
  if (existing.rows.length > 0) throw new Error('REQUEST_EXISTS');
  const now = Date.now();
  const rows = await db.query<Record<string, unknown>>(
    `INSERT INTO room_requests (name, type, description, requester, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'pending', $5, $5)
     RETURNING id, name, type, description, requester, status, reject_reason, reviewed_by, created_at, updated_at`,
    [input.name, input.type, input.description, input.requester, now],
  );
  return rowToRequest(rows.rows[0]);
}

function rowToRequest(row: Record<string, unknown>): RoomRequestRow {
  return {
    id: String(row.id),
    name: String(row.name),
    type: row.type === 'private' ? 'private' : 'public',
    description: row.description === null || row.description === undefined ? null : String(row.description),
    requester: String(row.requester),
    status: row.status === 'approved' || row.status === 'rejected' ? row.status : 'pending',
    rejectReason: row.reject_reason === null || row.reject_reason === undefined ? null : String(row.reject_reason),
    reviewedBy: row.reviewed_by === null || row.reviewed_by === undefined ? null : String(row.reviewed_by),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function getRoomRequestById(db: DatabaseClient, id: string): Promise<RoomRequestRow | null> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT id, name, type, description, requester, status, reject_reason, reviewed_by, created_at, updated_at
     FROM room_requests WHERE id = $1`,
    [id],
  );
  return rows.rows.length > 0 ? rowToRequest(rows.rows[0]) : null;
}

export async function listRoomRequests(
  db: DatabaseClient,
  options: { status?: 'pending' | 'approved' | 'rejected'; requester?: string; limit: number },
): Promise<RoomRequestRow[]> {
  const params: unknown[] = [options.limit];
  const conditions: string[] = [];
  if (options.status) {
    params.push(options.status);
    conditions.push(`status = $${params.length}`);
  }
  if (options.requester) {
    params.push(options.requester);
    conditions.push(`requester = $${params.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await db.query<Record<string, unknown>>(
    `SELECT id, name, type, description, requester, status, reject_reason, reviewed_by, created_at, updated_at
     FROM room_requests ${where}
     ORDER BY created_at DESC, id DESC LIMIT $1`,
    params,
  );
  return rows.rows.map((r) => rowToRequest(r));
}

/**
 * 审批通过：创建房间 + room_members 写入申请人为 owner + rooms.owner_user_id 设申请人，
 * 三件事同一事务。返回 { room, request }。
 */
export async function approveRoomRequest(
  db: DatabaseClient,
  requestId: string,
  reviewedBy: string,
): Promise<{ room: RoomRow; request: RoomRequestRow }> {
  const request = await getRoomRequestById(db, requestId);
  if (!request) throw new Error('NOT_FOUND');
  if (request.status !== 'pending') throw new Error('ALREADY_DECIDED');

  // 先验证申请人账号仍存在（软删不存在的场景），避免事务内 SELECT 空行歧义
  const requesterRows = await db.query<{ id: string }>(
    'SELECT id FROM users WHERE lower(username) = lower($1)',
    [request.requester],
  );
  if (requesterRows.rows.length === 0) throw new Error('REQUESTER_NOT_FOUND');
  const requesterId = requesterRows.rows[0].id;

  const now = Date.now();
  return db.transaction(async (tx) => {
    // 1) 创建房间（name 冲突则整体回滚）
    const inserted = await tx.query<Record<string, unknown>>(
      `INSERT INTO rooms (name, type, description, owner_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (name) DO NOTHING
       RETURNING id, name, type, description, owner_user_id, archived_at, created_at, updated_at`,
      [request.name, request.type, request.description, requesterId, now],
    );
    if (inserted.rows.length === 0) throw new Error('ROOM_NAME_TAKEN');
    const roomRow = inserted.rows[0];
    // 2) 申请人为 owner 成员
    await tx.query(
      `INSERT INTO room_members (room_id, user_id, role, joined_at)
       VALUES ($1, $2, 'owner', $3)`,
      [roomRow.id, requesterId, now],
    );
    // 3) 更新申请单状态
    await tx.query(
      `UPDATE room_requests SET status = 'approved', reviewed_by = $2, updated_at = $3 WHERE id = $1`,
      [requestId, reviewedBy, now],
    );
    return { room: rowToRoom(roomRow), request: { ...request, status: 'approved', reviewedBy, updatedAt: now } };
  });
}

export async function rejectRoomRequest(
  db: DatabaseClient,
  requestId: string,
  reviewedBy: string,
  reason: string,
): Promise<RoomRequestRow> {
  const request = await getRoomRequestById(db, requestId);
  if (!request) throw new Error('NOT_FOUND');
  if (request.status !== 'pending') throw new Error('ALREADY_DECIDED');
  await db.query(
    `UPDATE room_requests SET status = 'rejected', reject_reason = $2, reviewed_by = $3, updated_at = $4 WHERE id = $1`,
    [requestId, reason, reviewedBy, Date.now()],
  );
  return { ...request, status: 'rejected', rejectReason: reason, reviewedBy, updatedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// 改名 / 归档 / 成员管理
// ---------------------------------------------------------------------------

/** 改名/改简介：description 传 undefined 时保持不变；空串视为清空。 */
export async function renameRoom(
  db: DatabaseClient,
  roomId: string,
  name: string,
  description?: string | null,
): Promise<RoomRow> {
  const existing = await getRoomByName(db, name);
  if (existing && existing.id !== roomId) throw new Error('ROOM_NAME_TAKEN');
  const hasDesc = description !== undefined;
  const descValue = typeof description === 'string' && description.trim() === '' ? null : (description ?? null);
  const rows = await db.query<Record<string, unknown>>(
    hasDesc
      ? `UPDATE rooms SET name = $2, description = $3, updated_at = $4
         WHERE id = $1
         RETURNING id, name, type, description, owner_user_id, archived_at, created_at, updated_at`
      : `UPDATE rooms SET name = $2, updated_at = $3
         WHERE id = $1
         RETURNING id, name, type, description, owner_user_id, archived_at, created_at, updated_at`,
    hasDesc ? [roomId, name, descValue, Date.now()] : [roomId, name, Date.now()],
  );
  if (rows.rows.length === 0) throw new Error('NOT_FOUND');
  return rowToRoom(rows.rows[0]);
}

/** 成员列表（房主/管理员专属，用于私密房成员管理界面）。
 *  安全说明：仅返回 username + role，且接口经 requireRoomAccess('owner') 保护；
 *  该信息只在房间管理弹层展示，不进入聊天消息域/WS 广播。 */
export interface RoomMemberView {
  username: string;
  role: 'owner' | 'member';
}

export async function listRoomMembers(db: DatabaseClient, roomId: string): Promise<RoomMemberView[]> {
  const rows = await db.query<{ username: string; role: string }>(
    `SELECT u.username, rm.role
     FROM room_members rm
     JOIN users u ON u.id = rm.user_id
     WHERE rm.room_id = $1
     ORDER BY (rm.role = 'owner') DESC, u.username ASC`,
    [roomId],
  );
  return rows.rows.map((r) => ({ username: String(r.username), role: r.role === 'owner' ? 'owner' : 'member' }));
}

export async function archiveRoom(db: DatabaseClient, roomId: string): Promise<RoomRow> {
  const rows = await db.query<Record<string, unknown>>(
    `UPDATE rooms SET archived_at = $2, updated_at = $2
     WHERE id = $1
     RETURNING id, name, type, description, owner_user_id, archived_at, created_at, updated_at`,
    [roomId, Date.now()],
  );
  if (rows.rows.length === 0) throw new Error('NOT_FOUND');
  return rowToRoom(rows.rows[0]);
}

export async function unarchiveRoom(db: DatabaseClient, roomId: string): Promise<RoomRow> {
  const rows = await db.query<Record<string, unknown>>(
    `UPDATE rooms SET archived_at = NULL, updated_at = $2
     WHERE id = $1
     RETURNING id, name, type, description, owner_user_id, archived_at, created_at, updated_at`,
    [roomId, Date.now()],
  );
  if (rows.rows.length === 0) throw new Error('NOT_FOUND');
  return rowToRoom(rows.rows[0]);
}

/** 添加成员：找到该用户名对应的真实用户并写入 room_members。存在则幂等返回。 */
export async function addRoomMember(
  db: DatabaseClient,
  roomId: string,
  username: string,
): Promise<{ userId: string; role: 'member' }> {
  const users = await db.query<{ id: string }>(
    'SELECT id FROM users WHERE lower(username) = lower($1)',
    [username],
  );
  if (users.rows.length === 0) throw new Error('USER_NOT_FOUND');
  await db.query(
    `INSERT INTO room_members (room_id, user_id, role, joined_at)
     VALUES ($1, $2, 'member', $3)
     ON CONFLICT (room_id, user_id) DO NOTHING`,
    [roomId, users.rows[0].id, Date.now()],
  );
  return { userId: users.rows[0].id, role: 'member' };
}

export async function removeRoomMember(db: DatabaseClient, roomId: string, username: string): Promise<void> {
  const users = await db.query<{ id: string }>(
    'SELECT id FROM users WHERE lower(username) = lower($1)',
    [username],
  );
  if (users.rows.length === 0) throw new Error('USER_NOT_FOUND');
  const rows = await db.query<{ role: string }>(
    'DELETE FROM room_members WHERE room_id = $1 AND user_id = $2 RETURNING role',
    [roomId, users.rows[0].id],
  );
  if (rows.rows.length === 0) throw new Error('NOT_A_MEMBER');
  if (rows.rows[0].role === 'owner') throw new Error('CANNOT_REMOVE_OWNER');
}

// ---------------------------------------------------------------------------
// 管理侧：全部房间列表（含已归档）与彻底删除
// ---------------------------------------------------------------------------

/** 管理员视角的房间行：不含真实身份，只给 hasOwner 布尔与聚合计数 */
export interface AdminRoomRow extends RoomRow {
  hasOwner: boolean;
  memberCount: number;
  messageCount: number;
}

/** 列出全部房间（含已归档），按创建时间倒序。ownerUserId 只转译为 hasOwner，绝不外泄 userId。 */
export async function listAdminRooms(db: DatabaseClient): Promise<AdminRoomRow[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT r.id, r.name, r.type, r.description, r.owner_user_id, r.archived_at, r.created_at, r.updated_at,
            (SELECT count(*) FROM room_members x WHERE x.room_id = r.id) AS member_count,
            (SELECT count(*) FROM messages m WHERE m.room_id = r.id) AS message_count
     FROM rooms r
     ORDER BY r.created_at DESC, r.id DESC`,
  );
  return rows.rows.map((row) => ({
    ...rowToRoom(row),
    hasOwner: row.owner_user_id !== null && row.owner_user_id !== undefined && String(row.owner_user_id).length > 0,
    memberCount: Number(row.member_count ?? 0),
    messageCount: Number(row.message_count ?? 0),
  }));
}

/**
 * 彻底删除房间（仅管理员）：级联清理该房间的消息、成员、申请单（按同名），
 * 以及针对该房间消息所涉匿名昵称的未处理（pending）溯源请求。同一事务，失败整体回滚。
 * roomName 用于按名清理与之关联的建房申请（room_requests 与房间之间只有 name 关联）。
 * 大厅/系统房间（owner_user_id 为空）由调用方拦截，这里不做二次判断。
 */
export async function deleteRoomPermanent(
  db: DatabaseClient,
  roomId: string,
  roomName: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // 1) 收集该房间消息用到的匿名昵称，清理针对它们的 pending 溯源请求（trace 无房间外键，按别名关联）
    const aliasRows = await tx.query<{ alias_name: string }>(
      'SELECT DISTINCT alias_name FROM messages WHERE room_id = $1',
      [roomId],
    );
    const aliases = aliasRows.rows.map((r) => String(r.alias_name));
    if (aliases.length > 0) {
      await tx.query(`DELETE FROM trace_requests WHERE status = 'pending' AND target_alias = ANY($1::text[])`, [aliases]);
    }
    // 2) 房间消息（messages.room_id 无 CASCADE，必须显式删）
    await tx.query('DELETE FROM messages WHERE room_id = $1', [roomId]);
    // 3) 房间成员（表上虽有 CASCADE，显式删除双保险且不依赖外键）
    await tx.query('DELETE FROM room_members WHERE room_id = $1', [roomId]);
    // 4) 与该房间同名的建房申请（含已处理历史，房间没了申请单失去意义）
    await tx.query('DELETE FROM room_requests WHERE name = $1', [roomName]);
    // 5) 房间本体
    const deleted = await tx.query<{ id: string }>('DELETE FROM rooms WHERE id = $1 RETURNING id', [roomId]);
    if (deleted.rows.length === 0) throw new Error('NOT_FOUND');
  });
}