// ABOUTME: OIDC 单点登录预留接口。MVP 默认关闭；配置 OIDC_ENABLED=true 及相关参数后，
// 在此实现标准 Authorization Code 流程（/authorize 跳转 → /callback 换 token → userinfo 建号）。
// 当前统一返回 501，保证前端与部署配置位先行就位。
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';

export function registerOidcRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/auth/oidc/config', async (_request, reply) => {
    if (!ctx.config.oidc.enabled) {
      return reply.send({ enabled: false });
    }
    return reply.send({
      enabled: true,
      issuer: ctx.config.oidc.issuer ?? null,
      clientId: ctx.config.oidc.clientId ?? null,
      // M1 仅暴露是否启用与入口地址；完整流程在 M2 落地
      authorizePath: '/api/auth/oidc/authorize',
    });
  });

  app.get('/api/auth/oidc/authorize', async (_request, reply) => {
    return reply.code(501).send({
      error: 'OIDC 登录将在下一里程碑开放，请使用邀请码账号登录',
      code: 'oidc_not_implemented',
    });
  });

  app.get('/api/auth/oidc/callback', async (_request, reply) => {
    return reply.code(501).send({
      error: 'OIDC 登录将在下一里程碑开放',
      code: 'oidc_not_implemented',
    });
  });
}
