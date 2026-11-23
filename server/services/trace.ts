// ABOUTME: 溯源审批流 + 内存份额托管。
// - 溯源请求（trace_requests）持久化元信息（申请事由/审批人/状态），但 Shamir 份额绝不落库；
// - 份额只在服务端内存 Map<traceId, {username, share}[]> 中累计，重启即失效（安全降级）；
// - 同一审批人多次提交 → 409；审批人即申请人 → 403；不同审批人累计达 K 即现场重组+校验。
// 匿名性红线：对外视图不含真实用户名/目标 alias 明文——
//   目标以 targetRef（不可逆短引用）呈现、发起人与审批人以 审批人#N 呈现；
//   真实身份仅在“提交满足门限的份额并现场还原成功”的那次响应里返回（reveal=true）。
import { approverLabel, aliasRefOf } from './privacy';

export type TraceStatus = 'pending' | 'approved' | 'revealed' | 'rejected' | 'closed';

/** 数据库行（下划线命名）。注意 JSONB 在 pg 下为字符串、PGlite 下为已解析对象。 */
export interface TraceRow {
  id: string;
  target_alias: string;
  reason: string;
  requester: string;
  status: TraceStatus;
  approvals: string | TraceApproval[]; // JSONB
  revealed_username: string | null;
  reject_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface TraceApproval {
  username: string;
  at: number;
}

// 对外安全视图：无真实用户名、无 alias 明文、无份额。
// - targetRef：目标 alias 的不可逆短引用（sha256 前 8 位）
// - requesterLabel / approvals[].label：同一管理员名单 → 审批人#N（稳定匿名标记）
// - revealedUsername：默认 null；仅当提交满足门限的份额并现场还原成功的那次响应置为真实身份
export interface TraceRequestView {
  id: string;
  targetRef: string;
  reason: string;
  requesterLabel: string | null;
  status: TraceStatus;
  approvals: Array<{ label: string | null; at: number }>;
  revealedUsername: string | null;
  rejectReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export function rowToView(
  row: TraceRow,
  adminList: string[],
  opts: { reveal?: boolean } = {},
): TraceRequestView {
  const approvals: TraceApproval[] =
    typeof row.approvals === 'string' ? (JSON.parse(row.approvals) as TraceApproval[]) : row.approvals;
  return {
    id: row.id,
    targetRef: aliasRefOf(row.target_alias),
    reason: row.reason,
    requesterLabel: approverLabel(adminList, row.requester),
    status: row.status,
    approvals: approvals.map((a) => ({ label: approverLabel(adminList, a.username), at: a.at })),
    revealedUsername: opts.reveal === true ? row.revealed_username : null,
    rejectReason: row.reject_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 份额托管者：仅存内存（可对份额校验失败做回滚），不落库、不入审计。 */
export class TraceShareDepository {
  private readonly store = new Map<string, Array<{ username: string; share: string }>>();

  entries(traceId: string): Array<{ username: string; share: string }> {
    return this.store.get(traceId) ?? [];
  }

  has(traceId: string, username: string): boolean {
    return (this.store.get(traceId) ?? []).some((e) => e.username === username);
  }

  /** 追加某审批人的份额；返回当前累计条目。 */
  deposit(traceId: string, username: string, share: string): Array<{ username: string; share: string }> {
    const current = this.store.get(traceId) ?? [];
    current.push({ username, share });
    this.store.set(traceId, current);
    return current;
  }

  /** 移除某审批人的份额（校验失败时回滚），返回剩余条目。 */
  remove(traceId: string, username: string): Array<{ username: string; share: string }> {
    const current = this.store.get(traceId) ?? [];
    const next = current.filter((e) => e.username !== username);
    if (next.length === 0) this.store.delete(traceId);
    else this.store.set(traceId, next);
    return next;
  }

  /** 清空某请求的全部内存份额（K 达成或请求关闭时调用）。 */
  clear(traceId: string): void {
    this.store.delete(traceId);
  }

  clearAll(): void {
    this.store.clear();
  }
}