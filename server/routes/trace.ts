// ABOUTME: 溯源审批流（M2）。申请人发起→多名管理员各自提供 Shamir 份额（内存累计不落库）→
// 不同审批人累计达 K 即现场重组+校验还原真实身份，全程审计留痕。
// 匿名性红线：所有对外响应不含真实用户名/目标 alias 明文——目标显示 targetRef、人员显示 审批人#N；
// 仅在“提交满足门限份额并还原成功”的那次 approve 响应里返回真实身份。
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { requireAdmin } from './helpers';
import { writeAudit } from '../services/audit';
import { aliasRefOf } from '../services/privacy';
import { rowToView, type TraceRequestView, type TraceRow } from '../services/trace';

const createTraceSchema = z.object({
  targetAlias: z.string().min(1).max(64).trim(),
  reason: z.string().min(2).max(300),
});

const approveSchema = z.object({
  shares: z.array(z.string().min(3)).min(1).max(10),
});

const rejectSchema = z.object({
  reason: z.string().min(2).max(300),
});

const TERMINAL_STATUS = new Set(['revealed', 'rejected', 'closed']);

export function registerTraceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const adminList = ctx.config.adminUsernames;

  // 1) 创建溯源申请
  app.post('/api/admin/trace-requests', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    const parsed = createTraceSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '请提供有效的匿名昵称与溯源事由' });
    const targetAlias = parsed.data.targetAlias;
    const now = Date.now();
    const inserted = await ctx.db.query<{ id: string }>(
      `INSERT INTO trace_requests (target_alias, reason, requester, status, approvals, created_at, updated_at)
       VALUES ($1, $2, $3, 'pending', '[]', $4, $4) RETURNING id`,
      [targetAlias, parsed.data.reason, admin.username, now],
    );
    await writeAudit(
      ctx.db,
      {
        actor: admin.username,
        action: 'trace.create',
        // meta 只记不可逆 targetRef，绝不落 alias 明文
        meta: { targetRef: aliasRefOf(targetAlias), reason: parsed.data.reason },
      },
      adminList,
    );
    const created = await getTraceView(ctx, inserted.rows[0].id);
    return reply.code(201).send(created);
  });

  // 2) 列表（status 过滤 + 游标分页，每页 20）——目标只显示 targetRef，审批人只显示 审批人#N
  app.get('/api/admin/trace-requests', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    const status = request.query as { status?: string };
    const valid = status.status && !['pending', 'approved', 'revealed', 'rejected', 'closed'].includes(status.status)
      ? reply.code(400).send({ error: '非法的 status 过滤值' })
      : null;
    if (valid) return valid;
    const pageSize = 20;
    const params: unknown[] = [pageSize];
    let whereClause = '';
    if (status.status && status.status.length > 0) {
      params.push(status.status);
      whereClause = `WHERE status = $${params.length}`;
    }
    const rows = await ctx.db.query<Record<string, unknown>>(
      `SELECT id, target_alias, reason, requester, status, approvals, revealed_username, reject_reason, created_at, updated_at
       FROM trace_requests ${whereClause}
       ORDER BY created_at DESC, id DESC LIMIT $1`,
      params,
    );
    return reply.send({
      entries: rows.rows.map((r) => rowToView(r as unknown as TraceRow, adminList)),
      nextCursor: rows.rows.length === pageSize ? cursorFrom(rows.rows) : null,
    });
  });

  // 3) 详情（含审批进度）——同样脱敏，不返回真实身份
  app.get('/api/admin/trace-requests/:id', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    const { id } = request.params as { id: string };
    if (!/^\d+$/.test(id)) return reply.code(400).send({ error: '非法的请求 ID' });
    const view = await getTraceView(ctx, id);
    if (!view) return reply.code(404).send({ error: '溯源请求不存在' });
    return reply.send(view);
  });

  // 4) 审批：管理员各自提交份额，累计达 K 即现场还原（仅此时返回真实身份）
  app.post('/api/admin/trace-requests/:id/approve', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    const { id } = request.params as { id: string };
    if (!/^\d+$/.test(id)) return reply.code(400).send({ error: '非法的请求 ID' });
    const parsed = approveSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '请提供至少一份密钥分片' });

    const raw = await getTraceRow(ctx, id);
    if (!raw) return reply.code(404).send({ error: '溯源请求不存在' });
    const view = rowToView(raw, adminList);
    if (TERMINAL_STATUS.has(view.status)) {
      return reply.code(400).send({ error: '该溯源请求已结束，无法继续审批' });
    }
    if (raw.requester === admin.username) {
      return reply.code(403).send({ error: '申请人不能审批自己的溯源请求' });
    }
    // 同一审批人已提交过（内存中有记录）→ 409
    if (ctx.traceShares.has(id, admin.username)) {
      return reply.code(409).send({ error: '你已为此请求提交过份额，请勿重复提交' });
    }

    // 记录审批人（明文，不含份额）+ 追加内存份额
    const newApproval = { username: admin.username, at: Date.now() };
    await ctx.db.query(
      `UPDATE trace_requests SET approvals = to_jsonb($2::jsonb), status = CASE WHEN status = 'pending' THEN 'approved' ELSE status END, updated_at = $3 WHERE id = $1`,
      [id, JSON.stringify([...(raw.approvals as unknown as Array<{ username: string; at: number }>), newApproval]), Date.now()],
    );
    for (const share of parsed.data.shares) ctx.traceShares.deposit(id, admin.username, share);
    await writeAudit(ctx.db, { actor: admin.username, action: 'trace.approve', meta: { traceRequestId: id } }, adminList);

    // 是否需要 K（门限）才能还原
    const meta = await ctx.vault.getMeta();
    const k = meta?.k ?? ctx.config.vaultK;
    const cumulative = ctx.traceShares.entries(id);
    if (cumulative.length < k) {
      const updated = await getTraceView(ctx, id);
      return reply.send(updated);
    }

    // 达到/超过 K：现场重组 + 校验（用原始 target_alias，不外泄）
    const shares = cumulative.map((e) => e.share);
    try {
      const identity = await ctx.vault.revealIdentityWithShares(raw.target_alias, shares);
      if (!identity) {
        ctx.traceShares.clear(id);
        return reply.code(404).send({ error: '未找到该匿名身份映射' });
      }
      await ctx.db.query(
        `UPDATE trace_requests SET status = 'revealed', revealed_username = $2, updated_at = $3 WHERE id = $1`,
        [id, identity.username, Date.now()],
      );
      ctx.traceShares.clear(id);
      await writeAudit(
        ctx.db,
        {
          actor: admin.username,
          action: 'trace.reveal',
          // meta 都不含 alias，仅含短引用
          meta: { traceRequestId: id, targetRef: aliasRefOf(raw.target_alias) },
        },
        adminList,
      );
      // 只有此刻（门限满足且还原成功）在响应中返回真实身份；此后详情/列表不再含 username
      return reply.send(await getTraceView(ctx, id, { reveal: true }));
    } catch (err) {
      // 校验失败：回滚本次审批人的内存份额（审计只记行为，不含份额），允许其稍后重试
      ctx.traceShares.remove(id, admin.username);
      // DB 一并回滚到本次提交前的状态（approvals 与 status 均还原为提交前的视图），
      // 避免“已审批但份额非法”造成死锁，同时保证“校验失败则状态不变”的语义。
      await ctx.db.query(
        `UPDATE trace_requests SET approvals = to_jsonb($2::jsonb), status = $3, updated_at = $4 WHERE id = $1`,
        [id, JSON.stringify(raw.approvals), raw.status, Date.now()],
      );
      await writeAudit(ctx.db, { actor: admin.username, action: 'trace.approve', meta: { traceRequestId: id, verdict: 'invalid_shares' } }, adminList);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('invalid shares')) {
        return reply.code(400).send({ error: '密钥分片无效，重组后的主密钥未通过校验，本次提交已回滚' });
      }
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // 5) 驳回
  app.post('/api/admin/trace-requests/:id/reject', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    const { id } = request.params as { id: string };
    if (!/^\d+$/.test(id)) return reply.code(400).send({ error: '非法的请求 ID' });
    const parsed = rejectSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '请填写驳回事由' });
    const raw = await getTraceRow(ctx, id);
    if (!raw) return reply.code(404).send({ error: '溯源请求不存在' });
    const view = rowToView(raw, adminList);
    if (TERMINAL_STATUS.has(view.status)) return reply.code(400).send({ error: '该溯源请求已结束' });
    await ctx.db.query(
      `UPDATE trace_requests SET status = 'rejected', reject_reason = $2, updated_at = $3 WHERE id = $1`,
      [id, parsed.data.reason, Date.now()],
    );
    ctx.traceShares.clear(id);
    await writeAudit(
      ctx.db,
      {
        actor: admin.username,
        action: 'trace.reject',
        meta: { traceRequestId: id, reason: parsed.data.reason },
      },
      adminList,
    );
    return reply.send(await getTraceView(ctx, id));
  });

  // 6) 关闭（可强制终止，即使未达成 K）
  app.post('/api/admin/trace-requests/:id/close', async (request, reply) => {
    const admin = await requireAdmin(request, reply, ctx);
    if (!admin) return reply;
    const { id } = request.params as { id: string };
    if (!/^\d+$/.test(id)) return reply.code(400).send({ error: '非法的请求 ID' });
    const raw = await getTraceRow(ctx, id);
    if (!raw) return reply.code(404).send({ error: '溯源请求不存在' });
    const view = rowToView(raw, adminList);
    if (TERMINAL_STATUS.has(view.status)) return reply.code(400).send({ error: '该溯源请求已结束' });
    await ctx.db.query(
      `UPDATE trace_requests SET status = 'closed', updated_at = $2 WHERE id = $1`,
      [id, Date.now()],
    );
    ctx.traceShares.clear(id);
    await writeAudit(ctx.db, { actor: admin.username, action: 'trace.close', meta: { traceRequestId: id } }, adminList);
    return reply.send(await getTraceView(ctx, id));
  });
}

async function getTraceRow(ctx: AppContext, id: string): Promise<TraceRow | null> {
  const rows = await ctx.db.query<Record<string, unknown>>(
    `SELECT id, target_alias, reason, requester, status, approvals, revealed_username, reject_reason, created_at, updated_at
     FROM trace_requests WHERE id = $1`,
    [id],
  );
  if (rows.rows.length === 0) return null;
  return rows.rows[0] as unknown as TraceRow;
}

async function getTraceView(
  ctx: AppContext,
  id: string,
  opts: { reveal?: boolean } = {},
): Promise<TraceRequestView | null> {
  const raw = await getTraceRow(ctx, id);
  if (!raw) return null;
  return rowToView(raw, ctx.config.adminUsernames, opts);
}

function cursorFrom(rows: Array<Record<string, unknown>>): string {
  const last = rows[rows.length - 1];
  return Buffer.from(`${String(last.created_at)}_${String(last.id)}`).toString('base64url');
}