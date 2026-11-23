// ABOUTME: Fastify 单端口服务：HTTP API + WebSocket(/ws/*) + 开发态 Vite middleware / 生产态静态托管。
// 韧性策略：任何子系统（配置 / DB / vault / bus / LLM）初始化失败都不退出进程——服务必须活着，
// /api/health 永远 200、/api/health/diag 提供环境诊断，供部署成功后 HTTP 自查。
// 最先加载 .env（dotenv 不覆盖平台已注入的真实环境变量，仅补齐缺失项，如 ADMIN_USERNAMES）。
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import middie from '@fastify/middie';
import fastifyStatic from '@fastify/static';
import { loadConfig, fallbackConfig, type AppConfig } from './config';
import { createDatabase, runMigrations } from './db';
import { createMessageBus, createMemoryBus } from './bus';
import { IdentityVault } from './services/vault';
import { Rewriter } from './services/rewriter';
import { TraceShareDepository } from './services/trace';
import { migrateAuditPrivacy } from './services/privacy';
import { seedBootstrapInvites } from './services/auth';
import { registerAuthRoutes } from './routes/auth';
import { registerChatRoutes } from './routes/chat';
import { registerAdminRoutes } from './routes/admin';
import { registerTraceRoutes } from './routes/trace';
import { registerOidcRoutes } from './routes/oidc';
import { registerRoomRoutes, registerAdminRoomRoutes } from './routes/rooms';
import { seedDefaultRoom } from './services/rooms';
import { attachUpgrade, registerChatWs } from './ws';
import { registerHealthRoutes, type HealthState } from './routes/health';
import type { AppContext } from './context';

const isDev = process.env.COZE_PROJECT_ENV !== 'PROD' && process.env.NODE_ENV !== 'production';

const FOCUS_KEYS = [
  'JWT_SECRET',
  'MESSAGE_ENCRYPTION_KEY',
  'COZE_PROJECT_ENV',
  'PORT',
  'DEPLOY_RUN_PORT',
  'COZE_WORKSPACE_PATH',
  'DATABASE_URL',
  'DB_DRIVER',
  'REDIS_URL',
  'LLM_PROVIDER',
  'LLM_NORMALIZE_ENABLED',
  'ADMIN_USERNAMES',
] as const;

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== '';
}

/** 启动诊断横幅：只打印环境变量数量与关注项 [set]/[unset]，不逐条列出全部变量名 */
function printEnvDiagnostics(app: FastifyInstance): void {
  try {
    // 日志常被平台收集/转发，变量名本身就能泄漏部署方用了哪些服务与密钥（*_API_KEY / *_TOKEN 结尾的名字），
    // 因此只打数量与关注项摘要，不再逐条输出。
    const all = Object.keys(process.env);
    app.log.info(`env keys: ${all.length} total (names withheld, see env focus below)`);
    const focus = FOCUS_KEYS.map((k) => `${k}=${isSet(process.env[k]) ? '[set]' : '[unset]'}`);
    app.log.info(`env focus: ${focus.join('  ')}`);
  } catch (err) {
    app.log.error(`env diagnostics failed: ${(err as Error).message}`);
  }
}

/** 全局崩溃守卫：只记录错误栈，绝不退出进程（服务必须活着） */
function installCrashGuards(app: FastifyInstance): void {
  process.on('uncaughtException', (err) => {
    app.log.error(`[guard] uncaughtException (service keeps running): ${err?.stack ?? String(err)}`);
  });
  process.on('unhandledRejection', (reason) => {
    app.log.error(`[guard] unhandledRejection (service keeps running): ${String(reason)}`);
  });
}

async function main(): Promise<void> {
  const startedAt = Date.now();

  // 1) 配置：loadConfig 抛错（如生产缺 JWT_SECRET / 密钥长度非法）时以随机密钥兜底，绝不因配置退出
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    // 平台要求端口必须监听，所以这里不退出；但必须让部署方看见后果：
    // 临时随机密钥意味着重启后此前写入的消息密文/会话永久不可解。
    console.error(
      `[config] FATAL-DEGRADED: ${(err as Error).message}\n` +
        '[config] 已降级为临时随机密钥启动（secretSource=ephemeral）。' +
        '此前写入的消息密文与会话在本进程重启后将永久不可解密，请立即修复配置并重建数据。',
    );
    config = fallbackConfig(process.env);
  }
  const isProd = config.isProd;

  const app = Fastify({
    logger: isDev
      ? { transport: undefined, level: 'info' }
      : { level: 'warn' },
    bodyLimit: 256 * 1024,
  });

  installCrashGuards(app);
  printEnvDiagnostics(app);

  // 启动校验：LLM_PROVIDER=coze 但缺少必填项 → 生产明确报错退出，禁止静默降级；
  // 开发环境仅打印提示（走本地归一化兜底，避免破坏本地调试）。
  const cozeMissing = !config.llm.cozeApiUrl || !config.llm.cozeProjectId;
  if (config.llm.provider === 'coze' && config.isProd && cozeMissing) {
    app.log.error(
      `[config] LLM_PROVIDER=coze 但 ${!config.llm.cozeApiUrl ? 'LLM_COZE_API_URL' : 'LLM_COZE_PROJECT_ID'} 为空：请在部署平台配置扣子智能体域名与项目 ID 并重启`,
    );
    process.exit(1);
  }
  if (config.llm.provider === 'coze' && !config.isProd && cozeMissing) {
    app.log.warn('[config] LLM_PROVIDER=coze 但缺少 LLM_COZE_API_URL / LLM_COZE_PROJECT_ID，改写将走本地归一化兜底');
  }
  if (config.bootstrapInviteCodes.length === 0) {
    app.log.warn('[config] 未配置 BOOTSTRAP_INVITE_CODES：未注入引导邀请码，请通过管理后台或 vault-cli invite 签发');
  }

  const health: HealthState = {
    env: isProd ? 'production' : 'development',
    db: config.dbDriver,
    dbError: null,
    bus: 'na',
    vault: 'na',
    llmProvider: config.llm.provider,
  };

  app.log.info(
    `startup diagnostics — cwd=${process.cwd()} node=${process.version} env=${isProd ? 'production' : 'development'} port=${config.port} listen=0.0.0.0:${config.port} dataDir=${config.dataDir ?? '(none → in-memory PGlite)'} dataSrc=${config.dataDirSource} dbDriver=${config.dbDriver}${config.databaseUrl ? '' : ' (DATABASE_URL unset)'} dist=${fs.existsSync(path.resolve(process.cwd(), 'dist')) ? 'present' : 'MISSING'}`,
  );

  // 2) DB：失败不阻断监听（服务降级为 health-only，仍可通过 /api/health 自查）
  let db: Awaited<ReturnType<typeof createDatabase>> | null = null;
  try {
    db = await createDatabase(config);
    await runMigrations(db);
    await seedBootstrapInvites(db, config.bootstrapInviteCodes);
    // M3：幂等默认大厅 + 历史消息回填（无则建、有则跳过；重复启动不重复插）
    const lobbyId = await seedDefaultRoom(db);
    app.log.info(`default room ready: ${lobbyId}`);
    // 匿名性加固：清洗存量审计日志（真实用户名 → null / admin#N；meta 剥离身份键）。
    // 幂等、失败不阻断启动；同时覆盖新写入的日志（写路径已强制脱敏）。
    await migrateAuditPrivacy(db, config.adminUsernames)
      .then(() => app.log.info('[privacy] audit log sanitized'))
      .catch((err: Error) => app.log.error(`[privacy] audit sanitize failed (non-fatal): ${err.message}`));
    health.db = db.kind;
  } catch (err) {
    health.db = 'error';
    health.dbError = (err as Error).message;
    app.log.error(`[db] init failed — serving health-only: ${health.dbError}`);
  }

  await app.register(cookie);
  registerHealthRoutes(app, config, health, startedAt);

  // 4) DB 不可用：仅保留健康检查与前端壳，业务路由不注册（进程照常监听）
  if (!db) {
    await setupFrontendServing(app);
    app.setErrorHandler((error: FastifyError, _request, reply) => {
      app.log.error(error);
      void reply.code(error.statusCode ?? 500).send({ error: error.message });
    });
    await app.listen({ port: config.port, host: '0.0.0.0' });
    app.log.info(`Echo Room (health-only, db unavailable) ready on http://0.0.0.0:${config.port} (${isDev ? 'dev' : 'prod'})`);
    return;
  }

  // 5) 子系统：各自兜底，失败只记录状态，不阻断监听
  const bus = await createMessageBus(config).catch((err: Error) => {
    app.log.error(`[bus] init failed, falling back to in-process bus: ${err.message}`);
    return createMemoryBus();
  });
  health.bus = bus.kind;

  let vault: IdentityVault;
  try {
    vault = new IdentityVault(db, config);
    const vState = await vault.state();

    if (vState === 'uninitialized') {
      if (config.vaultAutoBootstrap) {
        // 5.1) 首次启动自动引导（生产单管理员 / 开发开箱即用）：
        //      生成 K/N 分片 → 内存解封 → 分片加密落库备份 → 启动日志打印一次明文
        const { shares, vaultId } = await vault.initialize(config.vaultK, config.vaultN);
        await vault.unseal(shares.slice(0, config.vaultK));
        try {
          await vault.persistEncryptedShares(vaultId, shares);
        } catch (err) {
          app.log.error(`[vault] share backup persistence failed (share printed below once; keep it safe): ${(err as Error).message}`);
        }
        app.log.warn(
          `[VAULT AUTO-BOOTSTRAP] identity vault initialized (vaultId=${vaultId}, k=${config.vaultK}, n=${config.vaultN}); ` +
            `unsealed + encrypted share backup persisted. ` +
            `SHARES PRINTED ONLY ONCE — BACK THEM UP NOW BEFORE CONTINUING:\n` +
            shares.map((s, i) => `  share[${i + 1}]: ${s}`).join('\n'),
        );
        health.vault = 'unsealed';
      } else {
        app.log.warn('[VAULT] VAULT_AUTO_BOOTSTRAP disabled and vault uninitialized; registration will be rejected until vault is initialized');
        health.vault = 'uninitialized';
      }
    } else if (vState === 'sealed') {
      // 5.2) 已有分片（meta 存在）：先试加密备份自动恢复；再试 env 分片；开发态最后读本地文件
      let recovered = false;
      try {
        recovered = await vault.restoreFromBackup();
        if (recovered) app.log.warn('[VAULT] auto-unsealed from encrypted share backup');
      } catch (err) {
        app.log.error(`[vault] backup restore failed: ${(err as Error).message}`);
      }
      if (!recovered && config.vaultAutoUnsealShares.length > 0) {
        try {
          await vault.unseal(config.vaultAutoUnsealShares);
          recovered = true;
          app.log.info('identity vault auto-unsealed via VAULT_AUTO_UNSEAL_SHARES');
        } catch (err) {
          app.log.error(`auto-unseal failed: ${(err as Error).message}`);
        }
      }
      if (!recovered && !isProd) {
        // 5.3) 开发态：读本地 .data 分片自动解封（兼容旧版 dev-vault-shares.json）
        try {
          if (config.dataDir) {
            const devSharesFile = path.join(config.dataDir, 'dev-vault-shares.json');
            if (fs.existsSync(devSharesFile)) {
              const parsed = JSON.parse(fs.readFileSync(devSharesFile, 'utf8')) as { shares: string[]; k: number };
              await vault.unseal(parsed.shares.slice(0, parsed.k));
              recovered = true;
              app.log.warn('[DEV] identity vault auto-unsealed from local dev shares');
            }
          }
        } catch (err) {
          app.log.error(`dev auto-unseal failed: ${(err as Error).message}`);
        }
      }
      if (!recovered) {
        app.log.warn('[VAULT] sealed; registration/reveal will be rejected until an admin unseals with shares');
      }
      health.vault = (await vault.status()).state;
    } else {
      health.vault = 'unsealed';
    }
  } catch (err) {
    health.vault = 'error';
    app.log.error(`[vault] init failed (service keeps running): ${(err as Error).message}`);
    vault = new IdentityVault(db, config); // 二次构造兜底维持类型；仅极端场景进入
  }

  const rewriter = new Rewriter(config, db);
  const traceShares = new TraceShareDepository();
  const ctx: AppContext = { config, db, bus, vault, rewriter, traceShares };

  registerAuthRoutes(app, ctx);
  registerChatRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerTraceRoutes(app, ctx);
  registerOidcRoutes(app, ctx);
  registerRoomRoutes(app, ctx);
  registerAdminRoomRoutes(app, ctx);

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
  app.log.info(`vault: ${health.vault}, db: ${db.kind}, bus: ${bus.kind}, rewrite: ${rewriteMode}`);

  const shutdown = async (): Promise<void> => {
    app.log.info('shutting down, sealing vault...');
    try {
      vault.seal();
    } catch {
      // 忽略二次关闭
    }
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
    app.log.info('vite middleware attached (dev HMR on :6000)');
    return;
  }
  // 生产态：静态托管 dist/
  await app.register(fastifyStatic, {
    root: path.resolve(process.cwd(), 'dist'),
    prefix: '/',
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.url?.startsWith('/api/') || request.url?.startsWith('/ws/')) {
      void reply.code(404).send({ error: 'not found' });
      return;
    }
    void reply.sendFile('index.html');
  });
}

void main().catch((err) => {
  // 极极端兜底：main 顶层都失败时仍然打印，不静默退出（进程事件已被守卫覆盖，这里仅保证日志可见）
  console.error('[fatal] main() crashed uncaught:', err?.stack ?? String(err));
  setInterval(() => {
    // 保持事件循环存活，让 uncaughtException 守卫有机会接管后续请求
  }, 60000);
});