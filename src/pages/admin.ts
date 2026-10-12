// ABOUTME: 管理员面板（弹层）：保险库状态/解封/封存、邀请码、改写开关、
// 受控溯源（门限分片）、审计。所有用户/服务端数据一律 textContent，严禁 innerHTML 拼接。

import { api, ApiError } from '../api';
import { el, icons, svg, toast } from '../components';

function h3(titleIcon: string, text: string): HTMLElement {
  const head = el('h3');
  head.appendChild(svg(titleIcon));
  head.appendChild(document.createTextNode(' ' + text));
  return head;
}

function badge(text: string, extraClass = ''): HTMLElement {
  return el('span', `badge ${extraClass}`.trim(), text);
}

export function openAdminPanel(onUnsealed: () => void): void {
  const backdrop = el('div', 'modal-backdrop');
  const modal = el('div', 'modal');
  backdrop.appendChild(modal);

  const closeBtn = el('button', 'modal-close', '×');
  closeBtn.setAttribute('aria-label', '关闭');
  modal.appendChild(closeBtn);

  const title = el('h2');
  title.appendChild(svg(icons.lock));
  title.appendChild(document.createTextNode(' 安全管理台'));
  modal.appendChild(title);
  modal.appendChild(el('p', 'sub', '所有操作均写入审计日志。解封保险库与受控溯源都需满足门限的密钥分片数。'));

  const errorBox = el('div', 'admin-error-slot');
  modal.appendChild(errorBox);
  const showError = (message: string): void => {
    errorBox.replaceChildren(el('div', 'alert alert--error', message));
  };
  const clearError = (): void => errorBox.replaceChildren();

  // ---- 保险库 ----
  const vaultSection = el('section', 'admin-section');
  vaultSection.appendChild(h3(icons.key, '身份保险库'));
  const vaultBody = el('div', '', '加载中…');
  vaultSection.appendChild(vaultBody);
  modal.appendChild(vaultSection);

  async function renderVault(): Promise<void> {
    vaultBody.replaceChildren(el('span', '', '加载中…'));
    try {
      const status = await api.vaultStatus();
      vaultBody.replaceChildren();

      if (status.state === 'uninitialized') {
        const info = el('div', 'alert alert--info');
        info.appendChild(document.createTextNode('保险库尚未初始化。请在服务器执行 '));
        info.appendChild(el('code', '', 'pnpm vault:init'));
        info.appendChild(document.createTextNode(' 生成主密钥分片，并妥善分发给 K 名托管人。'));
        vaultBody.appendChild(info);
        return;
      }

      const unsealed = status.state === 'unsealed';
      const badges = el('div', 'vault-badges');
      badges.appendChild(badge(unsealed ? '已解封 UNSEALED' : '已封存 SEALED', unsealed ? 'badge--safe' : 'badge--warn'));
      badges.appendChild(badge(`门限 ${status.k} / ${status.n}`));
      vaultBody.appendChild(badges);

      if (!unsealed) {
        const form = el('div', 'vault-unseal-form');
        const field = el('div', 'field');
        field.appendChild(el('label', '', `粘贴分片（每行一个，至少 ${status.k} 片，格式如 1-XXXX）`));
        const sharesInput = el('textarea', 'input');
        sharesInput.rows = status.k;
        sharesInput.placeholder = '1-abcd...\n3-ef01...';
        field.appendChild(sharesInput);
        form.appendChild(field);
        const unsealBtn = el('button', 'btn btn--sm', '解封保险库');
        form.appendChild(unsealBtn);
        vaultBody.appendChild(form);

        unsealBtn.addEventListener('click', async () => {
          clearError();
          const shares = sharesInput.value.split('\n').map((s) => s.trim()).filter(Boolean);
          if (shares.length < status.k) {
            showError(`至少需要 ${status.k} 个分片`);
            return;
          }
          unsealBtn.disabled = true;
          try {
            await api.unseal(shares);
            toast('保险库已解封', 'ok');
            onUnsealed();
            await renderVault();
          } catch (err) {
            showError(err instanceof ApiError ? err.message : '解封失败');
          } finally {
            unsealBtn.disabled = false;
          }
        });
      } else {
        const actions = el('div', 'vault-actions');
        const sealBtn = el('button', 'btn btn--ghost btn--sm', '立即封存（擦除内存主密钥）');
        actions.appendChild(sealBtn);
        vaultBody.appendChild(actions);
        sealBtn.addEventListener('click', async () => {
          clearError();
          try {
            await api.seal();
            toast('保险库已封存', 'ok');
            await renderVault();
          } catch (err) {
            showError(err instanceof ApiError ? err.message : '封存失败');
          }
        });
      }
    } catch (err) {
      vaultBody.replaceChildren(el('span', '', err instanceof ApiError ? err.message : '加载失败'));
    }
  }
  void renderVault();

  // ---- 邀请码 ----
  const inviteSection = el('section', 'admin-section');
  inviteSection.appendChild(h3(icons.key, '邀请码'));
  const invRow = el('div', 'invite-row');
  const codeInput = el('input', 'input');
  codeInput.placeholder = '留空自动生成';
  const usesInput = el('input', 'input') as HTMLInputElement;
  usesInput.type = 'number';
  usesInput.min = '1';
  usesInput.max = '100';
  usesInput.value = '1';
  usesInput.title = '可用次数';
  usesInput.classList.add('invite-uses');
  const invCreateBtn = el('button', 'btn btn--sm', '生成');
  invRow.append(codeInput, usesInput, invCreateBtn);
  inviteSection.appendChild(invRow);
  const invList = el('div', '', '加载中…');
  inviteSection.appendChild(invList);
  modal.appendChild(inviteSection);

  async function renderInvites(): Promise<void> {
    invList.replaceChildren(el('span', '', '加载中…'));
    try {
      const data = await api.listInvites();
      invList.replaceChildren();
      if (data.invites.length === 0) {
        invList.appendChild(el('div', 'muted', '暂无邀请码'));
        return;
      }
      const table = el('table', 'data-table');
      const thead = el('thead');
      const hr = el('tr');
      ['邀请码', '用量', '有效期'].forEach((t) => hr.appendChild(el('th', '', t)));
      thead.appendChild(hr);
      table.appendChild(thead);
      const tbody = el('tbody');
      data.invites.forEach((row) => {
        const tr = el('tr');
        const tdCode = el('td');
        tdCode.appendChild(el('code', '', row.code));
        tr.appendChild(tdCode);
        tr.appendChild(el('td', '', `${row.usedCount}/${row.maxUses === 0 ? '∞' : row.maxUses}`));
        tr.appendChild(
          el('td', '', row.expiresAt ? new Date(row.expiresAt * 1000).toLocaleDateString() : '长期'),
        );
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      invList.appendChild(table);
    } catch {
      invList.replaceChildren(el('span', '', '加载失败'));
    }
  }
  void renderInvites();

  invCreateBtn.addEventListener('click', async () => {
    clearError();
    const code = codeInput.value.trim();
    const maxUses = Number(usesInput.value) || 1;
    try {
      const created = await api.createInvite({ code: code || undefined, maxUses });
      toast(`邀请码 ${(created as { code: string }).code} 已生成`, 'ok');
      codeInput.value = '';
      await renderInvites();
    } catch (err) {
      showError(err instanceof ApiError ? err.message : '生成失败');
    }
  });

  // ---- 改写开关 ----
  const rewriteSection = el('section', 'admin-section');
  rewriteSection.appendChild(h3(icons.shield, '语气归一化（LLM 改写）'));
  const rewriteBody = el('div', 'rewrite-row', '加载中…');
  rewriteSection.appendChild(rewriteBody);
  modal.appendChild(rewriteSection);

  async function renderRewrite(): Promise<void> {
    rewriteBody.replaceChildren();
    try {
      const data = await api.getRewrite();
      rewriteBody.appendChild(
        badge(data.effectiveEnabled ? '当前：已启用' : '当前：已关闭', data.effectiveEnabled ? 'badge--safe' : ''),
      );
      rewriteBody.appendChild(badge(`mode: ${data.mode}`));
      rewriteBody.appendChild(badge(`provider: ${data.provider}`, !data.hasProvider ? 'badge--warn' : ''));
      if (!data.hasProvider) {
        rewriteBody.appendChild(badge('未配置 LLM，使用本地规则兜底', 'badge--warn'));
      }
      const toggleBtn = el('button', 'btn btn--sm', data.effectiveEnabled ? '关闭改写' : '开启改写');
      rewriteBody.appendChild(toggleBtn);
      toggleBtn.addEventListener('click', async () => {
        clearError();
        toggleBtn.disabled = true;
        try {
          await api.setRewrite(!data.effectiveEnabled);
          await renderRewrite();
        } catch (err) {
          showError(err instanceof ApiError ? err.message : '切换失败');
        } finally {
          toggleBtn.disabled = false;
        }
      });
    } catch {
      rewriteBody.replaceChildren(el('span', '', '加载失败'));
    }
  }
  void renderRewrite();

  // ---- 受控溯源 ----
  const revealSection = el('section', 'admin-section');
  revealSection.appendChild(h3(icons.key, '受控溯源（需 K 份分片，审计留痕）'));
  const rvAlias = el('input', 'input');
  rvAlias.placeholder = '匿名昵称，如 雾中的鹅卵石-2CCF';
  const rvReason = el('input', 'input');
  rvReason.placeholder = '溯源事由（必填，写入审计）';
  const rvShares = el('textarea', 'input');
  rvShares.rows = 2;
  rvShares.placeholder = '粘贴 K 份密钥分片（每行一个）——平时无法溯源，凑齐门限方可还原身份';
  const rvRow1 = el('div', 'invite-row');
  rvRow1.append(rvAlias, rvReason);
  const rvBtn = el('button', 'btn btn--sm', '溯源');
  const rvBtnRow = el('div', 'vault-actions');
  rvBtnRow.appendChild(rvBtn);
  const rvResult = el('div', 'reveal-result');
  revealSection.append(rvRow1, rvShares, rvBtnRow, rvResult);
  modal.appendChild(revealSection);

  rvBtn.addEventListener('click', async () => {
    clearError();
    rvResult.replaceChildren();
    const alias = rvAlias.value.trim();
    const reason = rvReason.value.trim();
    const shares = rvShares.value.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!alias) {
      showError('请填写匿名昵称');
      return;
    }
    if (reason.length < 2) {
      showError('请填写溯源事由');
      return;
    }
    if (shares.length === 0) {
      showError('受控溯源必须粘贴至少 K 份密钥分片');
      return;
    }
    rvBtn.disabled = true;
    try {
      const result = await api.reveal(alias, reason, shares);
      const box = el('div', 'alert alert--ok');
      box.appendChild(document.createTextNode('溯源命中：真实账号 '));
      box.appendChild(el('code', '', result.username));
      box.appendChild(document.createTextNode(`（userId: ${result.userId}）。本次操作已写入审计。`));
      rvResult.appendChild(box);
    } catch (err) {
      rvResult.appendChild(
        el('div', 'alert alert--error', err instanceof ApiError ? err.message : '溯源失败'),
      );
    } finally {
      rvBtn.disabled = false;
    }
  });

  // ---- 审计 ----
  const auditSection = el('section', 'admin-section');
  auditSection.appendChild(h3(icons.bell, '审计日志（最近 100 条）'));
  const auditBody = el('div', '', '加载中…');
  auditSection.appendChild(auditBody);
  modal.appendChild(auditSection);

  api
    .audit()
    .then((data) => {
      auditBody.replaceChildren();
      const table = el('table', 'data-table');
      const thead = el('thead');
      const hr = el('tr');
      ['时间', '操作人', '动作'].forEach((t) => hr.appendChild(el('th', '', t)));
      thead.appendChild(hr);
      table.appendChild(thead);
      const tbody = el('tbody');
      data.entries.forEach((row) => {
        const tr = el('tr');
        tr.appendChild(el('td', '', new Date(row.createdAt).toLocaleString()));
        tr.appendChild(el('td', '', row.actor ?? '系统'));
        const tdAction = el('td');
        tdAction.appendChild(el('code', '', row.action));
        tr.appendChild(tdAction);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      auditBody.appendChild(table);
    })
    .catch(() => auditBody.replaceChildren(el('span', '', '加载失败')));

  const close = (): void => backdrop.remove();
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (event: MouseEvent) => {
    if (event.target === backdrop) close();
  });
  document.body.appendChild(backdrop);
}
