// ABOUTME: WebSocket 端点注册表与 HTTP upgrade 路由（打破 ws 模块循环依赖）。

import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

export type WsHandler = (ws: WebSocket, req: IncomingMessage) => void;

const endpoints = new Map<string, WebSocketServer>();

/** 注册端点；调用方可通过返回的 wss 自行监听 connection，或传入 handler。 */
export function registerWs(path: string, handler?: WsHandler): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  endpoints.set(path, wss);
  if (handler) {
    wss.on('connection', (ws, req) => handler(ws, req as IncomingMessage));
  }
  return wss;
}

export function attachUpgrade(server: import('node:http').Server): void {
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const wss = endpoints.get(pathname);
    if (!wss) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });
}
