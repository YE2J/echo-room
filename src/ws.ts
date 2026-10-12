// ABOUTME: WebSocket 客户端：首帧 token 鉴权、自动重连、心跳、消息类型分发。

import type { ChatMessage } from './api';

export type WsChatMessage = ChatMessage;

export type ConnectionState = 'connecting' | 'online' | 'offline';

interface WsClientOptions {
  path: string;
  getToken: () => string | null;
  onStateChange: (state: ConnectionState) => void;
  onChatMessage?: (message: WsChatMessage) => void;
  onErrorMessage?: (message: string, code?: string) => void;
  onReady?: (info: { rewriteEnabled: boolean }) => void;
}

export interface WsClient {
  send: (type: string, payload: unknown) => void;
  close: () => void;
}

export function createWsClient(options: WsClientOptions): WsClient {
  let socket: WebSocket | null = null;
  let closedByUser = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let attempt = 0;

  function clearTimers(): void {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    reconnectTimer = null;
    heartbeatTimer = null;
  }

  function connect(): void {
    if (closedByUser) return;
    options.onStateChange('connecting');
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${window.location.host}${options.path}`);

    socket.onopen = () => {
      attempt = 0;
      const token = options.getToken();
      if (!token) {
        socket?.close(4001, 'unauthorized');
        return;
      }
      // 鉴权首帧：token 不出现在 URL / 访问日志中
      socket?.send(JSON.stringify({ type: 'auth', payload: { token } }));
      heartbeatTimer = setInterval(() => {
        socket?.send(JSON.stringify({ type: 'ping', payload: null }));
      }, 30000);
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      let envelope: { type: string; payload: unknown };
      try {
        envelope = JSON.parse(event.data) as { type: string; payload: unknown };
      } catch {
        return;
      }
      switch (envelope.type) {
        case 'pong':
          return;
        case 'auth:ok': {
          options.onStateChange('online');
          const payload = envelope.payload as { rewriteEnabled?: boolean };
          options.onReady?.({ rewriteEnabled: Boolean(payload.rewriteEnabled) });
          return;
        }
        case 'chat:message':
          options.onChatMessage?.(envelope.payload as WsChatMessage);
          return;
        case 'presence':
          return;
        case 'error': {
          const p = envelope.payload as { message?: string; code?: string };
          options.onErrorMessage?.(p?.message ?? '未知错误', p?.code);
          return;
        }
        default:
          return;
      }
    };

    socket.onclose = (event: CloseEvent) => {
      clearTimers();
      if (closedByUser) {
        options.onStateChange('offline');
        return;
      }
      if (event.code === 4001) {
        options.onErrorMessage?.('登录已过期，请重新登录', 'unauthorized');
        options.onStateChange('offline');
        closedByUser = true;
        return;
      }
      options.onStateChange('connecting');
      attempt += 1;
      const delay = Math.min(1000 * 2 ** attempt, 15000);
      reconnectTimer = setTimeout(connect, delay);
    };

    socket.onerror = () => {
      socket?.close();
    };
  }

  connect();

  return {
    send(type: string, payload: unknown) {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type, payload }));
      }
    },
    close() {
      closedByUser = true;
      clearTimers();
      socket?.close();
    },
  };
}
