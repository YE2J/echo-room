// ABOUTME: 消息发送限流：60 秒固定窗口，基于 Redis（多实例共享）或进程内计数。
import type { MessageBus } from '../bus';

export async function checkSendRate(
  bus: MessageBus,
  userId: string,
  limitPerMinute: number,
): Promise<{ allowed: boolean; count: number; limit: number }> {
  const count = await bus.rateLimit(`send-message:${userId}`);
  return { allowed: count <= limitPerMinute, count, limit: limitPerMinute };
}
