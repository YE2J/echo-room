// ABOUTME: 开发态一次性运维脚本：把指定用户名直接提升为管理员（users.is_admin=true）。
// 用法：先停止占用 PGlite 的服务进程，再执行 `npx tsx scripts/promote-admin.ts <username...>`。
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

async function main(): Promise<void> {
  const usernames = process.argv.slice(2);
  if (usernames.length === 0) {
    console.error('usage: tsx scripts/promote-admin.ts <username...>');
    process.exit(1);
  }
  const dataDir = path.join(process.env.DATA_DIR || path.resolve(process.cwd(), '.data'), 'pglite');
  const db = new PGlite(dataDir);
  await db.waitReady;
  try {
    for (const name of usernames) {
      const res = await db.query<{ username: string; is_admin: boolean }>(
        'UPDATE users SET is_admin = true WHERE username = $1 RETURNING username, is_admin',
        [name],
      );
      if (res.rows.length === 0) console.error(`NOT FOUND: ${name}`);
      else console.log(`PROMOTED: ${res.rows[0].username} is_admin=${res.rows[0].is_admin}`);
    }
    const check = await db.query<{ username: string; is_admin: boolean }>(
      "SELECT username, is_admin FROM users WHERE username LIKE 'test_%' ORDER BY username",
    );
    console.log('--- current test_* users ---');
    for (const r of check.rows) console.log(`${r.username}: is_admin=${r.is_admin}`);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
