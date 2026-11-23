// ABOUTME: /ws/chat 公共聊天室（M3 多房间）：连接鉴权 → 默认加入大厅 →
// room:join/room:leave 房间切换（先校验可见性）→ chat:send 必须已 join 目标房间 →
// LLM 语气归一化 → 原文 AES-GCM 密文落库 → 仅广播归一化文本。
// 跨实例经 Redis Pub/Sub 按房间频道扇出（chat:broadcast:{roomId} / chat:presence:{roomId}）。
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { IncomingMessage } from 'node:http';
import { registerWs } from './registry';
import type { AppContext, AuthenticatedUser } from '../context';
import { verifyToken } from '../crypto/token';
import { getUserById } from '../services/auth';
import { storeMessage, toPublicMessage, type PublicMessage } from '../services/messages';
import { checkSendRate } from '../services/rate-limit';
import { getSetting, SETTING_KEYS } from '../services/settings';
import { aliasVisual } from '../services/alias';
import { writeAudit } from '../services/audit';
import { getDefaultRoomId, getRoomById, resolveAccess } from '../services/rooms';

const HEARTBEAT_MS = 30_000;
const PRESENCE_INTERVAL_MS = 2_000;

interface WsMessage<T = unknown> {
  type: string;
  payload: T;
}

type ChatBroadcast = PublicMessage & { roomId: string };

interface PresenceBroadcast {
  online: number;
}

interface ClientEntry {
  ws: WebSocket;
  user: AuthenticatedUser;
  alive: boolean;
  /** 当前所在房间 id；null = 尚未加入任何房间 */
  roomId: string | null;
}

export function registerChatWs(ctx: AppContext): WebSocketServer {
  const wss = registerWs('/ws/chat', () => {
    /* 连接处理在下方 wss.on('connection') 中完成 */
  });
  // 房间维度连接表：一个连接同一时刻只在一个房间
  const localClients = new Map<string, Set<ClientEntry>>();
  // presence 按房间聚合：delta 为本次窗口增量，knownOnline 为最近发布的近似在线数
  const onlineDelta = new Map<string, number>();
  const knownOnline = new Map<string, number>();
  let presenceTimer: NodeJS.Timeout | null = null;
  // 已订阅的总线频道（幂等去重）
  const subscribedRooms = new Set<string>();

  const safeSend = (ws: WebSocket, message: WsMessage): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };

  const roomClients = (roomId: string): Set<ClientEntry> => {
    let set = localClients.get(roomId);
    if (!set) {
      set = new Set<ClientEntry>();
      localClients.set(roomId, set);
    }
    return set;
  };

  const broadcastLocally = (roomId: string, message: WsMessage): void => {
    const set = localClients.get(roomId);
    if (set) for (const client of set) safeSend(client.ws, message);
  };

  // 进入/离开房间：维护本地表 + presence 增量（同一连接只在一个房间）
  const addToRoom = (client: ClientEntry, roomId: string): void => {
    client.roomId = roomId;
    roomClients(roomId).add(client);
    onlineDelta.set(roomId, (onlineDelta.get(roomId) ?? 0) + 1);
  };

  const removeFromRoom = (client: ClientEntry): string | null => {
    const roomId = client.roomId;
    if (!roomId) return null;
    const set = localClients.get(roomId);
    if (set) {
      set.delete(client);
      if (set.size === 0) localClients.delete(roomId);
    }
    client.roomId = null;
    onlineDelta.set(roomId, (onlineDelta.get(roomId) ?? 0) - 1);
    return roomId;
  };

  const roomOnline = (roomId: string): number =>
    Math.max(0, (knownOnline.get(roomId) ?? 0) + (onlineDelta.get(roomId) ?? 0));

  // 首次进入某房间时订阅其总线频道；幂等，避免重复订阅
  const ensureRoomSubscribed = (roomId: string): void => {
    if (subscribedRooms.has(roomId)) return;
    subscribedRooms.add(roomId);
    void ctx.bus.subscribe(`chat:broadcast:${roomId}`, (raw) => {
      try {
        broadcastLocally(roomId, JSON.parse(raw) as WsMessage);
      } catch {
        /* 忽略无法解析的总线消息 */
      }
    });
    void ctx.bus.subscribe(`chat:presence:${roomId}`, (raw) => {
      try {
        const payload = JSON.parse(raw) as PresenceBroadcast & { roomId?: string };
        knownOnline.set(roomId, payload.online);
        broadcastLocally(roomId, { type: 'presence', payload: { online: payload.online, roomId } });
      } catch {
        /* ignore */
      }
    });
  };

  if (!presenceTimer) {
    presenceTimer = setInterval(() => {
      for (const [roomId, delta] of [...onlineDelta.entries()]) {
        if (delta === 0) {
          onlineDelta.delete(roomId);
          continue;
        }
        const current = Math.max(0, (knownOnline.get(roomId) ?? 0) + delta);
        knownOnline.set(roomId, current);
        const snapshot = delta;
        onlineDelta.delete(roomId);
        // 本机立即更新 + 通知其它实例（多实例下 knownOnline 为近似值）
        broadcastLocally(roomId, { type: 'presence', payload: { online: current, roomId } });
        void ctx.bus.publish(
          `chat:presence:${roomId}`,
          JSON.stringify({ online: current, at: Date.now(), delta: snapshot, roomId }),
        );
      }
    }, PRESENCE_INTERVAL_MS);
    presenceTimer.unref?.();
  }

  wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
    let entry: ClientEntry | null = null;

    ws.on('message', (data: RawData) => {
      void handleMessage(data);
    });

    ws.on('close', () => {
      if (entry) removeFromRoom(entry);
    });

    ws.on('error', () => {
      if (entry) removeFromRoom(entry);
    });

    const heartbeat = setInterval(() => {
      if (entry && !entry.alive) {
        ws.terminate();
        return;
      }
      if (entry) entry.alive = false;
      ws.ping();
    }, HEARTBEAT_MS);
    ws.on('close', () => clearInterval(heartbeat));

    async function handleMessage(data: RawData): Promise<void> {
      let message: WsMessage;
      try {
        const parsed: unknown = JSON.parse(data.toString());
        if (
          parsed === null ||
          typeof parsed !== 'object' ||
          typeof (parsed as { type?: unknown }).type !== 'string'
        ) {
          throw new Error('invalid envelope');
        }
        message = parsed as WsMessage;
      } catch {
        safeSend(ws, { type: 'error', payload: { code: 'bad_message', message: '消息格式错误' } });
        return;
      }

      if (message.type === 'ping') {
        safeSend(ws, { type: 'pong', payload: null });
        return;
      }
      if (entry) {
        entry.alive = true;
      }

      if (message.type === 'auth') {
        await authenticate(message);
        return;
      }

      if (!entry) {
        safeSend(ws, { type: 'error', payload: { code: 'unauthorized', message: '请先完成身份验证' } });
        ws.close(4001, 'unauthorized');
        return;
      }

      if (message.type === 'room:join') {
        await handleRoomJoin(entry, message);
        return;
      }
      if (message.type === 'room:leave') {
        await handleRoomLeave(entry);
        return;
      }
      if (message.type === 'chat:send') {
        await handleChatSend(entry, message);
      }
    }

    async function authenticate(message: WsMessage): Promise<void> {
      const token =
        typeof message.payload === 'object' &&
        message.payload !== null &&
        'token' in message.payload &&
        typeof (message.payload as { token: unknown }).token === 'string'
          ? (message.payload as { token: string }).token
          : parseTokenFromUrl(request);
      if (!token) {
        safeSend(ws, { type: 'error', payload: { code: 'unauthorized', message: '缺少登录凭证' } });
        ws.close(4001, 'unauthorized');
        return;
      }

      let payload: ReturnType<typeof verifyToken>;
      try {
        payload = verifyToken(token, ctx.config.jwtSecret);
      } catch {
        safeSend(ws, { type: 'error', payload: { code: 'unauthorized', message: '登录已过期，请重新登录' } });
        ws.close(4001, 'unauthorized');
        return;
      }

      const user = await getUserById(ctx.db, payload.sub, ctx.config);
      if (!user) {
        safeSend(ws, { type: 'error', payload: { code: 'unauthorized', message: '账户不存在' } });
        ws.close(4001, 'unauthorized');
        return;
      }

      let identity: Awaited<ReturnType<typeof ctx.vault.findIdentityByUser>>;
      try {
        identity = await ctx.vault.findIdentityByUser(user.id);
      } catch {
        safeSend(ws, {
          type: 'error',
          payload: { code: 'vault_sealed', message: '身份保险库已封存，暂时无法进入聊天室，请联系管理员' },
        });
        ws.close(4003, 'vault_sealed');
        return;
      }
      if (!identity) {
        safeSend(ws, { type: 'error', payload: { code: 'identity_missing', message: '匿名身份缺失' } });
        ws.close(4003, 'identity_missing');
        return;
      }

      entry = {
        ws,
        user: {
          id: user.id,
          username: user.username,
          isAdmin: user.isAdmin,
          aliasId: identity.aliasId,
          alias: identity.alias,
        },
        alive: true,
        roomId: null,
      };
      // 向后兼容：认证后默认加入大厅（老客户端不带 roomId 也在大厅收发）
      const lobbyId = await getDefaultRoomId(ctx.db);
      addToRoom(entry, lobbyId);
      ensureRoomSubscribed(lobbyId);
      void writeAudit(ctx.db, { actor: null, action: 'auth.login', meta: { channel: 'ws/chat' } });

      safeSend(ws, {
        type: 'auth:ok',
        payload: {
          alias: identity.alias,
          visual: aliasVisual(identity.alias),
          rewriteEnabled: await isRewriteEnabled(),
          roomId: lobbyId,
        },
      });
      safeSend(ws, { type: 'presence', payload: { online: roomOnline(lobbyId), roomId: lobbyId } });
    }

    async function isRewriteEnabled(): Promise<boolean> {
      if (!ctx.rewriter.isEnabled()) return false;
      const override = await getSetting(ctx.db, SETTING_KEYS.llmNormalizeEnabled);
      return override === null ? true : override === 'on';
    }

    /** room:join：切换房间。必须先通过可见性校验（管理员/房主/成员/公开房），否则 error:room_forbidden。 */
    async function handleRoomJoin(client: ClientEntry, message: WsMessage): Promise<void> {
      const roomId =
        typeof message.payload === 'object' &&
        message.payload !== null &&
        'roomId' in message.payload &&
        typeof (message.payload as { roomId: unknown }).roomId === 'string'
          ? (message.payload as { roomId: string }).roomId.trim()
          : '';
      if (!roomId) {
        safeSend(ws, { type: 'error', payload: { code: 'bad_room', message: '缺少 roomId' } });
        return;
      }
      const room = await getRoomById(ctx.db, roomId);
      if (!room || room.archivedAt !== null) {
        safeSend(ws, { type: 'error', payload: { code: 'room_forbidden', message: '房间不存在或已归档' } });
        return;
      }
      const access = await resolveAccess(ctx.db, room, client.user);
      if (access === 'none') {
        // 私密房非成员 / 不可见，拒绝加入
        safeSend(ws, { type: 'error', payload: { code: 'room_forbidden', message: '无权进入该房间' } });
        return;
      }
      // 离开当前房间（可能为 null）后加入新房间
      removeFromRoom(client);
      addToRoom(client, roomId);
      ensureRoomSubscribed(roomId);
      safeSend(ws, { type: 'room:joined', payload: { roomId, name: room.name, online: roomOnline(roomId) } });
      safeSend(ws, { type: 'presence', payload: { online: roomOnline(roomId), roomId } });
    }

    /** room:leave：离开当前房间回到默认大厅（保持连接可用，与 auth 默认态一致） */
    async function handleRoomLeave(client: ClientEntry): Promise<void> {
      const previous = removeFromRoom(client);
      const lobbyId = await getDefaultRoomId(ctx.db);
      addToRoom(client, lobbyId);
      ensureRoomSubscribed(lobbyId);
      const online = roomOnline(lobbyId);
      safeSend(ws, { type: 'room:left', payload: { roomId: lobbyId, name: '大厅', previousRoomId: previous ?? null, online } });
      safeSend(ws, { type: 'presence', payload: { online, roomId: lobbyId } });
    }

    async function handleChatSend(client: ClientEntry, message: WsMessage): Promise<void> {
      // 防伪造 roomId 跨房发送：必须先 join 目标房间；payload 里显式携带的 roomId 必须与当前房间一致
      const currentRoomId = client.roomId;
      if (!currentRoomId) {
        safeSend(ws, { type: 'error', payload: { code: 'not_joined', message: '尚未加入任何房间' } });
        return;
      }
      const payloadRoomId =
        typeof message.payload === 'object' &&
        message.payload !== null &&
        'roomId' in message.payload &&
        typeof (message.payload as { roomId: unknown }).roomId === 'string'
          ? (message.payload as { roomId: string }).roomId.trim()
          : currentRoomId;
      if (payloadRoomId !== currentRoomId) {
        safeSend(ws, { type: 'error', payload: { code: 'not_joined', message: '你不在该房间中，无法发送' } });
        return;
      }

      const text =
        typeof message.payload === 'object' &&
        message.payload !== null &&
        'text' in message.payload &&
        typeof (message.payload as { text: unknown }).text === 'string'
          ? (message.payload as { text: string }).text
          : '';
      const trimmed = text.trim();
      if (!trimmed) return;
      if (trimmed.length > ctx.config.maxMessageLength) {
        safeSend(ws, {
          type: 'error',
          payload: { code: 'too_long', message: `消息不能超过 ${ctx.config.maxMessageLength} 字` },
        });
        return;
      }

      // 封禁校验：匿名昵称处于 banned 状态时拒绝发送（对所有房间生效）
      const aliasRow = await ctx.db.query<{ banned_at: number | null }>(
        'SELECT banned_at FROM aliases WHERE alias = $1',
        [client.user.alias],
      );
      if (aliasRow.rows.length > 0 && aliasRow.rows[0].banned_at !== null) {
        safeSend(ws, {
          type: 'error',
          payload: { code: 'alias_banned', message: '该匿名身份已被管理员封禁，无法发言' },
        });
        return;
      }

      const rate = await checkSendRate(ctx.bus, client.user.id, ctx.config.rateLimitPerMinute);
      if (!rate.allowed) {
        safeSend(ws, {
          type: 'error',
          payload: { code: 'rate_limited', message: '发送过于频繁，请稍后再试' },
        });
        return;
      }

      const rewriteEnabled = await isRewriteEnabled();
      let normalized = trimmed;
      let rewritten = false;
      if (rewriteEnabled) {
        const result = await ctx.rewriter.normalize(trimmed);
        normalized = result.text;
        rewritten = result.rewritten;
      }

      const stored = await storeMessage(ctx.db, {
        aliasId: client.user.aliasId,
        aliasName: client.user.alias,
        rawText: trimmed,
        normalizedText: normalized,
        rewritten,
        encryptionKey: ctx.config.messageEncryptionKey,
        roomId: currentRoomId,
      });

      const broadcast: ChatBroadcast = { ...toPublicMessage(stored), roomId: currentRoomId };
      // 经房间频道广播（本机订阅者也会收到），保证多实例一致
      await ctx.bus.publish(
        `chat:broadcast:${currentRoomId}`,
        JSON.stringify({ type: 'chat:message', payload: broadcast }),
      );

      safeSend(ws, { type: 'chat:ack', payload: { id: stored.id, createdAt: stored.createdAt, roomId: currentRoomId } });
    }
  });

  return wss;
}

function parseTokenFromUrl(request: IncomingMessage): string | null {
  if (!request.url) return null;
  const url = new URL(request.url, 'http://localhost');
  return url.searchParams.get('token');
}