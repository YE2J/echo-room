// ABOUTME: 房间操作弹层：新建房间（管理员直建）、建房申请（普通用户）、
// 我的申请列表、房主设置（改名/简介/私密房成员管理）。
// 安全约定：所有用户/服务端数据一律 textContent 渲染；仅开发者静态 SVG 走 innerHTML。

import { api, type Room, type RoomRequest } from '../api';
import { alertBox, el, icons, svg, toast } from '../components';

/** chat.ts 注入的联动能力（避免循环依赖，接口由 chat 页实现） */
export interface RoomPanelConnector {
  isAdmin: boolean;
  /** 当前可见房间列表（用于读取当前房间信息 / 找申请通过的房间） */
  rooms: () => Room[];
  refreshRooms: () => Promise<void>;
  switchRoom: (roomId: string) => void;
  currentRoomId: () => string | null;
}

function createModal(title: string, iconSvg: string): { backdrop: HTMLElement; body: HTMLElement; close: () => void } {
  const backdrop = el('div', 'modal-backdrop');
  const modal = el('div', 'modal');
  backdrop.appendChild(modal);
  const closeBtn = el('button', 'modal-close', '×');
  closeBtn.title = '关闭';
  closeBtn.setAttribute('aria-label', '关闭');
  modal.appendChild(closeBtn);
  const head = el('h2');
  head.appendChild(svg(iconSvg));
  head.appendChild(document.createTextNode(` ${title}`));
  modal.appendChild(head);
  const body = el('div');
  modal.appendChild(body);
  const close = (): void => backdrop.remove();
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (event: MouseEvent) => {
    if (event.target === backdrop) close();
  });
  document.body.appendChild(backdrop);
  return { backdrop, body, close };
}

function inputField(labelText: string): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = el('div', 'field');
  wrap.appendChild(el('label', '', labelText));
  const input = el('input', 'input');
  wrap.appendChild(input);
  return { wrap, input };
}

function textareaField(labelText: string): { wrap: HTMLElement; input: HTMLTextAreaElement } {
  const wrap = el('div', 'field');
  wrap.appendChild(el('label', '', labelText));
  const input = el('textarea', 'input');
  input.rows = 2;
  wrap.appendChild(input);
  return { wrap, input };
}

function typeSwitcher(initial: 'public' | 'private'): { wrap: HTMLElement; value: () => 'public' | 'private' } {
  const wrap = el('div', 'field');
  wrap.appendChild(el('label', '', '可见范围'));
  const row = el('div', 'rp-type-row');
  let current: 'public' | 'private' = initial;
  const make = (val: 'public' | 'private', labelText: string): void => {
    const btn = el('button', 'btn btn--sm rp-type-btn', labelText);
    btn.type = 'button';
    if (val === current) btn.classList.add('rp-type-btn--active');
    btn.addEventListener('click', () => {
      current = val;
      row.querySelectorAll('.rp-type-btn').forEach((node) => node.classList.remove('rp-type-btn--active'));
      btn.classList.add('rp-type-btn--active');
    });
    row.appendChild(btn);
  };
  make('public', '公开 · 全员可见');
  make('private', '私密 · 仅成员');
  wrap.appendChild(row);
  return { wrap, value: () => current };
}

function requestBadge(status: RoomRequest['status']): HTMLElement {
  const cls = status === 'pending' ? 'badge--warn' : status === 'approved' ? 'badge--safe' : '';
  const text = status === 'pending' ? '待审批' : status === 'approved' ? '已通过' : '已拒绝';
  return el('span', `badge ${cls}`.trim(), text);
}

// ---------------------------------------------------------------------------
// 新建房间（管理员直建）/ 建房申请（普通用户）
// ---------------------------------------------------------------------------
export function openCreateRoomPanel(connector: RoomPanelConnector): void {
  const { body, close } = createModal(connector.isAdmin ? '新建房间' : '申请建房', icons.rooms);
  const sub = el('p', 'sub');
  sub.textContent = connector.isAdmin
    ? '直接创建房间，创建后按可见范围全员可见或仅成员进入。'
    : '提交申请后由管理员审批；通过后你会成为该房间的房主。';
  body.appendChild(sub);

  const nameField = inputField('房间名（1-32 字）');
  nameField.input.maxLength = 32;
  body.appendChild(nameField.wrap);
  const descField = textareaField('简介 / 申请理由（选填，200 字内）');
  descField.input.maxLength = 200;
  body.appendChild(descField.wrap);
  const type = typeSwitcher('public');
  body.appendChild(type.wrap);

  const errBox = el('div');
  body.appendChild(errBox);
  const submitBtn = el('button', 'btn btn--block', connector.isAdmin ? '创建房间' : '提交申请');
  body.appendChild(submitBtn);

  submitBtn.addEventListener('click', () => {
    errBox.replaceChildren();
    const name = nameField.input.value.trim();
    if (!name) {
      errBox.appendChild(alertBox('error', '请填写房间名'));
      return;
    }
    const description = descField.input.value.trim() || undefined;
    submitBtn.disabled = true;
    void (async () => {
      try {
        if (connector.isAdmin) {
          const { room } = await api.adminCreateRoom({ name, type: type.value(), description });
          toast('房间已创建', 'ok');
          close();
          await connector.refreshRooms();
          connector.switchRoom(room.id);
        } else {
          await api.createRoomRequest({ name, type: type.value(), description });
          toast('已提交，等待管理员审批', 'ok');
          close();
        }
      } catch (err) {
        errBox.appendChild(alertBox('error', err instanceof Error ? err.message : '操作失败'));
      } finally {
        submitBtn.disabled = false;
      }
    })();
  });
}

// ---------------------------------------------------------------------------
// 我的建房申请（普通用户）
// ---------------------------------------------------------------------------
export function openMyRequestsPanel(connector: RoomPanelConnector): void {
  const { body, close } = createModal('我的建房申请', icons.rooms);
  const box = el('div', '', '加载中…');
  body.appendChild(box);

  void (async () => {
    try {
      const { requests } = await api.myRoomRequests();
      box.replaceChildren();
      if (requests.length === 0) {
        box.appendChild(el('div', 'muted', '还没有提交过建房申请'));
        return;
      }
      requests.forEach((request) => {
        const row = el('div', 'rp-request-row');
        const head = el('div', 'rp-request-head');
        head.appendChild(svg(request.type === 'private' ? icons.lock : icons.globe));
        head.appendChild(el('span', 'rp-request-name', request.name));
        head.appendChild(requestBadge(request.status));
        row.appendChild(head);
        if (request.description) row.appendChild(el('div', 'muted rp-request-desc', request.description));
        const meta = el('div', 'rp-request-meta');
        meta.appendChild(el('span', '', `提交于 ${new Date(request.createdAt).toLocaleString()}`));
        if (request.status === 'rejected' && request.rejectReason) {
          meta.appendChild(el('span', 'rp-request-reason', `拒绝原因：${request.rejectReason}`));
        }
        if (request.status === 'approved') {
          const enterBtn = el('button', 'btn btn--sm', '进入房间');
          enterBtn.type = 'button';
          enterBtn.addEventListener('click', () => {
            const room = connector.rooms().find((r) => r.name === request.name);
            if (!room) {
              toast('房间不存在或已被归档', 'error');
              return;
            }
            close();
            connector.switchRoom(room.id);
          });
          meta.appendChild(enterBtn);
        }
        row.appendChild(meta);
        box.appendChild(row);
      });
    } catch (err) {
      box.replaceChildren(el('span', 'muted', err instanceof Error ? err.message : '加载失败'));
    }
  })();
}

// ---------------------------------------------------------------------------
// 房间设置（当前房间的房主 / 管理员）
// ---------------------------------------------------------------------------
export function openRoomSettingsPanel(room: Room, connector: RoomPanelConnector): void {
  const { body, close } = createModal('房间设置', icons.settings);
  body.appendChild(el('p', 'sub', room.type === 'private' ? '私密房间 · 仅成员可见' : '公开房间 · 全员可见'));

  const errBox = el('div');
  body.appendChild(errBox);

  const nameField = inputField('房间名（1-32 字）');
  nameField.input.maxLength = 32;
  nameField.input.value = room.name;
  body.appendChild(nameField.wrap);
  const descField = textareaField('简介（200 字内，留空即清空）');
  descField.input.maxLength = 200;
  descField.input.value = room.description ?? '';
  body.appendChild(descField.wrap);

  const saveBtn = el('button', 'btn btn--sm', '保存');
  body.appendChild(saveBtn);

  saveBtn.addEventListener('click', () => {
    errBox.replaceChildren();
    const name = nameField.input.value.trim();
    if (!name) {
      errBox.appendChild(alertBox('error', '请填写房间名'));
      return;
    }
    saveBtn.disabled = true;
    void (async () => {
      try {
        await api.renameRoom(room.id, name, descField.input.value.trim());
        toast('已保存，列表与标题已同步', 'ok');
        close();
        await connector.refreshRooms();
      } catch (err) {
        errBox.appendChild(alertBox('error', err instanceof Error ? err.message : '保存失败'));
      } finally {
        saveBtn.disabled = false;
      }
    })();
  });

  // 私密房间：成员管理
  if (room.type === 'private') {
    const title = el('div', 'muted');
    title.style.margin = '16px 0 6px';
    title.textContent = '成员管理（按用户名添加 / 移除）';
    body.appendChild(title);

    const memberBox = el('div', '', '加载中…');
    body.appendChild(memberBox);

    const addRow = el('div', 'rp-member-add');
    const addInput = el('input', 'input');
    addInput.placeholder = '输入用户名添加成员';
    const addBtn = el('button', 'btn btn--sm', '添加');
    addRow.append(addInput, addBtn);
    body.appendChild(addRow);

    async function loadMembers(): Promise<void> {
      try {
        const { members } = await api.listRoomMembers(room.id);
        memberBox.replaceChildren();
        if (members.length === 0) {
          memberBox.appendChild(el('div', 'muted', '暂无成员'));
          return;
        }
        members.forEach((member) => {
          const row = el('div', 'rp-member-row');
          row.appendChild(el('span', 'rp-member-name', member.username));
          if (member.role === 'owner') {
            row.appendChild(badgeEl('房主'));
          } else {
            const removeBtn = el('button', 'btn btn--danger btn--sm', '移除');
            removeBtn.type = 'button';
            removeBtn.addEventListener('click', () => {
              removeBtn.disabled = true;
              void (async () => {
                try {
                  await api.removeRoomMember(room.id, member.username);
                  toast(`已移除 ${member.username}`, 'ok');
                  await loadMembers();
                } catch (err) {
                  toast(err instanceof Error ? err.message : '移除失败', 'error');
                  removeBtn.disabled = false;
                }
              })();
            });
            row.appendChild(removeBtn);
          }
          memberBox.appendChild(row);
        });
      } catch (err) {
        memberBox.replaceChildren(el('span', 'muted', err instanceof Error ? err.message : '加载失败'));
      }
    }

    function badgeEl(text: string): HTMLElement {
      return el('span', 'badge', text);
    }

    addBtn.addEventListener('click', () => {
      const username = addInput.value.trim();
      if (!username) return;
      addBtn.disabled = true;
      void (async () => {
        try {
          await api.addRoomMember(room.id, username);
          toast(`已添加 ${username}`, 'ok');
          addInput.value = '';
          await loadMembers();
        } catch (err) {
          toast(err instanceof Error ? err.message : '添加失败', 'error');
        } finally {
          addBtn.disabled = false;
        }
      })();
    });
    addInput.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        addBtn.click();
      }
    });

    void loadMembers();
  } else {
    const note = el('div', 'rp-member-note');
    note.appendChild(svg(icons.globe));
    note.appendChild(document.createTextNode(' 公开房间无需成员管理，所有人可见可进。'));
    body.appendChild(note);
  }
}