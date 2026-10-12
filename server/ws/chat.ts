// ABOUTME: /ws/chat 公共聊天室：连接鉴权 → 限流 → LLM 语气归一化 →
// 原文 AES-GCM 密文落库 → 仅广播归一化文本。跨实例经 Redis Pub/Sub 扇出。
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

const CHANNEL_CHAT = 'chat:broadcast';
const CHANNEL_PRESENCE = 'chat:presence';
const HEARTBEAT_MS = 30_000;

interface WsMessage<T = unknown> {
  type: string;
  payload: T;
}

type ChatBroadcast = PublicMessage;

interface PresenceBroadcast {
  online: number;
}

interface ClientEntry {
  ws: WebSocket;
  user: AuthenticatedUser;
  alive: boolean;
}

export function registerChatWs(ctx: AppContext): WebSocketServer {
  const wss = registerWs('/ws/chat', () => {
    /* 连接处理在下方 wss.on('connection') 中完成 */
  });
  const localClients = new Set<ClientEntry>();
  let onlineDelta = 0;
  let knownOnline = 0;
  let presenceTimer: NodeJS.Timeout | null = null;

  const safeSend = (ws: WebSocket, message: WsMessage): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };

  const broadcastLocally = (message: WsMessage): void => {
    for (const client of localClients) safeSend(client.ws, message);
  };

  // 跨实例：收到其它实例的广播后转发给本机连接
  void ctx.bus.subscribe(CHANNEL_CHAT, (raw) => {
    try {
      broadcastLocally(JSON.parse(raw) as WsMessage);
    } catch {
      /* 忽略无法解析的总线消息 */
    }
  });

  void ctx.bus.subscribe(CHANNEL_PRESENCE, (raw) => {
    try {
      const payload = JSON.parse(raw) as PresenceBroadcast;
      knownOnline = payload.online;
      broadcastLocally({ type: 'presence', payload: { online: payload.online } });
    } catch {
      /* ignore */
    }
  });

  const publishPresence = (delta: number): void => {
    onlineDelta += delta;
  };

  if (!presenceTimer) {
    presenceTimer = setInterval(() => {
      if (onlineDelta === 0) return;
      knownOnline = Math.max(0, knownOnline + onlineDelta);
      const snapshot = onlineDelta;
      onlineDelta = 0;
      void ctx.bus.publish(
        CHANNEL_PRESENCE,
        JSON.stringify({ online: knownOnline, at: Date.now(), delta: snapshot } satisfies PresenceBroadcast & { at: number; delta: number }),
      );
      // 本机立即更新，不等总线回环
      broadcastLocally({ type: 'presence', payload: { online: knownOnline } });
    }, 2_000);
    // 多实例下 knownOnline 只是近似计数，单实例准确；不阻止进程退出
    presenceTimer.unref?.();
  }

  wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
    let entry: ClientEntry | null = null;

    ws.on('message', (data: RawData) => {
      void handleMessage(data);
    });

    ws.on('close', () => {
      if (entry) {
        localClients.delete(entry);
        publishPresence(-1);
      }
    });

    ws.on('error', () => {
      if (entry) localClients.delete(entry);
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
        message = JSON.parse(data.toString()) as WsMessage;
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

      // 首帧必须是 auth
      if (message.type === 'auth') {
        await authenticate(message);
        return;
      }

      if (!entry) {
        safeSend(ws, { type: 'error', payload: { code: 'unauthorized', message: '请先完成身份验证' } });
        ws.close(4001, 'unauthorized');
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

      // 取匿名身份：保险库封存时无法解析昵称，拒绝进入聊天室
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
      };
      localClients.add(entry);
      publishPresence(1);
      void writeAudit(ctx.db, { actor: user.username, action: 'auth.login', meta: { channel: 'ws/chat' } });

      safeSend(ws, {
        type: 'auth:ok',
        payload: {
          alias: identity.alias,
          visual: aliasVisual(identity.alias),
          rewriteEnabled: await isRewriteEnabled(),
        },
      });
      safeSend(ws, { type: 'presence', payload: { online: knownOnline + onlineDelta } });
    }

    async function isRewriteEnabled(): Promise<boolean> {
      if (!ctx.rewriter.isEnabled()) return false; // 系统总开关关闭
      const override = await getSetting(ctx.db, SETTING_KEYS.llmNormalizeEnabled);
      // 管理员未显式设置时跟随系统总开关（默认开）
      return override === null ? true : override === 'on';
    }

    async function handleChatSend(client: ClientEntry, message: WsMessage): Promise<void> {
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
      });

      const broadcast: ChatBroadcast = toPublicMessage(stored);
      // 经总线广播（含本机订阅者），保证多实例一致
      await ctx.bus.publish(CHANNEL_CHAT, JSON.stringify({ type: 'chat:message', payload: broadcast }));

      safeSend(ws, { type: 'chat:ack', payload: { id: stored.id, createdAt: stored.createdAt } });
    }
  });

  return wss;
}

function parseTokenFromUrl(request: IncomingMessage): string | null {
  if (!request.url) return null;
  const url = new URL(request.url, 'http://localhost');
  return url.searchParams.get('token');
}
