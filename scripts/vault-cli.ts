#!/usr/bin/env node
// ABOUTME: 身份保险库运维 CLI：初始化主密钥并输出 Shamir 分片 / 检查封存状态 / 签发邀请码。
// 用法（构建后，见 dist-server/vault-cli.js）：
//   node dist-server/vault-cli.js init [K] [N]
//   node dist-server/vault-cli.js status
//   node dist-server/vault-cli.js invite [CODE] [MAX_USES]   (MAX_USES=0 表示不限次数)
//
// 生产环境示例：
//   docker compose run --rm app node dist-server/vault-cli.js init 2 3
//   docker compose run --rm app node dist-server/vault-cli.js invite TEAM-Q3 50
//
// init 输出的 N 份分片必须分发给不同保管人（线下/密码管理器），切勿存入服务器或数据库。
import 'dotenv/config';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { IdentityVault } from '../server/services/vault.ts';
import { loadConfig } from '../server/config.ts';
import { runMigrations } from '../server/db.ts';
import { createInvite, seedBootstrapInvites } from '../server/services/auth.ts';

async function openDb(config) {
  if (config.databaseUrl) {
    const pool = new pg.Pool({ connectionString: config.databaseUrl });
    await pool.query('SELECT 1');
    return {
      kind: 'postgres',
      query: (text, params = []) => pool.query(text, params),
      transaction: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const r = await fn({ query: (t, p = []) => client.query(t, p) });
          await client.query('COMMIT');
          return r;
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      },
      exec: async (text: string) => {
        await pool.query(text);
      },
      close: () => pool.end(),
    };
  }
  const dir = new URL('../.data/pglite', import.meta.url).pathname;
  const db = new PGlite(dir);
  await db.waitReady;
  return {
    kind: 'pglite',
    query: (text, params = []) => db.query(text, params).then((r) => ({ rows: r.rows })),
    exec: async (text: string) => db.exec(text),
    transaction: async (fn) =>
      db.transaction((tx) => fn({ query: (t, p = []) => tx.query(t, p).then((r) => ({ rows: r.rows })) })),
    close: () => db.close(),
  };
}

async function main() {
  const config = loadConfig(process.env);
  const db = await openDb(config);
  await runMigrations(db);
  const vault = new IdentityVault(db, config);
  const [command, ...args] = process.argv.slice(2);

  if (command === 'init') {
    const k = Number(args[0] ?? config.vaultK);
    const n = Number(args[1] ?? config.vaultN);
    const state = await vault.state();
    if (state !== 'uninitialized') {
      console.error(`保险库已初始化（当前状态：${state}），拒绝重复初始化。`);
      process.exit(1);
    }
    const { shares, vaultId } = await vault.initialize(k, n);
    console.log('============================================================');
    console.log(`保险库已初始化 vaultId=${vaultId}，门限 ${k}/${n}`);
    console.log('请将下列分片【分别】交给不同保管人，切勿保存在服务器：');
    console.log('============================================================');
    shares.forEach((s, i) => console.log(`Share ${i + 1}:  ${s}`));
    console.log('------------------------------------------------------------');
    console.log(`解封：管理员登录 Web 管理台，或调用 POST /api/admin/vault/unseal，至少提供 ${k} 份。`);
    vault.seal();
  } else if (command === 'status') {
    console.log(await vault.status());
  } else if (command === 'invite') {
    const code = args[0] ? args[0].toUpperCase() : undefined;
    const maxUses = Number(args[1] ?? 1);
    const invite = await createInvite(db, { code, maxUses, createdBy: 'cli' });
    console.log('邀请码已创建：', JSON.stringify(invite));
  } else if (command === 'seed-default-invites') {
    await seedBootstrapInvites(db, config.bootstrapInviteCodes);
    console.log('已注入默认邀请码：', config.bootstrapInviteCodes.join(', '));
  } else {
    console.error('未知命令。可用：init [K] [N] | status | invite [CODE] [MAX_USES] | seed-default-invites');
    process.exit(1);
  }

  await db.close();
}

main().catch((err) => {
  console.error('CLI 执行失败：', err.message);
  process.exit(1);
});
