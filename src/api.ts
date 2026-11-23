// ABOUTME: 后端 HTTP API 封装。认证依赖 httpOnly Cookie（同源自动携带）。

export interface AliasVisual {
  hue: number;
  shape: number;
}

export interface AuthResult {
  alias: string | null;
  visual: AliasVisual | null;
  isAdmin?: boolean;
  wsToken?: string;
}

export interface ChatMessage {
  id: string;
  aliasName: string;
  normalizedText: string;
  createdAt: number;
  hue: number;
  shape: number;
  /** 仅 WebSocket 实时广播携带；历史消息无此字段 */
  roomId?: string;
}

/** 前端可见的房间视图（与后端 RoomView 对齐，archivedAt 非空表示已归档，列表应过滤） */
export interface Room {
  id: string;
  name: string;
  type: 'public' | 'private';
  description: string | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  isOwner: boolean;
  isMember: boolean;
  memberCount: number;
  lastMessageAt: number | null;
}

export interface HistoryResult {
  roomId?: string;
  messages: ChatMessage[];
  rewriteEnabled: boolean;
}

/** 建房申请（申请列表项）。approved 后按 name 在房间列表中找到对应房间进入。 */
export interface RoomRequest {
  id: string;
  name: string;
  type: 'public' | 'private';
  description: string | null;
  requester: string | null;
  status: 'pending' | 'approved' | 'rejected';
  rejectReason: string | null;
  reviewedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 房间成员（房主/管理员管理视角，仅私密房成员管理弹层使用） */
export interface RoomMember {
  username: string;
  role: 'owner' | 'member';
}

/** 建房/改名等写操作返回的房间：缺少 isOwner/memberCount 等按人派生的字段 */
export type RoomBasic = Omit<Room, 'isOwner' | 'isMember' | 'memberCount' | 'lastMessageAt'>;

/** 管理端房间视图（已脱敏）：无 owner 身份，只有 hasOwner 布尔 + 聚合计数 */
export interface AdminRoom {
  id: string;
  name: string;
  type: 'public' | 'private';
  description: string | null;
  hasOwner: boolean;
  memberCount: number;
  messageCount: number;
  archivedAt: number | null;
  createdAt: number;
}

export interface VaultStatus {
  state: 'uninitialized' | 'sealed' | 'unsealed';
  k: number;
  n: number;
}

export type TraceStatus = 'pending' | 'approved' | 'revealed' | 'rejected' | 'closed';

/** 溯源审批记录：仅含匿名标记（审批人#N，同一映射），不含真实用户名 */
export interface TraceApproval {
  label: string | null;
  at: number;
}

/** 溯源请求视图（后端脱敏）：目标为不可逆短引用 targetRef，发起/审批人均为 审批人#N */
export interface TraceRequest {
  id: string;
  targetRef: string;
  reason: string;
  requesterLabel: string | null;
  status: TraceStatus;
  approvals: TraceApproval[];
  revealedUsername: string | null;
  rejectReason: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 内容管理消息（后端脱敏）：无 alias、无毫秒时间戳；ref 为不可逆短引用，时间为粗化槽位 */
export interface AdminMessage {
  id: string;
  ref: string;
  normalizedText: string;
  rewritten: boolean;
  dateKey: string;
  timeSlot: string;
}

// ---- M3 模型设置 ----
export type LlmProviderId = 'coze' | 'openai' | 'ollama';

/** GET /api/admin/llm/config 与 PUT 保存后的视图（apiKey 只含掩码，绝不回传明文） */
export interface LlmConfigView {
  provider: LlmProviderId;
  baseUrl: string | null;
  model: string | null;
  timeoutMs: number;
  onFailure: 'passthrough' | 'error';
  enabled: boolean;
  apiKeyMasked: string;
}

export interface LlmUsageRow {
  id: string;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  latencyMs: number | null;
  ok: boolean;
  error: string | null;
  createdAt: number;
}

export interface LlmUsageView {
  total: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    avgLatencyMs: number;
    failCount: number;
  };
  recent: LlmUsageRow[];
}

export interface LlmTestResult {
  ok: boolean;
  provider: string;
  model: string | null;
  latencyMs: number;
  sample?: string;
  usage?: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null } | null;
  error?: string;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  const data = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `请求失败（${response.status}）`;
    throw new ApiError(message, response.status, data);
  }
  return data as T;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly raw?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const api = {
  register(username: string, password: string, inviteCode: string): Promise<AuthResult> {
    return request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password, inviteCode }),
    });
  },
  login(username: string, password: string): Promise<AuthResult> {
    return request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
  },
  me(): Promise<{ alias: string; visual: AliasVisual; isAdmin: boolean }> {
    return request('/api/auth/me');
  },
  logout(): Promise<{ ok: boolean }> {
    return request('/api/auth/logout', { method: 'POST' });
  },
  history(roomId?: string, before?: number, limit = 50): Promise<HistoryResult> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (roomId) params.set('roomId', roomId);
    if (before) params.set('before', String(before));
    return request(`/api/chat/history?${params.toString()}`);
  },
  /** 当前用户可见的房间列表（含归档标记，前端自行过滤归档房） */
  listRooms(): Promise<{ rooms: Room[] }> {
    return request('/api/rooms');
  },
  // ---- M3 建房 / 申请 / 成员 / 审批 ----
  adminCreateRoom(body: { name: string; type: 'public' | 'private'; description?: string }): Promise<{ room: RoomBasic }> {
    return request('/api/admin/rooms', { method: 'POST', body: JSON.stringify(body) });
  },
  createRoomRequest(body: { name: string; type: 'public' | 'private'; description?: string }): Promise<RoomRequest> {
    return request('/api/rooms/requests', { method: 'POST', body: JSON.stringify(body) });
  },
  myRoomRequests(status?: RoomRequest['status']): Promise<{ requests: RoomRequest[] }> {
    const qs = status ? `?status=${status}` : '';
    return request(`/api/rooms/requests${qs}`);
  },
  adminRoomRequests(status?: RoomRequest['status']): Promise<{ requests: RoomRequest[] }> {
    const qs = status ? `?status=${status}` : '';
    return request(`/api/admin/room-requests${qs}`);
  },
  approveRoomRequest(id: string): Promise<{ room: RoomBasic; request: RoomRequest }> {
    return request(`/api/admin/room-requests/${encodeURIComponent(id)}/approve`, { method: 'POST' });
  },
  rejectRoomRequest(id: string, reason: string): Promise<{ request: RoomRequest }> {
    return request(`/api/admin/room-requests/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },
  renameRoom(id: string, name: string, description?: string): Promise<{ room: RoomBasic }> {
    return request(`/api/rooms/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ name, description }),
    });
  },
  listRoomMembers(id: string): Promise<{ members: RoomMember[] }> {
    return request(`/api/rooms/${encodeURIComponent(id)}/members`);
  },
  addRoomMember(id: string, username: string): Promise<{ ok: boolean }> {
    return request(`/api/rooms/${encodeURIComponent(id)}/members`, {
      method: 'POST',
      body: JSON.stringify({ username }),
    });
  },
  removeRoomMember(id: string, username: string): Promise<{ ok: boolean }> {
    // DELETE 一律走 query string（预览网关剥离 DELETE body）
    const qs = `?username=${encodeURIComponent(username)}`;
    return request(`/api/rooms/${encodeURIComponent(id)}/members${qs}`, { method: 'DELETE' });
  },
  // ---- 管理后台：房间管理（列表含归档 / 归档 / 恢复 / 彻底删除） ----
  adminRooms(): Promise<{ rooms: AdminRoom[] }> {
    return request('/api/admin/rooms');
  },
  adminArchiveRoom(id: string): Promise<{ ok: boolean }> {
    return request(`/api/admin/rooms/${encodeURIComponent(id)}/archive`, { method: 'POST' });
  },
  adminRestoreRoom(id: string): Promise<{ ok: boolean }> {
    return request(`/api/admin/rooms/${encodeURIComponent(id)}/restore`, { method: 'POST' });
  },
  adminDeleteRoom(id: string): Promise<{ ok: boolean }> {
    return request(`/api/admin/rooms/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  vaultStatus(): Promise<VaultStatus> {
    return request('/api/admin/vault/status');
  },
  unseal(shares: string[]): Promise<VaultStatus> {
    return request('/api/admin/vault/unseal', { method: 'POST', body: JSON.stringify({ shares }) });
  },
  seal(): Promise<VaultStatus> {
    return request('/api/admin/vault/seal', { method: 'POST' });
  },
  createInvite(body: { code?: string; maxUses: number; ttlSeconds?: number }): Promise<unknown> {
    return request('/api/admin/invites', { method: 'POST', body: JSON.stringify(body) });
  },
  listInvites(): Promise<{ invites: Array<{ code: string; maxUses: number; usedCount: number; expiresAt: number | null }> }> {
    return request('/api/admin/invites');
  },
  getRewrite(): Promise<{
    systemEnabled: boolean;
    hasProvider: boolean;
    provider: string;
    effectiveEnabled: boolean;
    mode: 'llm' | 'local_rules';
    override: boolean | null;
  }> {
    return request('/api/admin/rewrite');
  },
  setRewrite(enabled: boolean): Promise<{ effectiveEnabled: boolean }> {
    return request('/api/admin/rewrite', { method: 'PUT', body: JSON.stringify({ enabled }) });
  },
  reveal(
    alias: string,
    reason: string,
    shares: string[],
  ): Promise<{ username: string; userId: string; alias: string }> {
    return request('/api/admin/reveal', {
      method: 'POST',
      body: JSON.stringify({ alias, reason, shares }),
    });
  },
  audit(): Promise<{ entries: Array<{ id: string; actor: string | null; action: string; meta: unknown; createdAt: number }> }> {
    return request('/api/admin/audit');
  },
  // ---- M2 溯源审批工作台 ----
  listTraceRequests(status?: TraceStatus | ''): Promise<{ entries: TraceRequest[]; nextCursor: string | null }> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    return request(`/api/admin/trace-requests${qs}`);
  },
  getTraceRequest(id: string): Promise<TraceRequest> {
    return request(`/api/admin/trace-requests/${encodeURIComponent(id)}`);
  },
  createTraceRequest(targetAlias: string, reason: string): Promise<TraceRequest> {
    return request('/api/admin/trace-requests', {
      method: 'POST',
      body: JSON.stringify({ targetAlias, reason }),
    });
  },
  approveTraceRequest(id: string, share: string): Promise<TraceRequest> {
    return request(`/api/admin/trace-requests/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      body: JSON.stringify({ shares: [share] }),
    });
  },
  rejectTraceRequest(id: string, reason: string): Promise<TraceRequest> {
    return request(`/api/admin/trace-requests/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },
  closeTraceRequest(id: string): Promise<TraceRequest> {
    return request(`/api/admin/trace-requests/${encodeURIComponent(id)}/close`, { method: 'POST' });
  },
  // ---- M2 内容管理 ----
  listAdminMessages(cursor?: string, limit = 20, keyword?: string): Promise<{ entries: AdminMessage[]; nextCursor: string | null }> {
    const params = new URLSearchParams();
    if (cursor) params.set('cursor', cursor);
    if (keyword && keyword.trim().length > 0) params.set('keyword', keyword.trim());
    params.set('limit', String(limit));
    return request(`/api/admin/messages?${params.toString()}`);
  },
  deleteAdminMessage(id: string, reason: string): Promise<{ ok: boolean; deleted: boolean; ref: string }> {
    // 网关会剥离 DELETE body 并触发 EMPTY_JSON_BODY(400)，reason 走 query
    const qs = reason ? `?reason=${encodeURIComponent(reason)}` : '';
    return request(`/api/admin/messages/${encodeURIComponent(id)}${qs}`, { method: 'DELETE' });
  },
  banAlias(alias: string, reason: string): Promise<{ ok: boolean; alias: string; banned: boolean }> {
    return request(`/api/admin/aliases/${encodeURIComponent(alias)}/ban`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },
  unbanAlias(alias: string): Promise<{ ok: boolean; alias: string; banned: boolean }> {
    return request(`/api/admin/aliases/${encodeURIComponent(alias)}/unban`, { method: 'POST' });
  },
  // ---- M3 模型设置 ----
  adminLlmConfig(): Promise<LlmConfigView> {
    return request('/api/admin/llm/config');
  },
  adminSaveLlmConfig(body: {
    provider?: LlmProviderId;
    baseUrl?: string | null;
    model?: string | null;
    timeoutMs?: number;
    onFailure?: 'passthrough' | 'error';
    enabled?: boolean;
    apiKey?: string | null;
  }): Promise<LlmConfigView> {
    return request('/api/admin/llm/config', { method: 'PUT', body: JSON.stringify(body) });
  },
  adminTestLlm(): Promise<LlmTestResult> {
    return request('/api/admin/llm/test', { method: 'POST' });
  },
  adminLlmUsage(limit = 20): Promise<LlmUsageView> {
    return request(`/api/admin/llm/usage?limit=${limit}`);
  },
};
