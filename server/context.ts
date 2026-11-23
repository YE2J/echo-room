// ABOUTME: 应用级共享上下文（依赖容器），供 HTTP 路由与 WebSocket 处理器共用。
import type { AppConfig } from './config';
import type { DatabaseClient } from './db';
import type { MessageBus } from './bus';
import { IdentityVault } from './services/vault';
import { Rewriter } from './services/rewriter';
import { TraceShareDepository } from './services/trace';

export interface AppContext {
  config: AppConfig;
  db: DatabaseClient;
  bus: MessageBus;
  vault: IdentityVault;
  rewriter: Rewriter;
  traceShares: TraceShareDepository;
}

export interface AuthenticatedUser {
  id: string;
  username: string;
  isAdmin: boolean;
  aliasId: string;
  alias: string;
}
