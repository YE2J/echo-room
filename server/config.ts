// ABOUTME: 集中解析运行时环境变量，提供类型安全的配置对象
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** 扣子智能体域名默认值：必须由部署方通过 LLM_COZE_API_URL 显式提供，禁止内置任何真实域名 */
const DEFAULT_COZE_API_URL = '';

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

export interface DataDirResult {
  /** 可用的数据目录；为 null 表示无任何可写目录，须降级内存模式 */
  dir: string | null;
  /** 命中的候选来源或失败原因（用于启动诊断） */
  source: string;
}

/**
 * 按优先级探测可写数据目录：DATA_DIR → COZE_WORKSPACE_PATH/.data → cwd/.data → os.tmpdir()/echo-room-data。
 * 每个候选都会 mkdir -p 并写入/删除探针文件验证可写；全部失败返回 dir=null，调用方降级 PGlite 内存模式。
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): DataDirResult {
  const candidates: Array<{ label: string; dir: string | null }> = [
    { label: 'DATA_DIR', dir: env.DATA_DIR || null },
    {
      label: 'COZE_WORKSPACE_PATH/.data',
      dir: env.COZE_WORKSPACE_PATH ? path.join(env.COZE_WORKSPACE_PATH, '.data') : null,
    },
    { label: 'cwd/.data', dir: path.resolve(process.cwd(), '.data') },
    { label: 'os.tmpdir()/echo-room-data', dir: path.join(os.tmpdir(), 'echo-room-data') },
  ];
  for (const candidate of candidates) {
    if (!candidate.dir) continue;
    try {
      fs.mkdirSync(candidate.dir, { recursive: true });
      const probe = path.join(candidate.dir, `.probe-${process.pid}-${Date.now()}.tmp`);
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });
      return { dir: candidate.dir, source: candidate.label };
    } catch {
      // 当前候选不可写，尝试下一个
    }
  }
  return { dir: null, source: 'none writable; fallback to in-memory PGlite' };
}

export type LlmProvider = 'openai' | 'ollama' | 'coze' | 'off';
export type LlmFailureStrategy = 'passthrough' | 'reject';

export interface AppConfig {
  isProd: boolean;
  port: number;
  dbDriver: 'pg' | 'pglite';
  databaseUrl?: string;
  redisUrl?: string;
  /** 可写数据目录；null 表示无可用目录（PGlite 应降级内存模式） */
  dataDir: string | null;
  /** dataDir 的来源（诊断用） */
  dataDirSource: string;
  jwtSecret: string;
  messageEncryptionKey: Buffer;
  /** 密钥来源：env=来自环境变量/开发密钥文件；ephemeral=配置非法时降级的临时随机密钥（重启后旧密文不可解） */
  secretSource: 'env' | 'ephemeral';
  tokenTtlSeconds: number;
  vaultK: number;
  vaultN: number;
  vaultAutoUnsealShares: string[];
  /** 首次启动自动引导保险库：生成分片 + 解封 + 加密落库备份（生产单管理员自动运维） */
  vaultAutoBootstrap: boolean;
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
    cozeApiUrl: string;
    cozeApiToken: string;
    /** 扣子编程项目 ID（19 位整数，LLM_PROVIDER=coze 时必填），由部署方通过 LLM_COZE_PROJECT_ID 提供 */
    cozeProjectId: string;
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
  const dataDirResult = resolveDataDir(env);
  const dataDir = dataDirResult.dir;

  let jwtSecret = env.JWT_SECRET;
  let messageEncryptionKeyB64 = env.MESSAGE_ENCRYPTION_KEY;
  if (!isProd && dataDir) {
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

  const providerRaw = (env.LLM_PROVIDER || 'off').toLowerCase();
  // 'coze' 走扣子智能体，'ollama' 走本地，'off' 关闭；其它取值（含未设置以外的未知值）
  // 一律落到 OpenAI 兼容分支，保持历史行为不变。
  const provider: LlmProvider = (
    ['openai', 'ollama', 'coze', 'off'] as const
  ).includes(providerRaw as 'openai' | 'ollama' | 'coze' | 'off')
    ? (providerRaw as LlmProvider)
    : 'openai';
  // 归一化总开关默认开启；provider 为 off 时自动降级为确定性本地规则归一化。
  const llmEnabled = parseBoolean(env.LLM_NORMALIZE_ENABLED, true);

  const driverOverride = (env.DB_DRIVER || '').toLowerCase();
  // 生产无 DATABASE_URL 时不再抛错：降级 PGlite（单节点兜底，服务必须能起），
  // 由启动诊断横幅与 WARN 提示数据不会落到外部 PG。
  const dbDriver: 'pg' | 'pglite' = driverOverride === 'pglite'
    ? 'pglite'
    : env.DATABASE_URL
      ? 'pg'
      : 'pglite';

  return {
    isProd,
    secretSource: 'env',
    port: parseNumber(env.PORT ?? env.DEPLOY_RUN_PORT, 5000),
    dbDriver,
    databaseUrl: env.DATABASE_URL || undefined,
    redisUrl: env.REDIS_URL || undefined,
    dataDir,
    dataDirSource: dataDirResult.source,
    jwtSecret,
    messageEncryptionKey,
    tokenTtlSeconds: parseNumber(env.TOKEN_TTL_SECONDS, 60 * 60 * 12),
    vaultK: parseNumber(env.VAULT_K, 2),
    vaultN: parseNumber(env.VAULT_N, 3),
    vaultAutoUnsealShares: parseList(env.VAULT_AUTO_UNSEAL_SHARES),
    vaultAutoBootstrap: parseBoolean(env.VAULT_AUTO_BOOTSTRAP, false),
    adminUsernames: parseList(env.ADMIN_USERNAMES).map((u) => u.toLowerCase()),
    bootstrapInviteCodes: parseList(env.BOOTSTRAP_INVITE_CODES),
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
      cozeApiUrl: (env.LLM_COZE_API_URL || DEFAULT_COZE_API_URL).replace(/\/$/, ''),
      cozeApiToken: env.LLM_COZE_API_TOKEN || '',
      cozeProjectId: env.LLM_COZE_PROJECT_ID || '',
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

/**
 * 极端兜底配置：loadConfig 抛错（如生产缺 JWT_SECRET / 密钥长度非法）时调用。
 * 用随机密钥继续启动，保证 HTTP 服务无论如何都能监听、/api/health 可诊断。
 * 调用方需 console.warn 记录原因（会话与密文在重启后失效，属可接受的降级）。
 */
export function fallbackConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const isProd = env.COZE_PROJECT_ENV === 'PROD' || env.NODE_ENV === 'production';
  const dataDirResult = resolveDataDir(env);
  const providerRaw = (env.LLM_PROVIDER || 'off').toLowerCase();
  const provider: LlmProvider = (
    ['openai', 'ollama', 'coze', 'off'] as const
  ).includes(providerRaw as 'openai' | 'ollama' | 'coze' | 'off')
    ? (providerRaw as LlmProvider)
    : 'openai';
  return {
    isProd,
    secretSource: 'ephemeral',
    port: parseNumber(env.PORT ?? env.DEPLOY_RUN_PORT, 5000),
    dbDriver: env.DATABASE_URL ? 'pg' : 'pglite',
    databaseUrl: env.DATABASE_URL || undefined,
    redisUrl: env.REDIS_URL || undefined,
    dataDir: dataDirResult.dir,
    dataDirSource: dataDirResult.source,
    jwtSecret: crypto.randomBytes(32).toString('base64'),
    messageEncryptionKey: crypto.randomBytes(32),
    tokenTtlSeconds: parseNumber(env.TOKEN_TTL_SECONDS, 60 * 60 * 12),
    vaultK: parseNumber(env.VAULT_K, 2),
    vaultN: parseNumber(env.VAULT_N, 3),
    vaultAutoUnsealShares: parseList(env.VAULT_AUTO_UNSEAL_SHARES),
    vaultAutoBootstrap: parseBoolean(env.VAULT_AUTO_BOOTSTRAP, false),
    adminUsernames: parseList(env.ADMIN_USERNAMES).map((u) => u.toLowerCase()),
    bootstrapInviteCodes: parseList(env.BOOTSTRAP_INVITE_CODES),
    rateLimitPerMinute: parseNumber(env.RATE_LIMIT_PER_MINUTE, 12),
    maxMessageLength: parseNumber(env.MAX_MESSAGE_LENGTH, 1000),
    llm: {
      enabled: parseBoolean(env.LLM_NORMALIZE_ENABLED, true),
      provider,
      openaiBaseUrl: env.LLM_OPENAI_BASE_URL || 'https://api.openai.com/v1',
      openaiApiKey: env.LLM_OPENAI_API_KEY || undefined,
      openaiModel: env.LLM_OPENAI_MODEL || 'gpt-4o-mini',
      ollamaBaseUrl: env.LLM_OLLAMA_BASE_URL || 'http://ollama:11434',
      ollamaModel: env.LLM_OLLAMA_MODEL || 'qwen2.5:7b',
      cozeApiUrl: (env.LLM_COZE_API_URL || DEFAULT_COZE_API_URL).replace(/\/$/, ''),
      cozeApiToken: env.LLM_COZE_API_TOKEN || '',
      cozeProjectId: env.LLM_COZE_PROJECT_ID || '',
      timeoutMs: parseNumber(env.LLM_TIMEOUT_MS, 8000),
      onFailure: env.LLM_ON_FAILURE === 'reject' ? 'reject' : 'passthrough',
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
