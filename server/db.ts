// ABOUTME: 数据库适配层：生产用 PostgreSQL(pg)，无 DATABASE_URL 时开发态回退 PGlite(WASM)。
// 对外暴露统一 query()；时间统一用 BIGINT 毫秒时间戳，避免驱动间 Date 差异。
import path from 'node:path';
import fs from 'node:fs';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { AppConfig } from './config';

export type { QueryResultRow } from 'pg';

// PGlite 的查询结果形状（避免直接依赖其私有类型导致 #private 不兼容）
interface PGliteLike {
  query(text: string, params?: unknown[]): Promise<{ rows: QueryResultRow[] }>;
  transaction<T>(fn: (tx: PGliteTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  waitReady: Promise<unknown>;
}

interface PGliteTx {
  query(text: string, params?: unknown[]): Promise<{ rows: QueryResultRow[] }>;
}

interface PGliteLikeFull extends PGliteLike {
  // PGlite 支持无参数多语句脚本
  exec(text: string): Promise<unknown>;
}

export interface DatabaseClient {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  /** 执行无参数多语句 DDL 脚本（迁移用） */
  exec(text: string): Promise<void>;
  transaction<T>(fn: (tx: DatabaseClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: 'postgres' | 'pglite';
}

class PgClient implements DatabaseClient {
  readonly kind = 'postgres';
  constructor(private readonly pool: Pool) {}

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[] }> {
    return this.pool.query(text, params) as Promise<{ rows: T[] }>;
  }

  async exec(text: string): Promise<void> {
    // 无参数查询走 simple query 协议，允许多语句 DDL
    await this.pool.query(text);
  }

  async transaction<T>(fn: (tx: DatabaseClient) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    const tx = clientToDatabase(this.kind, client);
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function clientToDatabase(kind: 'postgres', client: PoolClient): DatabaseClient;
function clientToDatabase(kind: 'pglite', client: PGliteTx): DatabaseClient;
function clientToDatabase(kind: 'postgres' | 'pglite', client: PoolClient | PGliteTx): DatabaseClient {
  return {
    kind,
    query: <T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) =>
      client.query(text, params) as Promise<{ rows: T[] }>,
    exec: async (text: string) => {
      await client.query(text);
    },
    transaction: async () => {
      throw new Error('nested transactions are not supported');
    },
    close: async () => undefined,
  };
}

class PGliteDatabase implements DatabaseClient {
  readonly kind = 'pglite';
  // PGlite 是单连接嵌入式库：并发查询/事务会互相等待甚至死锁。
  // 用尾指针互斥队列把所有访问串行化（仅开发态使用，生产为真 Postgres 连接池）。
  private queueTail: Promise<void> = Promise.resolve();

  constructor(private readonly db: PGliteLikeFull) {}

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    // 先同步接上当前队尾（避免并发调用时 this.queueTail 竞态覆盖），
    // 再把新的“释放信号”推进为新队尾。
    const previous = this.queueTail;
    let release!: () => void;
    this.queueTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(task).finally(release);
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[] }> {
    return this.exclusive(() => this.db.query(text, params) as Promise<{ rows: T[] }>);
  }

  async exec(text: string): Promise<void> {
    await this.exclusive(() => this.db.exec(text));
  }

  async transaction<T>(fn: (tx: DatabaseClient) => Promise<T>): Promise<T> {
    return this.exclusive(() =>
      this.db.transaction(async (pgliteTx) => fn(clientToDatabase(this.kind, pgliteTx))),
    );
  }

  async close(): Promise<void> {
    await this.exclusive(() => this.db.close());
  }
}

export async function createDatabase(config: AppConfig): Promise<DatabaseClient> {
  if (config.dbDriver === 'pg' && config.databaseUrl) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 10,
      ssl: /sslmode=require/i.test(config.databaseUrl) ? { rejectUnauthorized: false } : undefined,
    });
    // 快速失败：连接串错误时启动即报错而不是首个请求才报错
    await pool.query('SELECT 1');
    return new PgClient(pool);
  }

  // dbDriver 已在 loadConfig 中裁决：生产默认要求 DATABASE_URL，显式 DB_DRIVER=pglite 可用于单节点评估
  const { PGlite: PGliteImpl } = await import('@electric-sql/pglite');
  const dataDir = path.join(config.dataDir, 'pglite');
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new PGliteImpl(dataDir) as unknown as PGliteLikeFull;
  await db.waitReady;
  return new PGliteDatabase(db);
}

const SCHEMA_SQL = `
-- gen_random_uuid() 内建于 PG13+ 与 PGlite，无需 pgcrypto 扩展

-- 真实账户（登录凭据）。注意：不存任何昵称/匿名关联字段。
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username        TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  is_admin        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      BIGINT NOT NULL
);

-- 邀请码
CREATE TABLE IF NOT EXISTS invite_codes (
  code            TEXT PRIMARY KEY,
  max_uses        INTEGER NOT NULL DEFAULT 1,   -- 0 表示不限次数
  used_count      INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT,
  expires_at      BIGINT,                       -- NULL 不过期
  created_at      BIGINT NOT NULL
);

-- 匿名昵称（公开侧身份，与 users 之间没有任何明文外键）
CREATE TABLE IF NOT EXISTS aliases (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alias           TEXT NOT NULL UNIQUE,
  created_at      BIGINT NOT NULL
);

-- 身份保险库：user→alias 映射整表加密。
-- lookup_hmac = HMAC(vault 派生子密钥, userId)，仅用于在保险库解封时定位行；
-- ciphertext 是 AES-GCM(userId+alias+username) JSON，DB 管理员平时无法读取或关联。
CREATE TABLE IF NOT EXISTS identity_vault (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lookup_hmac     TEXT NOT NULL UNIQUE,
  alias_hmac      TEXT NOT NULL UNIQUE,
  ciphertext      TEXT NOT NULL,
  created_at      BIGINT NOT NULL
);

-- 消息：原文密文存储，广播与列表仅可见改写后的 normalized_text。
CREATE TABLE IF NOT EXISTS messages (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alias_id             UUID NOT NULL REFERENCES aliases(id),
  alias_name           TEXT NOT NULL,
  normalized_text      TEXT NOT NULL,
  ciphertext           TEXT NOT NULL,
  cipher_alg           TEXT NOT NULL DEFAULT 'AES-256-GCM',
  rewritten            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at           BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at DESC);

-- 审计日志（只记行为，不记内容）
CREATE TABLE IF NOT EXISTS audit_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor           TEXT,                          -- username 或 NULL
  action          TEXT NOT NULL,
  meta            TEXT,                          -- JSON，禁止包含明文/密钥
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log (created_at DESC);

-- 运行时键值设置（如改写开关）
CREATE TABLE IF NOT EXISTS settings (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL,
  updated_at      BIGINT NOT NULL
);
`;

export async function runMigrations(db: DatabaseClient): Promise<void> {
  await db.exec(SCHEMA_SQL);
}
