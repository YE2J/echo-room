// ABOUTME: Fastify 单端口服务：HTTP API + WebSocket(/ws/*) + 开发态 Vite middleware / 生产态静态托管。
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import middie from '@fastify/middie';
import fastifyStatic from '@fastify/static';
import { loadConfig } from './config';
import { createDatabase, runMigrations } from './db';
import { createMessageBus } from './bus';
import { IdentityVault } from './services/vault';
import { Rewriter } from './services/rewriter';
import { seedBootstrapInvites } from './services/auth';
import { registerAuthRoutes } from './routes/auth';
import { registerChatRoutes } from './routes/chat';
import { registerAdminRoutes } from './routes/admin';
import { registerOidcRoutes } from './routes/oidc';
import { attachUpgrade, registerChatWs } from './ws';
import type { AppContext } from './context';

const isDev = process.env.COZE_PROJECT_ENV !== 'PROD' && process.env.NODE_ENV !== 'production';

async function main(): Promise<void> {
  const config = loadConfig();
  const isProd = config.isProd;

  const app = Fastify({
    logger: isDev
      ? { transport: undefined, level: 'info' }
      : { level: 'warn' },
    bodyLimit: 256 * 1024,
  });

  const db = await createDatabase(config);
  await runMigrations(db);
  await seedBootstrapInvites(db, config.bootstrapInviteCodes);

  const bus = await createMessageBus(config);
  const vault = new IdentityVault(db, config);
  const rewriter = new Rewriter(config.llm);

  // 1) 开发态首次启动：自动初始化保险库，分片仅落本地 .data（生产绝不执行）
  if (!isProd) {
    const state = await vault.state();
    if (state === 'uninitialized') {
      const { shares, vaultId } = await vault.initialize(config.vaultK, config.vaultN);
      const devSharesFile = path.join(config.dataDir, 'dev-vault-shares.json');
      fs.writeFileSync(
        devSharesFile,
        JSON.stringify({ vaultId, k: config.vaultK, n: config.vaultN, shares }, null, 2),
        { mode: 0o600 },
      );
      app.log.warn(`[DEV] identity vault initialized; shares written to ${devSharesFile} (never do this in prod)`);
    }
  }

  // 2) 开发态/单管理员环境：用环境变量中的分片自动解封（生产默认无此变量，保持封存）
  if (config.vaultAutoUnsealShares.length > 0) {
    try {
      await vault.unseal(config.vaultAutoUnsealShares);
      app.log.info('identity vault auto-unsealed via VAULT_AUTO_UNSEAL_SHARES');
    } catch (err) {
      app.log.error(`auto-unseal failed: ${(err as Error).message}`);
    }
  }

  // 3) 开发态：读本地分片自动解封，保证注册/登录开箱即用
  if (!isProd && !vault.isUnsealed()) {
    try {
      const devSharesFile = path.join(config.dataDir, 'dev-vault-shares.json');
      if (fs.existsSync(devSharesFile)) {
        const parsed = JSON.parse(fs.readFileSync(devSharesFile, 'utf8')) as { shares: string[]; k: number };
        await vault.unseal(parsed.shares.slice(0, parsed.k));
        app.log.warn('[DEV] identity vault auto-unsealed from local dev shares');
      }
    } catch (err) {
      app.log.error(`dev auto-unseal failed: ${(err as Error).message}`);
    }
  }

  const ctx: AppContext = { config, db, bus, vault, rewriter };

  await app.register(cookie);

  app.get('/api/health', async () => ({
    status: 'ok',
    env: isDev ? 'development' : 'production',
    db: db.kind,
    bus: bus.kind,
    vault: (await vault.status()).state,
    timestamp: Date.now(),
  }));

  registerAuthRoutes(app, ctx);
  registerChatRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerOidcRoutes(app, ctx);

  // WebSocket：挂到 Fastify 底层 http.Server 的 upgrade 事件
  registerChatWs(ctx);
  attachUpgrade(app.server);

  await setupFrontendServing(app);

  // 统一错误处理（不向前端泄露堆栈）
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    app.log.error(error);
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 400 && statusCode < 500) {
      void reply.code(statusCode).send({ error: error.message });
      return;
    }
    void reply.code(500).send({ error: '服务器内部错误' });
  });

  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`Echo Room ready on http://0.0.0.0:${config.port} (${isDev ? 'dev' : 'prod'})`);
  const rewriteMode = !rewriter.isEnabled() ? 'off' : rewriter.hasProvider() ? config.llm.provider : 'local-rules';
  app.log.info(`vault: ${(await vault.status()).state}, db: ${db.kind}, bus: ${bus.kind}, rewrite: ${rewriteMode}`);

  const shutdown = async (): Promise<void> => {
    app.log.info('shutting down, sealing vault...');
    vault.seal();
    await app.close();
    await bus.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

async function setupFrontendServing(app: ReturnType<typeof Fastify>): Promise<void> {
  if (isDev) {
    // 开发态：Vite middleware 模式（HMR 走独立 6000 端口，与业务 WS 不冲突）
    await app.register(middie);
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: { port: 6000 } },
      appType: 'spa',
      root: process.cwd(),
    });
    // 业务接口与 WS 必须绕过 Vite 的 SPA fallback（middleware 运行于路由之前）
    app.use((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: (err?: Error) => void) => {
      if (req.url?.startsWith('/api/') || req.url?.startsWith('/ws/')) {
        next();
        return;
      }
      vite.middlewares(req, res, next);
    });
    return;
  }

  // 生产态：托管 dist/，SPA fallback 到 index.html
  const distPath = path.resolve(process.cwd(), 'dist');
  if (!fs.existsSync(distPath)) {
    throw new Error('dist/ not found; run the frontend build before starting in production');
  }
  await app.register(fastifyStatic, { root: distPath, wildcard: false });
  app.setNotFoundHandler((_request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    return reply.type('text/html').send(fs.createReadStream(path.join(distPath, 'index.html')));
  });
}

main().catch((err: unknown) => {
  console.error('fatal startup error:', err);
  process.exit(1);
});
