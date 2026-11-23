// ABOUTME: WebSocket 客户端：首帧 token 鉴权、自动重连、心跳、消息类型分发。
// 多房间支持：join/leave 帧；chat:message 携带 roomId，由上层按当前房间过滤。

import type { ChatMessage } from './api';

export type WsChatMessage = ChatMessage;

export type ConnectionState = 'connecting' | 'online' | 'offline';

export interface RoomJoinedInfo {
  roomId: string;
  name: string;
  online: number;
}

export interface RoomLeftInfo {
  roomId: string;
  name: string;
  previousRoomId: string | null;
  online: number;
}

interface WsClientOptions {
  path: string;
  getToken: () => string | null;
  onStateChange: (state: ConnectionState) => void;
  onChatMessage?: (message: WsChatMessage) => void;
  onErrorMessage?: (message: string, code?: string) => void;
  /** auth:ok：携带默认房间（大厅）roomId */
  onReady?: (info: { rewriteEnabled: boolean; roomId?: string }) => void;
  /** presence 现在带 roomId：只有当前房间的在线数才应展示 */
  onPresence?: (online: number, roomId?: string) => void;
  onRoomJoined?: (info: RoomJoinedInfo) => void;
  onRoomLeft?: (info: RoomLeftInfo) => void;
}

export interface WsClient {
  send: (type: string, payload: unknown) => void;
  /** 加入 / 切换到指定房间（后端会先校验可见性） */
  join: (roomId: string) => void;
  /** 离开当前房间（后端自动回到大厅） */
  leave: () => void;
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
          const payload = envelope.payload as { rewriteEnabled?: boolean; roomId?: string };
          options.onReady?.({
            rewriteEnabled: Boolean(payload.rewriteEnabled),
            roomId: typeof payload.roomId === 'string' ? payload.roomId : undefined,
          });
          return;
        }
        case 'chat:message':
          options.onChatMessage?.(envelope.payload as WsChatMessage);
          return;
        case 'room:joined': {
          const p = envelope.payload as { roomId?: string; name?: string; online?: number };
          if (typeof p.roomId !== 'string') return;
          options.onRoomJoined?.({
            roomId: p.roomId,
            name: typeof p.name === 'string' ? p.name : '',
            online: typeof p.online === 'number' ? p.online : 0,
          });
          return;
        }
        case 'room:left': {
          const p = envelope.payload as {
            roomId?: string;
            name?: string;
            previousRoomId?: string | null;
            online?: number;
          };
          if (typeof p.roomId !== 'string') return;
          options.onRoomLeft?.({
            roomId: p.roomId,
            name: typeof p.name === 'string' ? p.name : '大厅',
            previousRoomId: typeof p.previousRoomId === 'string' ? p.previousRoomId : null,
            online: typeof p.online === 'number' ? p.online : 0,
          });
          return;
        }
        case 'presence': {
          const p = envelope.payload as { online?: number; roomId?: string };
          options.onPresence?.(
            typeof p.online === 'number' ? p.online : 0,
            typeof p.roomId === 'string' ? p.roomId : undefined,
          );
          return;
        }
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
    join(roomId: string) {
      if (!roomId) return;
      this.send('room:join', { roomId });
    },
    leave() {
      this.send('room:leave', null);
    },
    close() {
      closedByUser = true;
      clearTimers();
      socket?.close();
    },
  };
}