// ABOUTME: 运行时设置（KV），当前主要承载 LLM 语气改写开关（可在管理端热切换）。
import type { DatabaseClient } from '../db';

export async function getSetting(db: DatabaseClient, key: string): Promise<string | null> {
  const rows = await db.query<{ value: string }>('SELECT value FROM settings WHERE key = $1', [key]);
  return rows.rows[0]?.value ?? null;
}

export async function setSetting(db: DatabaseClient, key: string, value: string): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [key, value, Date.now()],
  );
}

export const SETTING_KEYS = {
  llmNormalizeEnabled: 'llm.normalize_enabled',
} as const;
