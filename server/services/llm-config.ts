// ABOUTME: LLM 运行时配置解析：settings 表（管理员后台热配置）> 环境变量 > 代码默认值。
// 每次调用实时解析，因此管理后台改配无需重启服务。API Key 以 AES-256-GCM 密文落库
// （llm.apiKeyEnc，密钥由主密钥按用途派生），任何对外接口只暴露掩码。
import type { AppConfig, LlmFailureStrategy, LlmProvider } from '../config';
import type { DatabaseClient } from '../db';
import { decryptText, encryptText, deriveSubKey } from '../crypto/aesgcm';

export interface ResolvedLlmConfig {
  enabled: boolean;
  provider: LlmProvider;
  /** 按当前 provider 归一后的 baseUrl；settings 未显式配置时回落 env 对应项。 */
  baseUrl: string | null;
  /** 按当前 provider 归一后的模型名；settings 未显式配置时回落 env 对应项。 */
  model: string | null;
  /** 明文 API Key，仅供内存中使用；null 表示未配置。 */
  apiKey: string | null;
  timeoutMs: number;
  onFailure: LlmFailureStrategy;
  source: 'settings' | 'env';
}

const VALID_PROVIDERS: LlmProvider[] = ['coze', 'openai', 'ollama', 'off'];

/** 派生用于 API Key 落库加密的密钥（与消息加密 key 用途隔离）。 */
export function apiKeyEncryptionKey(masterKey: Buffer): Buffer {
  return deriveSubKey(masterKey, 'llm.api-key.v1');
}

/** 加密 API Key（密文落库）。 */
export function encryptApiKey(plain: string, masterKey: Buffer): string {
  return encryptText(plain, apiKeyEncryptionKey(masterKey)).data;
}

/** 解密 API Key；密文损坏/密钥不匹配时返回 null，不阻断配置读取。 */
export function decryptApiKey(enc: string, masterKey: Buffer): string | null {
  try {
    return decryptText({ data: enc, alg: 'AES-256-GCM' }, apiKeyEncryptionKey(masterKey));
  } catch {
    return null;
  }
}

/** 掩码：只保留末 4 位，前缀固定 ****；未配置返回"未配置"。绝不回传明文。 */
export function maskApiKey(key: string | null): string {
  if (!key) return '未配置';
  return `****${key.slice(-4)}`;
}

/**
 * 解析当前生效的 LLM 配置。优先级：settings 表（llm.*）> 环境变量 > 代码默认值。
 * 每个字段独立回落：仅当 settings 显式配置了某字段才覆盖 env。
 * provider 变化后，baseUrl/model/key 的 env 回落项也随之切换（按 provider 取对应旧键）。
 */
export async function resolveLlmConfig(
  config: AppConfig,
  db: DatabaseClient,
): Promise<ResolvedLlmConfig> {
  const sv = new Map<string, string>();
  try {
    const rows = await db.query<{ key: string; value: string }>(
      'SELECT key, value FROM settings WHERE key LIKE $1',
      ['llm.%'],
    );
    for (const r of rows.rows) sv.set(r.key, r.value);
  } catch {
    // 查询失败时全部按 env 回落（调用方已有外层兜底）
  }
  const get = (key: string): string | undefined => sv.get(key);

  const providerRaw = (get('llm.provider') ?? config.llm.provider).toLowerCase();
  const provider: LlmProvider = (VALID_PROVIDERS as readonly string[]).includes(providerRaw)
    ? (providerRaw as LlmProvider)
    : 'openai';
  const source: 'settings' | 'env' = get('llm.provider') !== undefined ? 'settings' : 'env';

  const envBaseUrl =
    provider === 'openai'
      ? config.llm.openaiBaseUrl
      : provider === 'ollama'
        ? config.llm.ollamaBaseUrl
        : provider === 'coze'
          ? config.llm.cozeApiUrl
          : null;
  const envModel =
    provider === 'openai'
      ? config.llm.openaiModel
      : provider === 'ollama'
        ? config.llm.ollamaModel
        : null;
  const envKey =
    provider === 'openai'
      ? config.llm.openaiApiKey
      : provider === 'coze'
        ? config.llm.cozeApiToken
        : null;

  const baseUrlSetting = get('llm.baseUrl');
  const baseUrl = baseUrlSetting !== undefined ? baseUrlSetting || null : envBaseUrl;
  const modelSetting = get('llm.model');
  const model = modelSetting !== undefined ? modelSetting || null : envModel;

  let apiKey: string | null = null;
  const apiKeyEnc = get('llm.apiKeyEnc');
  if (apiKeyEnc) apiKey = decryptApiKey(apiKeyEnc, config.messageEncryptionKey);
  if (apiKey === null && envKey) apiKey = envKey;

  const timeoutRaw = Number(get('llm.timeoutMs'));
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0
    ? Math.round(timeoutRaw)
    : config.llm.timeoutMs;

  const onFailure: LlmFailureStrategy = get('llm.onFailure') === 'reject' ? 'reject' : 'passthrough';

  const normRaw = get('llm.normalize_enabled');
  const enabled = normRaw === undefined ? config.llm.enabled : normRaw === 'on';

  return { enabled, provider, baseUrl, model, apiKey, timeoutMs, onFailure, source };
}