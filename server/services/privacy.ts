// ABOUTME: 管理后台匿名性脱敏集中模块。
// 原则：管理后台只做「内容治理」，不做「身份治理」——日常可见数据里不得出现任何能把
// 「某条内容 / 某个行为」与「某个真实账号」关联起来的线索。
// - 审计/溯源中的管理员一律呈现为稳定匿名标记（admin#N / 审批人#N，同一映射）；
// - 普通用户名一律脱敏为 null / 系统；
// - meta 只保留无身份信息的结果（ok/hit/status/count 等），严禁写入 username/userId/alias/IP/UA。
import { createHash } from 'node:crypto';
import type { DatabaseClient } from '../db';

/** 禁止进入审计 meta 的键（精确匹配，防常规命名） */
const FORBIDDEN_META_KEYS = new Set([
  'username',
  'userId',
  'user_id',
  'alias',
  'aliasName',
  'targetAlias',
  'ip',
  'ipAddress',
  'ua',
  'userAgent',
  'email',
  'phone',
]);

/** room.* 类 action 的 meta 中属于房间业务痕迹、必须抹除的键（不落到审计） */
const ROOM_META_REMOVE_KEYS = new Set(['roomName', 'description', 'name']);

/** 判断 action 是否为房间治理类（room. 前缀；room_request 等以 room_ 开头，不受影响） */
function isRoomAction(action: string | null | undefined): boolean {
  return typeof action === 'string' && action.startsWith('room.');
}

export const ADMIN_ANON_PATTERN = /^admin#\d+$/;
export const APPROVER_ANON_PATTERN = /^审批人#\d+$/;

/** 管理员 → 稳定匿名标记 admin#N（按名单顺序，同一管理员每次同号）；非管理员 → null */
export function adminLabel(adminList: string[], username: string | null | undefined): string | null {
  if (!username) return null;
  const idx = adminList.findIndex((u) => u.toLowerCase() === username.toLowerCase());
  return idx >= 0 ? `admin#${idx + 1}` : null;
}

/** 管理员 → 审批人标记 审批人#N（与 admin#N 同一映射索引，仅展示文案不同）；非管理员 → null */
export function approverLabel(adminList: string[], username: string | null | undefined): string | null {
  if (!username) return null;
  const idx = adminList.findIndex((u) => u.toLowerCase() === username.toLowerCase());
  return idx >= 0 ? `审批人#${idx + 1}` : null;
}

/** 写入审计前的 actor 脱敏：管理员 → admin#N，其他一律 null。作为写路径与读路径的双保险。 */
export function sanitizeAuditActor(actor: string | null | undefined, adminList: string[]): string | null {
  if (!actor) return null;
  // 幂等：已是匿名标记形态（admin#N）则原样返回，避免读路径二次映射把 admin#N 打回 null
  if (ADMIN_ANON_PATTERN.test(actor)) return actor;
  return adminLabel(adminList, actor);
}

/**
 * 审计 meta 脱敏：递归删除禁止键。返回新对象（不改原对象）。
 * 只保留无身份信息的结果字段（ok/hit/status/count 等治理必要字段）。
 * 传入 action 时额外处理房间治理类（room.*）动作：
 * - roomId（完整 UUID）→ 重命名为 roomRef（取前 8 位，shortRef）；
 * - 删除 roomName / description / name 等业务痕迹键。
 */
export function sanitizeAuditMeta(meta: unknown, action?: string | null): unknown {
  if (meta === null || meta === undefined) return null;
  if (typeof meta !== 'object') return meta;
  if (Array.isArray(meta)) {
    return meta.map((item) => sanitizeAuditMeta(item));
  }
  const roomAction = isRoomAction(action);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
    if (FORBIDDEN_META_KEYS.has(key)) continue; // 整键丢弃（含 username/userId/alias/IP/UA 等）
    if (roomAction && ROOM_META_REMOVE_KEYS.has(key)) continue; // 房间业务痕迹（roomName/description/name）抹除
    if (roomAction && key === 'roomId' && typeof value === 'string') {
      out.roomRef = shortRef(value); // 完整 UUID → 前 8 位短引用，与消息 ref 口径一致
      continue;
    }
    out[key] = sanitizeAuditMeta(value);
  }
  return out;
}

/** 消息/请求的不可逆短引用：取 id 前 8 位（用于前台展示与删除操作，不携带任何身份信息） */
export function shortRef(id: string): string {
  return id.slice(0, 8);
}

/** 目标别名的不可逆短引用：sha256(alias) 十六进制前 8 位，杜绝反查 */
export function aliasRefOf(alias: string): string {
  return createHash('sha256').update(alias).digest('hex').slice(0, 8);
}

/** 消息时间粗化：dateKey（如 2026-11-23，服务器本地时区）。入参容忍 string（pg int8 返回 string）。 */
export function dateKeyOf(ts: number | string): string {
  const d = new Date(typeof ts === 'number' ? ts : Number(ts));
  if (Number.isNaN(d.getTime())) return '—';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 消息时间粗化：timeSlot（上午 5-12 / 下午 12-18 / 夜间 18-5）。入参容忍 string。 */
export function timeSlotOf(ts: number | string): '上午' | '下午' | '夜间' {
  const d = new Date(typeof ts === 'number' ? ts : Number(ts));
  if (Number.isNaN(d.getTime())) return '夜间';
  const h = d.getHours();
  if (h >= 5 && h < 12) return '上午';
  if (h >= 12 && h < 18) return '下午';
  return '夜间';
}

/**
 * 存量审计日志脱敏迁移（幂等，pg / pglite 均兼容，重复执行安全）：
 * - 管理员行 actor → admin#N（按当前 ADMIN_USERNAMES 顺序）；
 * - 其余非 admin#N 的 actor（普通用户 username）→ NULL；
 * - meta 若含 username/userId/alias/targetAlias 等身份字段 → 整体置 NULL（丢弃该行 meta）；
 * - 房间治理类（room.*）行的 meta 键级清洗：roomId → roomRef（shortRef 前 8 位），
 *   抹除 roomName / description / name 业务痕迹（键已在则跳过，天然幂等）。
 * 注意：admin#N 形态本身不会被二次改写；新写入的日志已由 sanitizeAuditActor/sanitizeAuditMeta 保证脱敏。
 */
export async function migrateAuditPrivacy(db: DatabaseClient, adminList: string[]): Promise<void> {
  try {
    // 1) 管理员行：按名单顺序改写为 admin#N
    for (let i = 0; i < adminList.length; i += 1) {
      const username = adminList[i];
      if (!username) continue;
      await db.query('UPDATE audit_log SET actor = $1 WHERE actor = $2', [`admin#${i + 1}`, username]);
    }
    // 2) 其余真实用户名置 NULL（排除已脱敏的 admin#N 形态）
    await db.query(
      "UPDATE audit_log SET actor = NULL WHERE actor IS NOT NULL AND (actor !~ '^admin#[0-9]+$')",
    );
    // 3) meta 清洗：命中身份字段整体置 NULL（不按字段取，避免破坏 jsonb 形态差异）
    await db.query(
      `UPDATE audit_log SET meta = NULL WHERE meta IS NOT NULL AND (
        meta LIKE '%"username"%' OR meta LIKE '%"userId"%' OR meta LIKE '%"user_id"%'
        OR meta LIKE '%"alias"%' OR meta LIKE '%"aliasName"%' OR meta LIKE '%"targetAlias"%'
      )`,
    );
    // 4) 房间治理类（room.*）行 meta 键级清洗：roomId → roomRef、抹除 roomName/description/name
    //    条件只命中仍需处理的存量（键已抹除的行不在结果里），重跑安全（幂等）。
    const stale = await db.query<{ id: string; meta: string; action: string }>(
      `SELECT id, meta, action FROM audit_log
        WHERE action LIKE 'room.%' AND meta IS NOT NULL AND (
          meta LIKE '%"roomId"%' OR meta LIKE '%"roomName"%'
          OR meta LIKE '%"description"%' OR meta LIKE '%"name"%'
        )`,
    );
    for (const row of stale.rows) {
      const cleaned = sanitizeAuditMeta(JSON.parse(row.meta) as unknown, row.action);
      await db.query('UPDATE audit_log SET meta = $1 WHERE id = $2', [JSON.stringify(cleaned), row.id]);
    }
  } catch (err) {
    // 迁移失败不阻断启动（尽力而为；新写入路径已确保脱敏）
    console.error(`[privacy-migrate] audit privacy migration failed: ${(err as Error).message}`);
  }
}