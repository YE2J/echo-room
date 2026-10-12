// ABOUTME: 审计日志：只记录"谁在何时做了什么动作"，严禁写入消息原文、密码、token、密钥。
import type { DatabaseClient } from '../db';

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
  | 'identity.reveal';

export async function writeAudit(
  db: DatabaseClient,
  params: { actor: string | null; action: AuditAction; meta?: Record<string, unknown> },
): Promise<void> {
  try {
    await db.query(
      'INSERT INTO audit_log (actor, action, meta, created_at) VALUES ($1, $2, $3, $4)',
      [params.actor, params.action, params.meta ? JSON.stringify(params.meta) : null, Date.now()],
    );
  } catch (err) {
    // 审计失败不应中断业务主流程，但要在服务日志可见
    console.error('[audit] failed to write log:', (err as Error).message);
  }
}
