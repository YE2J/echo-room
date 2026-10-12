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
}

export interface HistoryResult {
  messages: ChatMessage[];
  rewriteEnabled: boolean;
}

export interface VaultStatus {
  state: 'uninitialized' | 'sealed' | 'unsealed';
  k: number;
  n: number;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
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
  history(before?: number): Promise<HistoryResult> {
    const qs = before ? `?before=${before}&limit=50` : '?limit=50';
    return request(`/api/chat/history${qs}`);
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
};
