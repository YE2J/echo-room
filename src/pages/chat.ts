// ABOUTME: 公共聊天室页面：历史加载、WS 实时收发、在线状态、匿名身份、管理入口。

import { api, type ChatMessage } from '../api';
import { createWsClient, type ConnectionState } from '../ws';
import { avatarSvg, el, formatTime, icons, svg, toast } from '../components';
import { openAdminPanel } from './admin';
import { sessionToken } from '../session';

interface Identity {
  alias: string;
  visual: { hue: number; shape: number } | null;
  isAdmin: boolean;
}

interface PendingMarker {
  clientNonce: string;
  node: HTMLElement;
}

export function renderChatPage(identity: Identity, onLogout: () => void): HTMLElement {
  const shell = el('div', 'chat-shell');

  shell.innerHTML = `
    <div class="conn-bar" data-role="conn-bar"></div>
    <header class="chat-header">
      <div class="chat-title-row">
        <div class="chat-title"><span style="color:var(--accent)">${icons.bell}</span>公共匿名意见室</div>
        <div style="display:flex;gap:8px">
          ${identity.isAdmin ? '<button class="btn btn--ghost btn--sm" data-role="admin-btn" aria-label="管理">' + icons.settings + '</button>' : ''}
          <button class="btn btn--ghost btn--sm" data-role="logout-btn" aria-label="退出登录">${icons.logout}</button>
        </div>
      </div>
      <div class="chat-header-meta">
        <span class="identity-chip">
          <span data-role="self-avatar"></span>
          你的匿名身份：<strong data-role="self-alias"></strong>
        </span>
        <span class="identity-chip">
          <span class="status-dot status-dot--connecting" data-role="status-dot"></span>
          <span data-role="status-text">连接中…</span>
        </span>
        <span class="badge" data-role="rewrite-badge" hidden></span>
        <span class="badge badge--safe" title="消息以 AES-256-GCM 密文存储">${icons.lock} 密文存储</span>
      </div>
    </header>
    <main class="messages" data-role="messages">
      <div class="msg-empty">
        这里是公共意见室。<br />
        写下你观察到的问题、想提的建议——系统会用随机匿名身份代你发声，语气经归一化处理，无法从文字风格反推个人。
      </div>
    </main>
    <footer class="composer">
      <form class="composer-row" data-role="composer-form">
        <textarea data-role="input" rows="1" maxlength="2000"
          placeholder="说点什么…… 发送前系统将抹除口头禅、标点与句式习惯"></textarea>
        <button class="btn" type="submit" data-role="send-btn" aria-label="发送">${icons.send}</button>
      </form>
      <div class="composer-hint">
        <span data-role="rewrite-hint"></span>
        <span><span data-role="char-count">0</span>/2000 · Enter 发送</span>
      </div>
    </footer>
  `;

  const messagesEl = shell.querySelector<HTMLElement>('[data-role="messages"]')!;
  const inputEl = shell.querySelector<HTMLTextAreaElement>('[data-role="input"]')!;
  const formEl = shell.querySelector<HTMLFormElement>('[data-role="composer-form"]')!;
  const sendBtn = shell.querySelector<HTMLButtonElement>('[data-role="send-btn"]')!;
  const statusDot = shell.querySelector<HTMLElement>('[data-role="status-dot"]')!;
  const statusText = shell.querySelector<HTMLElement>('[data-role="status-text"]')!;
  const connBar = shell.querySelector<HTMLElement>('[data-role="conn-bar"]')!;
  const charCount = shell.querySelector<HTMLElement>('[data-role="char-count"]')!;
  const rewriteBadge = shell.querySelector<HTMLElement>('[data-role="rewrite-badge"]')!;
  const rewriteHint = shell.querySelector<HTMLElement>('[data-role="rewrite-hint"]')!;

  const selfAvatar = shell.querySelector<HTMLElement>('[data-role="self-avatar"]')!;
  selfAvatar.appendChild(svg(avatarSvg(identity.visual, 24)));
  shell.querySelector<HTMLElement>('[data-role="self-alias"]')!.textContent = identity.alias;

  const seenIds = new Set<string>();
  const pending = new Map<string, PendingMarker>();
  let rewriteEnabled = false;

  function appendMessage(message: ChatMessage, opts: { pending?: boolean; nonce?: string } = {}): void {
    if (seenIds.has(message.id)) return;
    seenIds.add(message.id);
    const placeholder = messagesEl.querySelector('.msg-empty');
    placeholder?.remove();

    const isSelf = message.aliasName === identity.alias;
    const node = el('div', `msg${isSelf ? ' msg--self' : ''}${opts.pending ? ' msg--pending' : ''}`);
    node.dataset.messageId = message.id;

    const avatar = el('div', 'avatar');
    avatar.appendChild(svg(avatarSvg({ hue: message.hue, shape: message.shape }, 38)));
    node.appendChild(avatar);

    const body = el('div', 'msg-body');
    const meta = el('div', 'msg-meta');
    const name = el('span', 'msg-name', message.aliasName);
    const time = el('span', 'msg-time', opts.pending ? '发送中' : formatTime(message.createdAt));
    meta.append(name, time);
    const bubble = el('div', 'msg-bubble', message.normalizedText);
    body.append(meta, bubble);
    node.appendChild(body);

    messagesEl.appendChild(node);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    const nonceValue = opts.nonce;
    if (isSelf && nonceValue) {
      pending.set(nonceValue, { clientNonce: nonceValue, node });
      window.setTimeout(() => {
        const marker = pending.get(nonceValue);
        if (marker && marker.node.isConnected) {
          const timeEl = marker.node.querySelector('.msg-time');
          if (timeEl) timeEl.textContent = '仍在处理…';
        }
      }, 8000);
    }
  }

  // 历史消息
  api
    .history()
    .then((data) => {
      rewriteEnabled = data.rewriteEnabled;
      renderRewriteState();
      const sorted = [...data.messages].sort((a, b) => a.createdAt - b.createdAt);
      for (const message of sorted) appendMessage(message);
    })
    .catch((err: unknown) => {
      toast(err instanceof Error ? err.message : '历史消息加载失败', 'error');
    });

  function renderRewriteState(): void {
    if (rewriteEnabled) {
      rewriteBadge.hidden = false;
      rewriteBadge.className = 'badge badge--accent';
      rewriteBadge.textContent = '语气归一化 ON';
      rewriteHint.textContent = '消息将经 LLM 抹平口头禅 / 标点 / 句式习惯';
    } else {
      rewriteBadge.hidden = false;
      rewriteBadge.className = 'badge';
      rewriteBadge.textContent = '归一化 OFF';
      rewriteHint.textContent = '改写已关闭：原文将直接广播，请注意语言习惯可能暴露身份';
    }
  }

  // WebSocket
  const ws = createWsClient({
    path: '/ws/chat',
    getToken: () => sessionToken.get(),
    onStateChange: (state: ConnectionState) => {
      statusDot.className = `status-dot status-dot--${state}`;
      connBar.className = `conn-bar conn-bar--${state}`;
      statusText.textContent = state === 'online' ? '已连接' : state === 'connecting' ? '连接中…' : '已断开';
    },
    onReady: ({ rewriteEnabled: enabled }) => {
      rewriteEnabled = enabled;
      renderRewriteState();
    },
    onChatMessage: (message) => {
      appendMessage(message);
      // 自己发出的消息：用广播回来的正式版本替换乐观气泡
      if (message.aliasName === identity.alias) {
        for (const [nonce, marker] of pending) {
          if (marker.node.isConnected && !marker.node.dataset.confirmed) {
            marker.node.dataset.confirmed = '1';
            marker.node.classList.remove('msg--pending');
            marker.node.querySelector('.msg-time')!.textContent = formatTime(message.createdAt);
            marker.node.dataset.messageId = message.id;
            pending.delete(nonce);
            return;
          }
        }
      }
    },
    onErrorMessage: (message, code) => {
      toast(message, 'error');
      if (code === 'unauthorized' || message.includes('保险库')) {
        window.setTimeout(() => onLogout(), 1500);
      }
    },
  });

  // 输入框自适应高度
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 140)}px`;
    charCount.textContent = String(inputEl.value.length);
  });

  formEl.addEventListener('submit', (event: SubmitEvent) => {
    event.preventDefault();
    const text = inputEl.value.trim();
    if (!text) return;
    const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    ws.send('chat:send', { text, clientNonce: nonce });
    // 乐观渲染：等待广播回来的确认版本替换
    const tempId = `pending-${nonce}`;
    seenIds.add(tempId);
    appendMessage(
      {
        id: tempId,
        aliasName: identity.alias,
        normalizedText: text,
        createdAt: Date.now(),
        hue: identity.visual?.hue ?? 20,
        shape: identity.visual?.shape ?? 0,
      },
      { pending: true, nonce },
    );
    inputEl.value = '';
    inputEl.style.height = 'auto';
    charCount.textContent = '0';
    sendBtn.disabled = true;
    window.setTimeout(() => {
      sendBtn.disabled = false;
    }, 400);
  });

  inputEl.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      formEl.requestSubmit();
    }
  });

  shell.querySelector<HTMLButtonElement>('[data-role="logout-btn"]')!.addEventListener('click', async () => {
    try {
      ws.close();
      sessionToken.clear();
      await api.logout();
    } finally {
      onLogout();
    }
  });

  shell.querySelector<HTMLButtonElement>('[data-role="admin-btn"]')?.addEventListener('click', () => {
    openAdminPanel(() => {
      /* 解封后溯源接口立即可用，无需额外刷新页面 */
    });
  });

  return shell;
}
