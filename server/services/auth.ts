// ABOUTME: 本地账号认证与邀请码准入：scrypt 密码哈希、一次性/限时邀请码。
// 注册成功后在同一事务内创建匿名昵称并写入加密身份保险库。
import type { DatabaseClient } from '../db';
import type { AppConfig } from '../config';
import { hashPassword, verifyPassword } from '../crypto/passwords';
import { generateAlias } from './alias';
import { IdentityVault } from './vault';

export interface UserRecord {
  id: string;
  username: string;
  isAdmin: boolean;
}

export interface CreatedInvite {
  code: string;
  maxUses: number;
  expiresAt: number | null;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export async function findUserByUsername(db: DatabaseClient, username: string): Promise<(UserRecord & { passwordHash: string }) | null> {
  const rows = await db.query<{
    id: string;
    username: string;
    password_hash: string;
    is_admin: boolean;
  }>('SELECT id, username, password_hash, is_admin FROM users WHERE lower(username) = lower($1)', [username]);
  const row = rows.rows[0];
  if (!row) return null;
  return { id: row.id, username: row.username, isAdmin: row.is_admin, passwordHash: row.password_hash };
}

async function consumeInviteCode(db: DatabaseClient, code: string): Promise<void> {
  const rows = await db.query<{ max_uses: number; used_count: number; expires_at: number | null }>(
    'SELECT max_uses, used_count, expires_at FROM invite_codes WHERE code = $1 FOR UPDATE',
    [code],
  );
  const invite = rows.rows[0];
  if (!invite) throw new AuthError('邀请码无效', 400);
  if (invite.expires_at !== null && invite.expires_at < Date.now()) {
    throw new AuthError('邀请码已过期', 400);
  }
  if (invite.max_uses !== 0 && invite.used_count >= invite.max_uses) {
    throw new AuthError('邀请码已被使用', 400);
  }
  await db.query('UPDATE invite_codes SET used_count = used_count + 1 WHERE code = $1', [code]);
}

export async function registerUser(
  db: DatabaseClient,
  vault: IdentityVault,
  params: { username: string; password: string; inviteCode: string },
): Promise<UserRecord> {
  const username = params.username.trim();
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
    throw new AuthError('用户名需为 3-32 位字母、数字或 _.-');
  }
  if (params.password.length < 8) throw new AuthError('密码至少 8 位');

  return db.transaction(async (tx) => {
    if (await findUserByUsername(tx, username)) {
      throw new AuthError('用户名已存在', 409);
    }
    await consumeInviteCode(tx, params.inviteCode.trim());

    const isAdmin = false; // 管理员只能通过 ADMIN_USERNAMES 配置授予，不能自助注册
    const inserted = await tx.query<{ id: string; username: string; is_admin: boolean }>(
      'INSERT INTO users (username, password_hash, is_admin, created_at) VALUES ($1, $2, $3, $4) RETURNING id, username, is_admin',
      [username, hashPassword(params.password), isAdmin, Date.now()],
    );
    const user: UserRecord = {
      id: inserted.rows[0].id,
      username: inserted.rows[0].username,
      isAdmin: inserted.rows[0].is_admin,
    };

    // 生成匿名昵称并登记（冲突则重试）
    let aliasRow: { id: string; alias: string } | null = null;
    for (let attempt = 0; attempt < 5 && !aliasRow; attempt++) {
      const alias = generateAlias();
      const aliasRes = await tx.query<{ id: string; alias: string }>(
        'INSERT INTO aliases (alias, created_at) VALUES ($1, $2) ON CONFLICT (alias) DO NOTHING RETURNING id, alias',
        [alias, Date.now()],
      );
      aliasRow = aliasRes.rows[0] ?? null;
    }
    if (!aliasRow) throw new AuthError('系统繁忙，请重试', 503);

    await vault.createIdentity(
      {
        userId: user.id,
        username: user.username,
        aliasId: aliasRow.id,
        alias: aliasRow.alias,
      },
      tx,
    );

    return user;
  });
}

export async function authenticate(
  db: DatabaseClient,
  username: string,
  password: string,
  config: AppConfig,
): Promise<UserRecord> {
  const user = await findUserByUsername(db, username);
  // 用户不存在时也执行一次哈希比较，缓解用户名枚举的时间侧信道
  const valid = user ? verifyPassword(password, user.passwordHash) : verifyPassword(password, hashPassword(password));
  if (!user || !valid) throw new AuthError('用户名或密码错误', 401);
  return withAdminFlag(user, config);
}

function withAdminFlag(
  user: { id: string; username: string; isAdmin: boolean; passwordHash?: string },
  config: AppConfig,
): UserRecord {
  const isAdmin = user.isAdmin || config.adminUsernames.includes(user.username.toLowerCase());
  return { id: user.id, username: user.username, isAdmin };
}

export async function getUserById(
  db: DatabaseClient,
  userId: string,
  config: AppConfig,
): Promise<UserRecord | null> {
  const rows = await db.query<{ id: string; username: string; is_admin: boolean }>(
    'SELECT id, username, is_admin FROM users WHERE id = $1',
    [userId],
  );
  const row = rows.rows[0];
  return row
    ? withAdminFlag({ id: row.id, username: row.username, isAdmin: row.is_admin }, config)
    : null;
}

export async function createInvite(
  db: DatabaseClient,
  params: { code?: string; maxUses: number; ttlSeconds?: number; createdBy: string },
): Promise<CreatedInvite> {
  const code = (params.code ?? `INV-${randomCode()}`).toUpperCase();
  if (!/^[A-Z0-9-]{4,40}$/.test(code)) throw new AuthError('邀请码格式不合法');
  const expiresAt = params.ttlSeconds ? Date.now() + params.ttlSeconds * 1000 : null;
  try {
    await db.query(
      'INSERT INTO invite_codes (code, max_uses, expires_at, created_by, created_at) VALUES ($1, $2, $3, $4, $5)',
      [code, params.maxUses, expiresAt, params.createdBy, Date.now()],
    );
  } catch {
    throw new AuthError('邀请码已存在', 409);
  }
  return { code, maxUses: params.maxUses, expiresAt };
}

export async function listInvites(db: DatabaseClient): Promise<
  Array<{ code: string; maxUses: number; usedCount: number; expiresAt: number | null }>
> {
  const rows = await db.query<{
    code: string;
    max_uses: number;
    used_count: number;
    expires_at: number | null;
  }>('SELECT code, max_uses, used_count, expires_at FROM invite_codes ORDER BY created_at DESC LIMIT 200');
  return rows.rows.map((r) => ({
    code: r.code,
    maxUses: r.max_uses,
    usedCount: r.used_count,
    expiresAt: r.expires_at,
  }));
}

export async function seedBootstrapInvites(db: DatabaseClient, codes: string[]): Promise<void> {
  for (const code of codes) {
    await db.query(
      `INSERT INTO invite_codes (code, max_uses, used_count, expires_at, created_by, created_at)
       VALUES ($1, 0, 0, NULL, 'bootstrap', $2) ON CONFLICT (code) DO NOTHING`,
      [code.toUpperCase(), Date.now()],
    );
  }
}

function randomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = cryptoRandom(8);
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

function cryptoRandom(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}
