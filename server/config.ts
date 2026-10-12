// ABOUTME: 集中解析运行时环境变量，提供类型安全的配置对象
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function parseBoolean(value: string | undefined, defaultValue = false): boolean {
  if (value === undefined) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parseNumber(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value.trim() === '') return defaultValue;
  const n = Number(value);
  return Number.isFinite(n) ? n : defaultValue;
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

/** 开发态：生成并持久化随机密钥到 .data/dev-secrets.json，保证重启后会话与密文仍可用 */
function loadOrCreateDevSecrets(filePath: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, string>;
  } catch {
    const secrets: Record<string, string> = {
      JWT_SECRET: crypto.randomBytes(32).toString('base64'),
      MESSAGE_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    return secrets;
  }
}

export type LlmProvider = 'openai' | 'ollama' | 'off';
export type LlmFailureStrategy = 'passthrough' | 'reject';

export interface AppConfig {
  isProd: boolean;
  port: number;
  dbDriver: 'pg' | 'pglite';
  databaseUrl?: string;
  redisUrl?: string;
  dataDir: string;
  jwtSecret: string;
  messageEncryptionKey: Buffer;
  tokenTtlSeconds: number;
  vaultK: number;
  vaultN: number;
  vaultAutoUnsealShares: string[];
  adminUsernames: string[];
  bootstrapInviteCodes: string[];
  rateLimitPerMinute: number;
  maxMessageLength: number;
  llm: {
    enabled: boolean;
    provider: LlmProvider;
    openaiBaseUrl: string;
    openaiApiKey?: string;
    openaiModel: string;
    ollamaBaseUrl: string;
    ollamaModel: string;
    timeoutMs: number;
    onFailure: LlmFailureStrategy;
  };
  oidc: {
    enabled: boolean;
    issuer?: string;
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const isProd = env.COZE_PROJECT_ENV === 'PROD' || env.NODE_ENV === 'production';
  const dataDir = env.DATA_DIR || path.resolve(process.cwd(), '.data');

  let jwtSecret = env.JWT_SECRET;
  let messageEncryptionKeyB64 = env.MESSAGE_ENCRYPTION_KEY;
  if (!isProd) {
    const secrets = loadOrCreateDevSecrets(path.join(dataDir, 'dev-secrets.json'));
    jwtSecret = jwtSecret || secrets.JWT_SECRET;
    messageEncryptionKeyB64 = messageEncryptionKeyB64 || secrets.MESSAGE_ENCRYPTION_KEY;
  }
  if (!jwtSecret) throw new Error('JWT_SECRET is required in production');
  if (!messageEncryptionKeyB64) throw new Error('MESSAGE_ENCRYPTION_KEY is required in production');

  const messageEncryptionKey = Buffer.from(messageEncryptionKeyB64, 'base64');
  if (messageEncryptionKey.length !== 32) {
    throw new Error('MESSAGE_ENCRYPTION_KEY must decode to 32 bytes (AES-256)');
  }

  const provider = (env.LLM_PROVIDER || 'off').toLowerCase() as LlmProvider;
  // 归一化总开关默认开启；provider 为 off 时自动降级为确定性本地规则归一化。
  const llmEnabled = parseBoolean(env.LLM_NORMALIZE_ENABLED, true);

  const driverOverride = (env.DB_DRIVER || '').toLowerCase();
  const dbDriver: 'pg' | 'pglite' = driverOverride === 'pglite'
    ? 'pglite'
    : env.DATABASE_URL
      ? 'pg'
      : isProd
        ? (() => { throw new Error('DATABASE_URL is required in production (or set DB_DRIVER=pglite for single-node evaluation)'); })()
        : 'pglite';

  return {
    isProd,
    port: parseNumber(env.PORT ?? env.DEPLOY_RUN_PORT, 5000),
    dbDriver,
    databaseUrl: env.DATABASE_URL || undefined,
    redisUrl: env.REDIS_URL || undefined,
    dataDir,
    jwtSecret,
    messageEncryptionKey,
    tokenTtlSeconds: parseNumber(env.TOKEN_TTL_SECONDS, 60 * 60 * 12),
    vaultK: parseNumber(env.VAULT_K, 2),
    vaultN: parseNumber(env.VAULT_N, 3),
    vaultAutoUnsealShares: parseList(env.VAULT_AUTO_UNSEAL_SHARES),
    adminUsernames: parseList(env.ADMIN_USERNAMES).map((u) => u.toLowerCase()),
    bootstrapInviteCodes:
      parseList(env.BOOTSTRAP_INVITE_CODES).length > 0
        ? parseList(env.BOOTSTRAP_INVITE_CODES)
        : ['CN-INVITE', 'CN-INVITE-A', 'CN-INVITE-B'],
    rateLimitPerMinute: parseNumber(env.RATE_LIMIT_PER_MINUTE, 12),
    maxMessageLength: parseNumber(env.MAX_MESSAGE_LENGTH, 1000),
    llm: {
      enabled: llmEnabled,
      provider,
      openaiBaseUrl: env.LLM_OPENAI_BASE_URL || 'https://api.openai.com/v1',
      openaiApiKey: env.LLM_OPENAI_API_KEY || undefined,
      openaiModel: env.LLM_OPENAI_MODEL || 'gpt-4o-mini',
      ollamaBaseUrl: env.LLM_OLLAMA_BASE_URL || 'http://ollama:11434',
      ollamaModel: env.LLM_OLLAMA_MODEL || 'qwen2.5:7b',
      timeoutMs: parseNumber(env.LLM_TIMEOUT_MS, 8000),
      onFailure: (env.LLM_ON_FAILURE === 'reject' ? 'reject' : 'passthrough'),
    },
    oidc: {
      enabled: parseBoolean(env.OIDC_ENABLED, false),
      issuer: env.OIDC_ISSUER || undefined,
      clientId: env.OIDC_CLIENT_ID || undefined,
      clientSecret: env.OIDC_CLIENT_SECRET || undefined,
      redirectUri: env.OIDC_REDIRECT_URI || undefined,
    },
  };
}
