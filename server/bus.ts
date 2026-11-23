// ABOUTME: 消息总线适配：生产用 Redis Pub/Sub（多实例水平扩展），
// 开发态无 REDIS_URL 时回退进程内 EventEmitter（单实例）。
import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';
import type { AppConfig } from './config';

export interface MessageBus {
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, handler: (message: string) => void): Promise<() => Promise<void>>;
  /** 60 秒固定窗口计数：返回当前窗口内已计数（含本次），由调用方与阈值比较 */
  rateLimit(key: string): Promise<number>;
  close(): Promise<void>;
  readonly kind: 'redis' | 'memory';
}

class MemoryBus implements MessageBus {
  readonly kind = 'memory';
  private readonly emitter = new EventEmitter();
  private readonly counters = new Map<string, { count: number; resetAt: number }>();

  async publish(channel: string, message: string): Promise<void> {
    // 异步触发，模拟跨进程投递
    queueMicrotask(() => this.emitter.emit(channel, message));
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<() => Promise<void>> {
    this.emitter.on(channel, handler);
    return async () => {
      this.emitter.off(channel, handler);
    };
  }

  async rateLimit(key: string): Promise<number> {
    const now = Date.now();
    const windowMs = 60_000;
    const entry = this.counters.get(key);
    if (!entry || entry.resetAt <= now) {
      this.counters.set(key, { count: 1, resetAt: now + windowMs });
      return 1;
    }
    entry.count += 1;
    return entry.count;
  }

  async close(): Promise<void> {
    this.emitter.removeAllListeners();
    this.counters.clear();
  }
}

class RedisBus implements MessageBus {
  readonly kind = 'redis';
  private readonly subscriptions = new Set<Redis>();

  constructor(
    private readonly publisher: Redis,
    private readonly subscriber: Redis,
  ) {}

  async publish(channel: string, message: string): Promise<void> {
    await this.publisher.publish(channel, message);
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<() => Promise<void>> {
    await this.subscriber.subscribe(channel);
    const listener = (receivedChannel: string, message: string): void => {
      if (receivedChannel === channel) handler(message);
    };
    this.subscriber.on('message', listener);
    this.subscriptions.add(this.subscriber);
    return async () => {
      this.subscriber.off('message', listener);
      await this.subscriber.unsubscribe(channel);
    };
  }

  async rateLimit(key: string): Promise<number> {
    const bucket = `ratelimit:${key}:${Math.floor(Date.now() / 60_000)}`;
    const count = await this.publisher.incr(bucket);
    if (count === 1) await this.publisher.expire(bucket, 70);
    return count;
  }

  async close(): Promise<void> {
    this.subscriptions.clear();
    await this.publisher.quit();
    await this.subscriber.quit();
  }
}

export async function createMessageBus(config: AppConfig): Promise<MessageBus> {
  if (config.redisUrl) {
    const { Redis } = await import('ioredis');
    const publisher = new Redis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 3 });
    const subscriber = new Redis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 3 });
    await Promise.all([publisher.ping(), subscriber.ping()]);
    return new RedisBus(publisher, subscriber);
  }
  // 无 REDIS_URL 时回退进程内总线：仅适用于单实例部署（含 DB_DRIVER=pglite 的评估环境）。
  // 多实例水平扩展必须配置 REDIS_URL，否则跨实例的实时广播与限流不生效。
  if (config.isProd) {
    console.warn('[security] REDIS_URL not set: falling back to in-process bus, single-instance only');
  }
  return new MemoryBus();
}

/** 韧性兜底：任何情况下都返回进程内内存总线（Redis 不可用时不阻断服务监听） */
export function createMemoryBus(): MessageBus {
  return new MemoryBus();
}
