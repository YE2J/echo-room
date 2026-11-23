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
  llmProvider: 'llm.provider',
  llmBaseUrl: 'llm.baseUrl',
  llmModel: 'llm.model',
  llmTimeoutMs: 'llm.timeoutMs',
  llmOnFailure: 'llm.onFailure',
  llmApiKeyEnc: 'llm.apiKeyEnc',
} as const;

/** 删除设置项（用于"清空配置、回落 env/默认值"），不存在时静默。 */
export async function deleteSetting(db: DatabaseClient, key: string): Promise<void> {
  await db.query('DELETE FROM settings WHERE key = $1', [key]);
}

/** 一次拉取指定前缀的全部设置（如 llm.），返回 key→value 映射。 */
export async function getSettingsByPrefix(db: DatabaseClient, prefix: string): Promise<Map<string, string>> {
  const rows = await db.query<{ key: string; value: string }>(
    'SELECT key, value FROM settings WHERE key LIKE $1',
    [`${prefix}%`],
  );
  return new Map(rows.rows.map((r) => [r.key, r.value]));
}
