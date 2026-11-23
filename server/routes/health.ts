// ABOUTME: 永不退出的健康检查与诊断接口。
// /api/health 永远返回 200，各子系统状态如实上报（DB 挂了也 200，供部署后 HTTP 自查）；
// /api/health/diag 返回环境变量 key 名（绝不返回值）、路径、可写性等诊断信息。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config';

export interface HealthState {
  env: string;
  db: string;
  dbError: string | null;
  bus: string;
  vault: string;
  llmProvider: string;
}

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
  'VAULT_AUTO_UNSEAL_SHARES',
] as const;

function probeWritable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.diag-probe-${process.pid}-${Date.now()}.tmp`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== '';
}

export function registerHealthRoutes(
  app: FastifyInstance,
  config: AppConfig,
  state: HealthState,
  startedAt: number,
): void {
  app.get('/api/health', async () => {
    const distExists = fs.existsSync(path.resolve(process.cwd(), 'dist'));
    return {
      status: 'ok',
      env: state.env,
      // env=密钥来自环境变量；ephemeral=配置非法已降级为临时随机密钥（重启即失去旧密文）
      secretSource: config.secretSource,
      db: state.db,
      dbError: state.dbError,
      bus: state.bus,
      vault: state.vault,
      llmProvider: state.llmProvider,
      dataDir: config.dataDir ?? null,
      dataDirSource: config.dataDirSource,
      port: config.port,
      nodeVersion: process.version,
      distExists,
      startedAt,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    };
  });

  app.get('/api/health/diag', async (request, reply) => {
    // 生产环境默认关闭诊断明细（会暴露全部环境变量名、路径、目录内容）。
    // 需要时显式设置 HEALTH_DIAG_TOKEN，并带请求头 x-diag-token 访问。
    const diagToken = process.env.HEALTH_DIAG_TOKEN;
    if (config.isProd && !diagToken) {
      return reply.code(404).send({ error: 'not found' });
    }
    if (diagToken && request.headers['x-diag-token'] !== diagToken) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const cwd = process.cwd();
    const distDir = path.resolve(cwd, 'dist');
    let distContents: string[] = [];
    try {
      distContents = fs.readdirSync(distDir).sort();
    } catch {
      distContents = [];
    }
    let pgliteExists = false;
    try {
      pgliteExists = fs.existsSync(path.resolve(cwd, 'node_modules/@electric-sql/pglite'));
    } catch {
      pgliteExists = false;
    }
    const envKeys = Object.keys(process.env)
      .sort()
      .map((key) => `${key}:${isSet(process.env[key]) ? '[set]' : '[unset]'}`);
    const highlights: Record<string, string> = {};
    for (const key of FOCUS_KEYS) {
      highlights[key] = isSet(process.env[key]) ? '[set]' : '[unset]';
    }
    return {
      envKeys,
      highlights,
      cwd,
      dirname: typeof __dirname === 'string' ? __dirname : null,
      dist: {
        exists: distContents.length > 0 || fs.existsSync(distDir),
        contents: distContents,
      },
      pgliteModule: pgliteExists,
      tmpWritable: probeWritable(os.tmpdir()),
      dataDir: config.dataDir,
      dataDirWritable: config.dataDir ? probeWritable(config.dataDir) : false,
      dataDirSource: config.dataDirSource,
      port: config.port,
      nodeVersion: process.version,
    };
  });
}