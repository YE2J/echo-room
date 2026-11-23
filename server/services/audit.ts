// ABOUTME: 审计日志：只记录"谁在何时做了什么动作"，严禁写入消息原文、密码、token、密钥。
// 匿名性红线：写路径统一脱敏——管理员呈现为稳定匿名标记 admin#N，普通用户名一律 null；
// meta 递归删除 username/userId/alias/IP/UA 等身份字段。读路径由路由层再兜底一次。
import type { DatabaseClient } from '../db';
import { sanitizeAuditActor, sanitizeAuditMeta } from './privacy';

export type AuditAction =
  | 'auth.register'
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'invite.consume'
  | 'invite.create'
  | 'vault.initialize'
  | 'vault.unseal'
  | 'vault.unseal_failed'
  | 'vault.seal'
  | 'vault.break_glass_denied'
  | 'vault.break_glass_unseal'
  | 'vault.break_glass_failed'
  | 'identity.reveal'
  // M2 溯源审批流
  | 'trace.create'
  | 'trace.approve'
  | 'trace.reveal'
  | 'trace.reject'
  | 'trace.close'
  // M2 内容管理
  | 'message.delete'
  | 'alias.ban'
  | 'alias.unban'
  // M3 多聊天室
  | 'room.create'
  | 'room.update'
  | 'room.archive'
  | 'room.restore'
  | 'room.delete'
  | 'room.member.add'
  | 'room.member.remove'
  | 'room_request.create'
  | 'room_request.approve'
  | 'room_request.reject'
  // 模型管理（meta 只记改了哪些字段名 / 测试结果摘要，不记值）
  | 'llm.config.update'
  | 'llm.test';

export interface AuditParams {
  actor: string | null;
  action: AuditAction;
  meta?: unknown;
}

/**
 * 写入一条审计日志。写路径强制脱敏：
 * - actor：管理员（在 adminList 内）→ admin#N；其他任何用户名 → null；
 * - meta：递归删除身份字段（username/userId/alias/IP/UA 等）。
 * adminList 可省略：省略时任何非管理员用户名都会被置 null（双保险，绝不落真实用户名）。
 */
export async function writeAudit(
  db: DatabaseClient,
  params: AuditParams,
  adminList?: string[],
): Promise<void> {
  try {
    const actor = sanitizeAuditActor(params.actor, adminList ?? []);
    const meta = params.meta === undefined ? null : JSON.stringify(sanitizeAuditMeta(params.meta, params.action));
    await db.query(
      'INSERT INTO audit_log (actor, action, meta, created_at) VALUES ($1, $2, $3, $4)',
      [actor, params.action, meta, Date.now()],
    );
  } catch (err) {
    // 审计失败不应中断业务主流程，但要在服务日志可见
    console.error('[audit] failed to write log:', (err as Error).message);
  }
}