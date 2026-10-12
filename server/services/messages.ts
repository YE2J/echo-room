// ABOUTME: 消息存取：广播文本与历史列表只暴露语气归一化后的 normalized_text；
// 原文（含发送者真实书写痕迹）以 AES-256-GCM 密文存储，默认任何接口都不返回。
import type { DatabaseClient } from '../db';
import { encryptText } from '../crypto/aesgcm';
import { aliasVisual } from './alias';

export interface StoredMessage {
  id: string;
  aliasName: string;
  normalizedText: string;
  createdAt: number;
}

/** 对外公开的消息视图：仅匿名昵称 + 归一化文本 + 由昵称确定性派生的头像视觉。 */
export interface PublicMessage extends StoredMessage {
  hue: number;
  shape: number;
}

export function toPublicMessage(message: StoredMessage): PublicMessage {
  const { hue, shape } = aliasVisual(message.aliasName);
  return { ...message, hue, shape };
}

export interface StoreMessageInput {
  aliasId: string;
  aliasName: string;
  rawText: string;
  normalizedText: string;
  rewritten: boolean;
  encryptionKey: Buffer;
}

export async function storeMessage(db: DatabaseClient, input: StoreMessageInput): Promise<StoredMessage> {
  const encrypted = encryptText(input.rawText, input.encryptionKey);
  const now = Date.now();
  const rows = await db.query<{ id: string }>(
    `INSERT INTO messages
       (alias_id, alias_name, normalized_text, ciphertext, cipher_alg, rewritten, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      input.aliasId,
      input.aliasName,
      input.normalizedText,
      encrypted.data,
      encrypted.alg,
      input.rewritten,
      now,
    ],
  );
  return {
    id: rows.rows[0].id,
    aliasName: input.aliasName,
    normalizedText: input.normalizedText,
    createdAt: now,
  };
}

/** 最近历史（游标分页）；仅返回可公开的匿名昵称 + 归一化文本。 */
export async function listRecentMessages(
  db: DatabaseClient,
  options: { before?: number; limit: number },
): Promise<PublicMessage[]> {
  const limit = Math.min(Math.max(options.limit, 1), 100);
  const rows = options.before
    ? await db.query<StoredMessage & Record<string, unknown>>(
        `SELECT id, alias_name AS "aliasName", normalized_text AS "normalizedText", created_at AS "createdAt"
         FROM messages WHERE created_at < $1
         ORDER BY created_at DESC LIMIT $2`,
        [options.before, limit],
      )
    : await db.query<StoredMessage & Record<string, unknown>>(
        `SELECT id, alias_name AS "aliasName", normalized_text AS "normalizedText", created_at AS "createdAt"
         FROM messages ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
  // 列表按时间正序返回给前端，并派生公开头像视觉
  return rows.rows.reverse().map((row) => toPublicMessage(row as StoredMessage));
}
