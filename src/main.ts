// ABOUTME: 应用启动入口：会话探测与 认证页/聊天室 视图切换。

import './index.css';
import './styles.css';
import { api, type AliasVisual, type AuthResult } from './api';
import { renderAuthPage } from './pages/auth';
import { renderChatPage } from './pages/chat';
import { sessionToken } from './session';

const appNode = document.querySelector('#app');
if (!(appNode instanceof HTMLDivElement)) throw new Error('根节点 #app 不存在');
const app: HTMLDivElement = appNode;

interface SessionIdentity {
  alias: string;
  visual: AliasVisual | null;
  isAdmin: boolean;
}

let currentView: HTMLElement | null = null;

function mount(view: HTMLElement): void {
  currentView?.remove();
  currentView = view;
  app.appendChild(view);
}

function showChat(identity: SessionIdentity): void {
  mount(renderChatPage(identity, showAuth));
}

function showAuth(): void {
  sessionToken.clear();
  mount(
    renderAuthPage((result: AuthResult) => {
      if (result.wsToken) sessionToken.set(result.wsToken);
      showChat({
        alias: result.alias ?? '匿名者',
        visual: result.visual ?? null,
        isAdmin: result.isAdmin ?? false,
      });
    }),
  );
}

async function bootstrap(): Promise<void> {
  // 页面刷新后 sessionStorage 令牌仍在，直接用 /me 恢复；否则回到登录页
  try {
    const me = await api.me();
    if (!sessionToken.get()) showAuth();
    else showChat(me);
  } catch {
    showAuth();
  }
}

void bootstrap();
