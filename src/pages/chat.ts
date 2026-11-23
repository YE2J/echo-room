// ABOUTME: 公共聊天室页面（多房间版）：左栏房间列表 + 右栏聊天区。
// 历史加载、WS 实时收发（按房间过滤）、在线状态、匿名身份、管理入口。

import { api, type ChatMessage, type Room } from '../api';
import { createWsClient, type ConnectionState } from '../ws';
import { avatarSvg, el, formatTime, icons, svg, toast } from '../components';
import { openAdminPanel } from './admin';
import { openCreateRoomPanel, openMyRequestsPanel, openRoomSettingsPanel, type RoomPanelConnector } from './room-panels';
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
    <div class="chat-main">
      <aside class="rooms-pane" data-role="rooms-pane">
        <div class="rooms-head">
          <span class="rooms-title">房间</span>
          <button class="btn btn--ghost btn--sm rooms-refresh" type="button" data-role="rooms-refresh" title="刷新房间列表" aria-label="刷新房间列表">${icons.refresh}</button>
        </div>
        <div class="rooms-list" data-role="rooms-list"></div>
        <div class="rooms-foot">
          <button class="btn btn--ghost btn--block btn--sm" type="button" data-role="new-room-btn">${icons.plus} 新建房间</button>
          ${identity.isAdmin ? '' : '<button class="btn btn--ghost btn--block btn--sm" type="button" data-role="my-requests-btn">${icons.rooms} 我的申请</button>'}
        </div>
      </aside>
      <section class="chat-column">
        <header class="chat-header">
          <div class="chat-header-inner">
            <div class="chat-header-left">
              <button class="btn btn--ghost btn--sm rooms-burger" type="button" data-role="rooms-burger" title="展开房间列表" aria-label="展开房间列表">${icons.menu}</button>
              <div class="chat-title"><span style="color:var(--accent)">${icons.rooms}</span><span class="chat-room-name" data-role="room-title">加载中…</span></div>
              <span class="status-dot status-dot--connecting" data-role="status-dot"></span>
              <span class="chat-conn" data-role="status-text">连接中…</span>
              <span class="chat-online" data-role="online-text"></span>
            </div>
            <div class="chat-header-right">
              <span class="identity-chip">
                <span data-role="self-avatar"></span>
                <strong data-role="self-alias"></strong>
              </span>
              <span class="badge" data-role="rewrite-badge" hidden></span>
              <span class="badge badge--safe" title="消息以 AES-256-GCM 密文存储"><span class="badge-icon">${icons.lock}</span><span class="badge-text">密文存储</span></span>
              <div class="header-menu-wrap" data-role="menu-wrap">
                <button class="btn btn--ghost btn--sm" data-role="menu-btn" type="button" title="设置" aria-label="打开设置" aria-haspopup="menu" aria-expanded="false">
                  ${icons.settings}
                </button>
                <div class="header-menu" data-role="header-menu" role="menu" hidden>
                  <button type="button" role="menuitem" class="header-menu-item" data-role="menu-room-settings">房间设置</button>
                  ${identity.isAdmin ? '<button type="button" role="menuitem" class="header-menu-item" data-role="menu-admin">管理后台</button>' : ''}
                </div>
              </div>
              <button class="btn btn--ghost btn--sm" data-role="logout-btn" type="button" title="退出登录" aria-label="退出登录">${icons.logout}</button>
            </div>
          </div>
        </header>
        <main class="messages" data-role="messages">
          <div class="msg-empty">
            <span class="msg-empty-icon">${icons.rooms}</span>
            <div class="msg-empty-title">还没有回音</div>
            <div class="msg-empty-sub">写下你观察到的问题、想提的建议——系统用随机匿名身份代你发声，语气经归一化处理，无法从文字风格反推个人。</div>
          </div>
        </main>
        <footer class="composer">
          <div class="composer-inner">
            <div class="composer-box">
              <form class="composer-row" data-role="composer-form">
                <textarea data-role="input" rows="1" maxlength="2000"
                  placeholder="说点什么…… 发送前系统将抹除口头禅、标点与句式习惯"></textarea>
                <button class="btn btn--send" type="submit" data-role="send-btn" aria-label="发送" title="发送">
                  ${icons.send}
                </button>
              </form>
              <div class="composer-hint">
                <span data-role="rewrite-hint"></span>
                <span class="composer-keys">Enter 发送 · Shift+Enter 换行</span>
                <span class="composer-count"><span data-role="char-count">0</span>/2000</span>
              </div>
            </div>
          </div>
        </footer>
      </section>
    </div>
    <div class="rooms-mask" data-role="rooms-mask" hidden></div>
  `;

  const messagesEl = shell.querySelector<HTMLElement>('[data-role="messages"]')!;
  const inputEl = shell.querySelector<HTMLTextAreaElement>('[data-role="input"]')!;
  const formEl = shell.querySelector<HTMLFormElement>('[data-role="composer-form"]')!;
  const sendBtn = shell.querySelector<HTMLButtonElement>('[data-role="send-btn"]')!;
  const statusDot = shell.querySelector<HTMLElement>('[data-role="status-dot"]')!;
  const statusText = shell.querySelector<HTMLElement>('[data-role="status-text"]')!;
  const onlineText = shell.querySelector<HTMLElement>('[data-role="online-text"]')!;
  const connBar = shell.querySelector<HTMLElement>('[data-role="conn-bar"]')!;
  const charCount = shell.querySelector<HTMLElement>('[data-role="char-count"]')!;
  const rewriteBadge = shell.querySelector<HTMLElement>('[data-role="rewrite-badge"]')!;
  const rewriteHint = shell.querySelector<HTMLElement>('[data-role="rewrite-hint"]')!;
  const roomTitle = shell.querySelector<HTMLElement>('[data-role="room-title"]')!;
  const roomsList = shell.querySelector<HTMLElement>('[data-role="rooms-list"]')!;
  const roomsPane = shell.querySelector<HTMLElement>('[data-role="rooms-pane"]')!;
  const roomsMask = shell.querySelector<HTMLElement>('[data-role="rooms-mask"]')!;
  const roomsBurger = shell.querySelector<HTMLButtonElement>('[data-role="rooms-burger"]')!;
  const refreshBtn = shell.querySelector<HTMLButtonElement>('[data-role="rooms-refresh"]')!;
  const newRoomBtn = shell.querySelector<HTMLButtonElement>('[data-role="new-room-btn"]')!;
  const myRequestsBtn = shell.querySelector<HTMLButtonElement>('[data-role="my-requests-btn"]');
  const menuWrap = shell.querySelector<HTMLDivElement>('[data-role="menu-wrap"]')!;
  const menuBtn = shell.querySelector<HTMLButtonElement>('[data-role="menu-btn"]')!;
  const headerMenu = shell.querySelector<HTMLElement>('[data-role="header-menu"]')!;
  const menuRoomSettings = shell.querySelector<HTMLButtonElement>('[data-role="menu-room-settings"]')!;
  const menuAdmin = shell.querySelector<HTMLButtonElement>('[data-role="menu-admin"]');

  const selfAvatar = shell.querySelector<HTMLElement>('[data-role="self-avatar"]')!;
  selfAvatar.appendChild(svg(avatarSvg(identity.visual, 24)));
  shell.querySelector<HTMLElement>('[data-role="self-alias"]')!.textContent = identity.alias;

  // ---- 多房间状态 ----
  let rooms: Room[] = [];
  const roomNames = new Map<string, string>();
  /** 已确认加入的房间（后端 room:joined 后更新） */
  let currentRoomId: string | null = null;
  /** 正在切换的目标房间（joined 到达前为乐观高亮/回退依据） */
  let targetRoomId: string | null = null;
  /** 切换前所在房间，用于失败回退 */
  let previousRoomId: string | null = null;
  let switching = false;
  let historySeq = 0;
  const unread = new Map<string, number>();
  const seenIds = new Set<string>();
  const pending = new Map<string, PendingMarker>();
  let rewriteEnabled = false;

  // ---- 抽屉（<768px） ----
  function openDrawer(): void {
    roomsPane.classList.add('rooms-pane--open');
    roomsMask.hidden = false;
  }
  function closeDrawer(): void {
    roomsPane.classList.remove('rooms-pane--open');
    roomsMask.hidden = true;
  }
  roomsBurger.addEventListener('click', () => {
    if (roomsPane.classList.contains('rooms-pane--open')) closeDrawer();
    else openDrawer();
  });
  roomsMask.addEventListener('click', closeDrawer);

  function headerTitle(title: string): void {
    roomTitle.textContent = title;
  }

  function roomIdToName(roomId: string): string {
    return roomNames.get(roomId) ?? rooms.find((r) => r.id === roomId)?.name ?? '房间';
  }

  function onlineTextOf(online: number): void {
    onlineText.textContent = online > 0 ? `${online} 人在线` : '';
  }

  /** 齿轮菜单可见性：进入房间后，管理员看到「房间设置 + 管理后台」；非管理员仅自己当房主时看到「房间设置」 */
  function updateSettingsVisibility(): void {
    if (!menuWrap) return;
    const room = currentRoomId ? rooms.find((r) => r.id === currentRoomId) ?? null : null;
    const canRoomSettings = identity.isAdmin || (room !== null && room.isOwner);
    // 房间设置项：房主或管理员可见；管理后台项：仅管理员。二者皆不可见时整个齿轮隐藏
    menuRoomSettings.style.display = canRoomSettings ? '' : 'none';
    menuWrap.style.display = identity.isAdmin || canRoomSettings ? '' : 'none';
  }

  /** 房间操作弹层的联动回调 */
  function panelConnector(): RoomPanelConnector {
    return {
      isAdmin: identity.isAdmin,
      rooms: () => rooms,
      refreshRooms: () => loadRooms(),
      switchRoom: (roomId) => switchRoom(roomId),
      currentRoomId: () => currentRoomId,
    };
  }

  // ---- 消息渲染 ----
  function appendMessage(message: ChatMessage, opts: { pending?: boolean; nonce?: string } = {}): void {
    if (seenIds.has(message.id)) return;
    seenIds.add(message.id);
    messagesEl.querySelector('.msg-empty')?.remove();
    messagesEl.querySelector('.msg-loading')?.remove();

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

  function clearMessageArea(): void {
    messagesEl.replaceChildren();
  }

  function showLoadingState(): void {
    clearMessageArea();
    const loading = el('div', 'msg-loading', '加载中…');
    messagesEl.appendChild(loading);
  }

  function showEmptyState(): void {
    clearMessageArea();
    const empty = el('div', 'msg-empty');
    const icon = el('span', 'msg-empty-icon');
    icon.appendChild(svg(icons.rooms));
    empty.appendChild(icon);
    empty.appendChild(el('div', 'msg-empty-title', '还没有回音'));
    empty.appendChild(
      el(
        'div',
        'msg-empty-sub',
        '写下你观察到的问题、想提的建议——系统用随机匿名身份代你发声，语气经归一化处理，无法从文字风格反推个人。',
      ),
    );
    messagesEl.appendChild(empty);
  }

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

  // ---- 房间列表 ----
  function renderRooms(): void {
    roomsList.replaceChildren();
    const activeId = targetRoomId ?? currentRoomId;
    for (const room of rooms) {
      roomNames.set(room.id, room.name);
      const item = el('button', 'rooms-item');
      item.type = 'button';
      item.dataset.roomId = room.id;
      if (room.id === activeId) item.classList.add('rooms-item--active');

      const icon = el('span', 'rooms-item-icon');
      icon.appendChild(svg(room.type === 'private' ? icons.lock : icons.globe));
      item.appendChild(icon);
      item.appendChild(el('span', 'rooms-item-name', room.name));

      const badge = el('span', 'rooms-item-unread');
      const count = unread.get(room.id) ?? 0;
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.hidden = count === 0;
      item.appendChild(badge);

      item.addEventListener('click', () => {
        closeDrawer();
        switchRoom(room.id);
      });
      roomsList.appendChild(item);
    }
    // 列表晚于 auth:ok 返回时，把 header 标题从占位态补齐为当前房间名
    if (currentRoomId && roomTitle.textContent === '加载中…') {
      headerTitle(roomIdToName(currentRoomId));
    }
    updateSettingsVisibility();
  }

  function updateRoomUnread(roomId: string): void {
    const item = roomsList.querySelector<HTMLElement>(`[data-room-id="${roomId}"]`);
    if (!item) return;
    const badge = item.querySelector<HTMLElement>('.rooms-item-unread');
    if (!badge) return;
    const count = unread.get(roomId) ?? 0;
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.hidden = count === 0;
  }

  async function loadRooms(): Promise<void> {
    try {
      const data = await api.listRooms();
      rooms = data.rooms.filter((room) => room.archivedAt === null);
      renderRooms();
      // 改名/刷新后同步 header 标题（房间名可能已变化）
      if (currentRoomId) headerTitle(roomIdToName(currentRoomId));
    } catch (err) {
      toast(err instanceof Error ? err.message : '房间列表加载失败', 'error');
    }
  }

  // ---- 历史消息 ----
  function loadHistory(roomId: string): void {
    const seq = ++historySeq;
    showLoadingState();
    api
      .history(roomId, undefined, 50)
      .then((data) => {
        if (seq !== historySeq) return;
        rewriteEnabled = data.rewriteEnabled;
        renderRewriteState();
        seenIds.clear();
        clearMessageArea();
        const sorted = [...data.messages].sort((a, b) => a.createdAt - b.createdAt);
        for (const message of sorted) appendMessage(message);
        if (sorted.length === 0) showEmptyState();
      })
      .catch((err) => {
        if (seq !== historySeq) return;
        showEmptyState();
        toast(err instanceof Error ? err.message : '历史消息加载失败', 'error');
      });
  }

  // ---- 切房 ----
  function switchRoom(roomId: string): void {
    if (!roomId) return;
    if (switching) return;
    if (roomId === currentRoomId) return;
    switching = true;
    targetRoomId = roomId;
    previousRoomId = currentRoomId;
    // 乐观 UI：立即清空消息区并显示加载、高亮目标房间
    showLoadingState();
    renderRooms();
    headerTitle(roomIdToName(roomId));
    onlineTextOf(0);
    // 后端协议：先离开旧房（自动回大厅）→ 再加入新房
    if (currentRoomId) ws.leave();
    ws.join(roomId);
  }

  function fallbackToPrevious(): void {
    switching = false;
    targetRoomId = null;
    if (previousRoomId) {
      // 重新加入原房间，room:joined 会带回历史
      ws.join(previousRoomId);
    } else if (currentRoomId) {
      renderRooms();
      loadHistory(currentRoomId);
    } else {
      renderRooms();
      showEmptyState();
    }
  }

  // ---- WebSocket ----
  const ws = createWsClient({
    path: '/ws/chat',
    getToken: () => sessionToken.get(),
    onStateChange: (state: ConnectionState) => {
      statusDot.className = `status-dot status-dot--${state}`;
      connBar.className = `conn-bar conn-bar--${state}`;
      statusText.textContent = state === 'online' ? '已连接' : state === 'connecting' ? '连接中…' : '已断开';
    },
    onReady: ({ rewriteEnabled: enabled, roomId }) => {
      rewriteEnabled = enabled;
      renderRewriteState();
      if (roomId) {
        currentRoomId = roomId;
        headerTitle(roomIdToName(roomId));
        renderRooms();
        loadHistory(roomId);
      }
    },
    onPresence: (online, roomId) => {
      // 只展示当前房间的在线人数
      if (!roomId || roomId === currentRoomId) onlineTextOf(online);
    },
    onRoomJoined: (info) => {
      currentRoomId = info.roomId;
      targetRoomId = null;
      previousRoomId = null;
      switching = false;
      roomNames.set(info.roomId, info.name);
      // 进入即视为已读
      unread.delete(info.roomId);
      headerTitle(info.name);
      onlineTextOf(info.online);
      clearMessageArea();
      renderRooms();
      updateSettingsVisibility();
      loadHistory(info.roomId);
    },
    onRoomLeft: () => {
      // 切房流程中的中间帧（离开旧房回到大厅），以 room:joined 为准；非切房时忽略
    },
    onChatMessage: (message) => {
      // 按房间过滤：非当前房间的消息只累计未读，不渲染
      if (message.roomId && message.roomId !== currentRoomId) {
        const roomId = message.roomId;
        unread.set(roomId, (unread.get(roomId) ?? 0) + 1);
        updateRoomUnread(roomId);
        return;
      }
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
      // 切房被拒 / 发送时未加入目标房间：回退到原房间
      if (switching && (code === 'room_forbidden' || code === 'not_joined' || code === 'bad_room')) {
        toast(message, 'error');
        fallbackToPrevious();
        return;
      }
      toast(message, 'error');
      if (code === 'unauthorized' || message.includes('保险库')) {
        window.setTimeout(() => onLogout(), 1500);
      }
    },
  });

  // ---- 初始加载：房间列表 + WS（完成后列表高亮，auth:ok 后拉大厅历史） ----
  void loadRooms();
  refreshBtn.addEventListener('click', () => void loadRooms());

  // ---- 建房 / 申请 / 房主设置 ----
  newRoomBtn.addEventListener('click', () => openCreateRoomPanel(panelConnector()));
  myRequestsBtn?.addEventListener('click', () => openMyRequestsPanel(panelConnector()));

  // 齿轮下拉：合并「房间设置」「管理后台」两个入口
  function setMenuOpen(open: boolean): void {
    headerMenu.hidden = !open;
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  menuBtn.addEventListener('click', (event: MouseEvent) => {
    event.stopPropagation();
    setMenuOpen(headerMenu.hidden);
  });
  document.addEventListener('click', (event: MouseEvent) => {
    if (headerMenu.hidden) return;
    if (!menuWrap.contains(event.target as Node)) {
      setMenuOpen(false);
    }
  });
  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !headerMenu.hidden) setMenuOpen(false);
  });
  menuRoomSettings.addEventListener('click', () => {
    setMenuOpen(false);
    const room = currentRoomId ? rooms.find((r) => r.id === currentRoomId) ?? null : null;
    if (!room) return;
    openRoomSettingsPanel(room, panelConnector());
  });
  menuAdmin?.addEventListener('click', () => {
    setMenuOpen(false);
    openAdminPanel(() => {
      /* 解封后溯源接口立即可用，无需额外刷新页面 */
    });
  });

  // ---- 输入 ----
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 140)}px`;
    charCount.textContent = String(inputEl.value.length);
  });

  formEl.addEventListener('submit', (event: SubmitEvent) => {
    event.preventDefault();
    if (switching) {
      toast('房间切换中，请稍候', 'info');
      return;
    }
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

  return shell;
}