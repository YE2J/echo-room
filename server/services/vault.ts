// ABOUTME: 身份保险库：真实用户 ↔ 匿名昵称映射整表 AES-GCM 加密；
// 主密钥不入库、不落盘，启动时只存在于内存，需 K 份 Shamir 分片解封。
// - DB 管理员/备份窃取者拿到的只有 HMAC 索引与密文，无法还原映射；
// - 平时（sealed）服务拒绝注册新身份与管理员溯源；
// - 事故时管理员可立刻 seal() 擦除内存主密钥。
import crypto from 'node:crypto';
import type { DatabaseClient } from '../db';
import type { AppConfig } from '../config';
import { combineShares, decodeShare, encodeShare, splitSecret, type Share } from '../crypto/shamir';
import { decryptJson, deriveSubKey, encryptJson } from '../crypto/aesgcm';

export type VaultState = 'uninitialized' | 'sealed' | 'unsealed';

interface VaultMeta {
  version: 1;
  k: number;
  n: number;
  vaultId: string;
  verifier: string; // HMAC(master, constant)，用于校验解封结果，不泄露主密钥
  createdAt: number;
}

interface IdentityRecord {
  userId: string;
  username: string;
  aliasId: string;
  alias: string;
}

const META_KEY = 'vault.meta';
const HMAC_PURPOSE = 'vault-lookup-hmac-v1';
const AES_PURPOSE = 'vault-record-aes-v1';
const VERIFIER_PURPOSE = 'vault-verifier-v1';

function safeEqualTiming(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export class VaultSealedError extends Error {
  constructor() {
    super('identity vault is sealed');
    this.name = 'VaultSealedError';
  }
}

export class VaultUninitializedError extends Error {
  constructor() {
    super('identity vault is not initialized');
    this.name = 'VaultUninitializedError';
  }
}

export class IdentityVault {
  private masterKey: Buffer | null = null;

  constructor(
    private readonly db: DatabaseClient,
    private readonly config: AppConfig,
  ) {}

  async getMeta(): Promise<VaultMeta | null> {
    const rows = await this.db.query<{ value: string }>('SELECT value FROM settings WHERE key = $1', [META_KEY]);
    if (rows.rows.length === 0) return null;
    return JSON.parse(rows.rows[0].value) as VaultMeta;
  }

  async state(): Promise<VaultState> {
    const meta = await this.getMeta();
    if (!meta) return 'uninitialized';
    return this.masterKey ? 'unsealed' : 'sealed';
  }

  async status(): Promise<{ state: VaultState; k: number; n: number }> {
    const meta = await this.getMeta();
    return {
      state: await this.state(),
      k: meta?.k ?? this.config.vaultK,
      n: meta?.n ?? this.config.vaultN,
    };
  }

  /** 初始化保险库（仅 CLI/运维执行）：生成主密钥并输出 N 份分片，主密钥随即丢弃。 */
  async initialize(k: number, n: number): Promise<{ shares: string[]; vaultId: string }> {
    const existing = await this.getMeta();
    if (existing) throw new Error('vault is already initialized');
    const masterKey = crypto.randomBytes(32);
    const shares = splitSecret(masterKey, k, n);
    const verifier = crypto.createHmac('sha256', deriveSubKey(masterKey, VERIFIER_PURPOSE)).digest('base64');
    const meta: VaultMeta = {
      version: 1,
      k,
      n,
      vaultId: crypto.randomUUID(),
      verifier,
      createdAt: Date.now(),
    };
    await this.db.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [META_KEY, JSON.stringify(meta), Date.now()],
    );
    // 主密钥只在本次进程短暂存在，CLI 退出后即消失；分片打印给 K..N 位保管人
    this.masterKey = masterKey;
    return { shares: shares.map(encodeShare), vaultId: meta.vaultId };
  }

  /** 用 ≥K 份分片解封；分片数量不足或校验失败抛错。 */
  async unseal(encodedShares: string[]): Promise<void> {
    const meta = await this.getMeta();
    if (!meta) throw new VaultUninitializedError();
    const shares: Share[] = encodedShares.map(decodeShare);
    if (shares.length < meta.k) {
      throw new Error(`not enough shares: need ${meta.k}, got ${shares.length}`);
    }
    const candidate = combineShares(shares.slice(0, meta.k));
    const verifier = crypto
      .createHmac('sha256', deriveSubKey(candidate, VERIFIER_PURPOSE))
      .digest('base64');
    if (!safeEqualTiming(verifier, meta.verifier)) {
      candidate.fill(0);
      throw new Error('invalid shares: reconstructed key does not match vault verifier');
    }
    this.masterKey = candidate;
  }

  /** 事故熔断：立即从内存擦除主密钥。 */
  seal(): void {
    this.masterKey?.fill(0);
    this.masterKey = null;
  }

  isUnsealed(): boolean {
    return this.masterKey !== null;
  }

  private requireKey(): Buffer {
    if (!this.masterKey) throw new VaultSealedError();
    return this.masterKey;
  }

  /** 写入一条加密身份映射（注册时调用，需解封）。可传入事务客户端以参与外层事务。 */
  async createIdentity(record: IdentityRecord, executor: DatabaseClient = this.db): Promise<void> {
    const key = this.requireKey();
    const hmacKey = deriveSubKey(key, HMAC_PURPOSE);
    const aesKey = deriveSubKey(key, AES_PURPOSE);
    const lookupHmac = crypto.createHmac('sha256', hmacKey).update(record.userId).digest('base64url');
    const aliasHmac = crypto.createHmac('sha256', hmacKey).update(record.alias).digest('base64url');
    const ciphertext = encryptJson(record, aesKey);
    await executor.query(
      `INSERT INTO identity_vault (lookup_hmac, alias_hmac, ciphertext, created_at)
       VALUES ($1, $2, $3, $4)`,
      [lookupHmac, aliasHmac, ciphertext, Date.now()],
    );
  }

  /** 按真实 userId 取出匿名身份（登录后获取自己的昵称；不落日志）。 */
  async findIdentityByUser(userId: string, executor: DatabaseClient = this.db): Promise<IdentityRecord | null> {
    const key = this.requireKey();
    const hmacKey = deriveSubKey(key, HMAC_PURPOSE);
    const lookupHmac = crypto.createHmac('sha256', hmacKey).update(userId).digest('base64url');
    const rows = await executor.query<{ ciphertext: string }>(
      'SELECT ciphertext FROM identity_vault WHERE lookup_hmac = $1',
      [lookupHmac],
    );
    if (rows.rows.length === 0) return null;
    const aesKey = deriveSubKey(key, AES_PURPOSE);
    return decryptJson<IdentityRecord>(rows.rows[0].ciphertext, aesKey);
  }

  /** 管理员追责：由匿名昵称反查真实身份（复用内存解封态）。 */
  async revealIdentityByAlias(alias: string, executor: DatabaseClient = this.db): Promise<IdentityRecord | null> {
    const key = this.requireKey();
    const hmacKey = deriveSubKey(key, HMAC_PURPOSE);
    const aliasHmac = crypto.createHmac('sha256', hmacKey).update(alias).digest('base64url');
    const rows = await executor.query<{ ciphertext: string }>(
      'SELECT ciphertext FROM identity_vault WHERE alias_hmac = $1',
      [aliasHmac],
    );
    if (rows.rows.length === 0) return null;
    const aesKey = deriveSubKey(key, AES_PURPOSE);
    return decryptJson<IdentityRecord>(rows.rows[0].ciphertext, aesKey);
  }

  /**
   * 门限追责：不依赖内存解封态，每次调用必须现场提供 ≥K 份分片重组主密钥。
   * 重组密钥仅存在于调用栈内，函数返回前清零，绝不写回 this.masterKey。
   * 这保证“平时无法溯源，凑齐 K 个托管人分片才能溯源”。
   */
  async revealIdentityWithShares(
    alias: string,
    encodedShares: string[],
    executor: DatabaseClient = this.db,
  ): Promise<IdentityRecord | null> {
    const meta = await this.getMeta();
    if (!meta) throw new VaultUninitializedError();
    if (encodedShares.length < meta.k) {
      throw new Error(`not enough shares: need ${meta.k}, got ${encodedShares.length}`);
    }
    const shares = encodedShares.map(decodeShare);
    const candidate = combineShares(shares.slice(0, meta.k));
    try {
      const verifier = crypto
        .createHmac('sha256', deriveSubKey(candidate, VERIFIER_PURPOSE))
        .digest('base64');
      if (!safeEqualTiming(verifier, meta.verifier)) {
        throw new Error('invalid shares: reconstructed key does not match vault verifier');
      }
      const hmacKey = deriveSubKey(candidate, HMAC_PURPOSE);
      const aesKey = deriveSubKey(candidate, AES_PURPOSE);
      const aliasHmac = crypto.createHmac('sha256', hmacKey).update(alias).digest('base64url');
      const rows = await executor.query<{ ciphertext: string }>(
        'SELECT ciphertext FROM identity_vault WHERE alias_hmac = $1',
        [aliasHmac],
      );
      if (rows.rows.length === 0) return null;
      return decryptJson<IdentityRecord>(rows.rows[0].ciphertext, aesKey);
    } finally {
      candidate.fill(0);
    }
  }
}
