// ABOUTME: WS 鉴权令牌的短期会话存储（sessionStorage，关闭标签页即清除）。
// HTTP 接口鉴权使用 httpOnly Cookie；此处仅保存同一 JWT 供 WebSocket 首帧鉴权，JS 无法读取 httpOnly Cookie。

const TOKEN_KEY = 'echo_ws_token';

export const sessionToken = {
  set(token: string): void {
    try {
      window.sessionStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* 隐私模式下忽略写入失败，WS 将退化为无法连接，引导重新登录 */
    }
  },
  get(): string | null {
    try {
      return window.sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  clear(): void {
    try {
      window.sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  },
};
