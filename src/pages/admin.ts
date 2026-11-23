// ABOUTME: 管理员面板（弹层）：保险库状态/解封/封存、邀请码、改写开关、
// 受控溯源（门限分片）、审计。所有用户/服务端数据一律 textContent，严禁 innerHTML 拼接。

import { api, ApiError } from '../api';
import type { AdminMessage, LlmConfigView, LlmProviderId, LlmUsageView, TraceStatus } from '../api';
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

function traceStatusClass(status: TraceStatus): string {
  if (status === 'revealed') return 'badge--safe';
  if (status === 'pending' || status === 'approved') return 'badge--warn';
  return '';
}

export function openAdminPanel(onUnsealed: () => void): void {
  let lastVaultK: number | null = null;
  const backdrop = el('div', 'modal-backdrop');
  const modal = el('div', 'modal');
  backdrop.appendChild(modal);

  const closeBtn = el('button', 'modal-close', '×');
  closeBtn.title = '关闭';
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

  // ---- 页签导航：安全管理（原有5区） / 溯源审批工作台 / 内容管理 / 房间审批 / 房间管理 / 模型设置 ----
  const tabBar = el('div', 'admin-tabs');
  const paneOverview = el('div', 'admin-pane');
  const paneTrace = el('div', 'admin-pane');
  const paneContent = el('div', 'admin-pane');
  const paneRooms = el('div', 'admin-pane');
  const paneRoomAdmin = el('div', 'admin-pane');
  const paneLlm = el('div', 'admin-pane');
  const tabs: Array<{ label: string; pane: HTMLElement }> = [
    { label: '安全管理', pane: paneOverview },
    { label: '溯源审批工作台', pane: paneTrace },
    { label: '内容管理', pane: paneContent },
    { label: '房间审批', pane: paneRooms },
    { label: '房间管理', pane: paneRoomAdmin },
    { label: '模型设置', pane: paneLlm },
  ];
  tabs.forEach((tab, index) => {
    const btn = el('button', 'admin-tab' + (index === 0 ? ' admin-tab--active' : ''), tab.label);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      tabBar.querySelectorAll('.admin-tab').forEach((node) => node.classList.remove('admin-tab--active'));
      btn.classList.add('admin-tab--active');
      tabs.forEach((t) => (t.pane.style.display = t.pane === tab.pane ? '' : 'none'));
    });
    tabBar.appendChild(btn);
  });
  modal.appendChild(tabBar);
  paneTrace.style.display = 'none';
  paneContent.style.display = 'none';
  paneRooms.style.display = 'none';
  paneRoomAdmin.style.display = 'none';
  paneLlm.style.display = 'none';
  modal.append(paneOverview, paneTrace, paneContent, paneRooms, paneRoomAdmin, paneLlm);

  // ---- 保险库 ----
  const vaultSection = el('section', 'admin-section');
  vaultSection.appendChild(h3(icons.key, '身份保险库'));
  const vaultBody = el('div', '', '加载中…');
  vaultSection.appendChild(vaultBody);
  paneOverview.appendChild(vaultSection);

  async function renderVault(): Promise<void> {
    vaultBody.replaceChildren(el('span', '', '加载中…'));
    try {
      const status = await api.vaultStatus();
      lastVaultK = status.k;
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
  paneOverview.appendChild(inviteSection);

  async function renderInvites(): Promise<void> {
    invList.replaceChildren(el('span', '', '加载中…'));
    try {
      const data = await api.listInvites();
      invList.replaceChildren();
      if (data.invites.length === 0) {
        invList.appendChild(el('div', 'muted', '暂无邀请码'));
        return;
      }
      const scroll = el('div', 'table-scroll');
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
      scroll.appendChild(table);
      invList.appendChild(scroll);
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
  paneOverview.appendChild(rewriteSection);

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
  paneOverview.appendChild(revealSection);

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
  paneOverview.appendChild(auditSection);

  api
    .audit()
    .then((data) => {
      auditBody.replaceChildren();
      const scroll = el('div', 'table-scroll');
      const table = el('table', 'data-table');
      const thead = el('thead');
      const hr = el('tr');
      ['时间', '执行方', '动作'].forEach((t) => hr.appendChild(el('th', '', t)));
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
      scroll.appendChild(table);
      auditBody.appendChild(scroll);
    })
    .catch(() => auditBody.replaceChildren(el('span', '', '加载失败')));

  // ================= 页签 A：溯源审批工作台 =================
  buildTraceTab();

  function buildTraceTab(): void {
    const section = el('section', 'admin-section');
    section.appendChild(h3(icons.key, '溯源审批（多名管理员各自提供份额，凑齐门限方可还原身份）'));

    // 顶部：状态筛选 + 刷新
    const filterRow = el('div', 'invite-row');
    const statusFilter = el('select', 'input');
    const statusOptions: Array<{ value: '' | TraceStatus; label: string }> = [
      { value: '', label: '全部' },
      { value: 'pending', label: '待审批 pending' },
      { value: 'approved', label: '审批中 approved' },
      { value: 'revealed', label: '已揭示 revealed' },
      { value: 'rejected', label: '已驳回 rejected' },
      { value: 'closed', label: '已关闭 closed' },
    ];
    statusOptions.forEach((opt) => {
      const o = el('option', '', opt.label) as HTMLOptionElement;
      o.value = opt.value;
      statusFilter.appendChild(o);
    });
    const refreshBtn = el('button', 'btn btn--ghost btn--sm', '刷新');
    filterRow.append(statusFilter, refreshBtn);
    section.appendChild(filterRow);

    // 发起溯源申请表单
    const formTitle = el('div', 'muted');
    formTitle.style.margin = '10px 0 4px';
    formTitle.textContent = '发起溯源申请';
    section.appendChild(formTitle);
    const aliasInput = el('input', 'input');
    aliasInput.placeholder = '目标匿名昵称，如 雾中的鹅卵石-2CCF';
    const reasonInput = el('textarea', 'input');
    reasonInput.rows = 2;
    reasonInput.placeholder = '申请理由（必填，写入审计）';
    const formRow = el('div', 'invite-row');
    formRow.append(aliasInput);
    const createBtn = el('button', 'btn btn--sm', '发起申请');
    const formActions = el('div', 'vault-actions');
    formActions.appendChild(createBtn);
    section.append(formRow, reasonInput, formActions);

    // 申请列表
    const listBox = el('div', '', '加载中…');
    listBox.style.marginTop = '10px';
    section.appendChild(listBox);
    paneTrace.appendChild(section);

    let currentFilter: '' | TraceStatus = '';

    async function renderList(): Promise<void> {
      listBox.replaceChildren(el('span', '', '加载中…'));
      try {
        const data = await api.listTraceRequests(currentFilter);
        listBox.replaceChildren();
        if (data.entries.length === 0) {
          listBox.appendChild(el('div', 'muted', '暂无溯源申请'));
          return;
        }
        const scroll = el('div', 'table-scroll');
        const table = el('table', 'data-table');
        const thead = el('thead');
        const hr = el('tr');
        ['ID', '目标引用', '发起人', '状态', '审批进度', '创建时间'].forEach((t) => hr.appendChild(el('th', '', t)));
        thead.appendChild(hr);
        table.appendChild(thead);
        const tbody = el('tbody');
        data.entries.forEach((row) => {
          const tr = el('tr');
          tr.style.cursor = 'pointer';
          tr.title = '点击查看详情';
          tr.appendChild(el('td', '', row.id));
          const tdAlias = el('td');
          tdAlias.appendChild(el('code', '', row.targetRef));
          tr.appendChild(tdAlias);
          tr.appendChild(el('td', '', row.requesterLabel ?? '—'));
          const tdStatus = el('td');
          tdStatus.appendChild(badge(row.status, traceStatusClass(row.status)));
          tr.appendChild(tdStatus);
          tr.appendChild(el('td', '', `${row.approvals.length}/${vaultKHint()}`));
          tr.appendChild(el('td', '', new Date(row.createdAt).toLocaleString()));
          tr.addEventListener('click', () => openTraceDetail(row.id));
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        scroll.appendChild(table);
        listBox.appendChild(scroll);
      } catch (err) {
        listBox.replaceChildren(el('span', '', err instanceof ApiError ? err.message : '加载失败'));
      }
    }

    statusFilter.addEventListener('change', () => {
      currentFilter = (statusFilter.value as '' | TraceStatus) || '';
      void renderList();
    });
    refreshBtn.addEventListener('click', () => void renderList());

    createBtn.addEventListener('click', async () => {
      clearError();
      const targetAlias = aliasInput.value.trim();
      const reason = reasonInput.value.trim();
      if (!targetAlias) {
        showError('请填写目标匿名昵称');
        return;
      }
      if (reason.length < 2) {
        showError('请填写申请理由');
        return;
      }
      createBtn.disabled = true;
      try {
        await api.createTraceRequest(targetAlias, reason);
        toast('溯源申请已发起', 'ok');
        aliasInput.value = '';
        reasonInput.value = '';
        await renderList();
      } catch (err) {
        showError(err instanceof ApiError ? err.message : '发起失败');
      } finally {
        createBtn.disabled = false;
      }
    });

    void renderList();

    // 详情弹层
    function openTraceDetail(id: string): void {
      const dBackdrop = el('div', 'modal-backdrop');
      const dModal = el('div', 'modal');
      dBackdrop.appendChild(dModal);
      const dClose = el('button', 'modal-close', '×');
      dClose.title = '关闭';
      dClose.setAttribute('aria-label', '关闭');
      dModal.appendChild(dClose);
      const dTitle = el('h2');
      dTitle.appendChild(svg(icons.key));
      dTitle.appendChild(document.createTextNode(' 溯源申请详情'));
      dModal.appendChild(dTitle);
      const dError = el('div', 'admin-error-slot');
      dModal.appendChild(dError);
      const dBody = el('div', '', '加载中…');
      dModal.appendChild(dBodyWrap(dBody));

      const dShowError = (msg: string): void => dError.replaceChildren(el('div', 'alert alert--error', msg));
      const dClearError = (): void => dError.replaceChildren();

      function dBodyWrap(node: HTMLElement): HTMLElement {
        const wrap = el('div');
        wrap.appendChild(node);
        return wrap;
      }

      async function renderDetail(): Promise<void> {
        dBody.replaceChildren(el('span', '', '加载中…'));
        try {
          const d = await api.getTraceRequest(id);
          dBody.replaceChildren();

          const info = el('div', 'vault-badges');
          info.appendChild(badge(d.status, traceStatusClass(d.status)));
          info.appendChild(badge(`审批进度 ${d.approvals.length}/${vaultKHint()}`));
          dBody.appendChild(info);

          const meta = el('div', 'data-table');
          meta.appendChild(el('div', '', `目标引用：${d.targetRef}`));
          meta.appendChild(el('div', '', `发起人：${d.requesterLabel ?? '—'}`));
          meta.appendChild(el('div', '', `申请理由：${d.reason}`));
          if (d.rejectReason) meta.appendChild(el('div', '', `驳回原因：${d.rejectReason}`));
          meta.appendChild(el('div', '', `创建时间：${new Date(d.createdAt).toLocaleString()}`));
          dBody.appendChild(meta);

          // 审批人列表
          const apprTitle = el('div', 'muted');
          apprTitle.style.margin = '10px 0 4px';
          apprTitle.textContent = '已提交份额的审批人';
          dBody.appendChild(apprTitle);
          if (d.approvals.length === 0) {
            dBody.appendChild(el('div', 'muted', '暂无'));
          } else {
            d.approvals.forEach((a) => {
              dBody.appendChild(el('div', '', `${a.label ?? '—'} · ${new Date(a.at).toLocaleString()}`));
            });
          }

          // 已揭示
          if (d.status === 'revealed' && d.revealedUsername) {
            const hit = el('div', 'alert alert--ok');
            hit.appendChild(document.createTextNode('已揭示真实账号 '));
            hit.appendChild(el('code', '', d.revealedUsername));
            dBody.appendChild(hit);
          }

          const isTerminal = d.status === 'revealed' || d.status === 'rejected' || d.status === 'closed';
          if (!isTerminal) {
            // 提交我的密钥份额
            const shareTitle = el('div', 'muted');
            shareTitle.style.margin = '12px 0 4px';
            shareTitle.textContent = '提交我的密钥份额（凑齐门限即自动还原）';
            dBody.appendChild(shareTitle);
            const shareInput = el('textarea', 'input');
            shareInput.rows = 2;
            shareInput.placeholder = '粘贴一份 Shamir 分片字符串，如 1-XXXX';
            dBody.appendChild(shareInput);

            const actRow = el('div', 'vault-actions');
            const approveBtn = el('button', 'btn btn--sm', '提交审批');
            const rejectBtn = el('button', 'btn btn--danger btn--sm', '驳回申请');
            const closeReqBtn = el('button', 'btn btn--ghost btn--sm', '关闭申请');
            actRow.append(approveBtn, rejectBtn, closeReqBtn);
            dBody.appendChild(actRow);

            approveBtn.addEventListener('click', async () => {
              dClearError();
              const share = shareInput.value.trim();
              if (!share) {
                dShowError('请粘贴密钥份额');
                return;
              }
              approveBtn.disabled = true;
              try {
                const res = await api.approveTraceRequest(id, share);
                if (res.status === 'revealed' && res.revealedUsername) {
                  toast(`已揭示：${res.revealedUsername}`, 'ok');
                } else {
                  toast('份额已提交', 'ok');
                }
                await renderDetail();
                await renderList();
              } catch (err) {
                dShowError(err instanceof ApiError ? err.message : '审批失败');
              } finally {
                approveBtn.disabled = false;
              }
            });

            rejectBtn.addEventListener('click', async () => {
              dClearError();
              const reason = window.prompt('请输入驳回原因');
              if (reason === null) return;
              if (reason.trim().length < 2) {
                dShowError('请填写驳回原因（至少 2 字）');
                return;
              }
              try {
                await api.rejectTraceRequest(id, reason.trim());
                toast('已驳回', 'ok');
                await renderDetail();
                await renderList();
              } catch (err) {
                dShowError(err instanceof ApiError ? err.message : '驳回失败');
              }
            });

            closeReqBtn.addEventListener('click', async () => {
              dClearError();
              if (!window.confirm('确定关闭该溯源申请？关闭后不可再审批。')) return;
              try {
                await api.closeTraceRequest(id);
                toast('已关闭', 'ok');
                await renderDetail();
                await renderList();
              } catch (err) {
                dShowError(err instanceof ApiError ? err.message : '关闭失败');
              }
            });
          }
        } catch (err) {
          dBody.replaceChildren(el('span', '', err instanceof ApiError ? err.message : '加载失败'));
        }
      }
      void renderDetail();

      const dCloseFn = (): void => dBackdrop.remove();
      dClose.addEventListener('click', dCloseFn);
      dBackdrop.addEventListener('click', (event: MouseEvent) => {
        if (event.target === dBackdrop) dCloseFn();
      });
      document.body.appendChild(dBackdrop);
    }
  }

  // ================= 页签 B：内容管理 =================
  buildContentTab();
  // ================= 页签 D：房间审批 =================
  buildRoomsTab();
  // ================= 页签 E：房间管理 =================
  buildRoomAdminTab();
  // ================= 页签 F：模型设置 =================
  buildLlmTab();

  function buildContentTab(): void {
    const section = el('section', 'admin-section');
    section.appendChild(h3(icons.shield, '内容管理（仅展示归一化文本，删除写审计）'));

    // 顶部搜索（仅消息内容）+ 刷新
    const topRow = el('div', 'invite-row');
    const searchInput = el('input', 'input');
    searchInput.placeholder = '按消息内容搜索…';
    const msgRefreshBtn = el('button', 'btn btn--ghost btn--sm', '刷新');
    topRow.append(searchInput, msgRefreshBtn);
    section.appendChild(topRow);

    const msgBox = el('div', '', '加载中…');
    msgBox.style.marginTop = '10px';
    section.appendChild(msgBox);
    const moreRow = el('div', 'vault-actions');
    const moreBtn = el('button', 'btn btn--ghost btn--sm', '加载更多');
    moreBtn.style.display = 'none';
    moreRow.appendChild(moreBtn);
    section.appendChild(moreRow);
    paneContent.appendChild(section);

    let nextCursor: string | null = null;
    let allMessages: AdminMessage[] = [];
    let searchTimer: ReturnType<typeof setTimeout> | null = null;

    function renderMessages(): void {
      msgBox.replaceChildren();
      if (allMessages.length === 0) {
        msgBox.appendChild(el('div', 'muted', '暂无消息'));
        return;
      }
      const scroll = el('div', 'table-scroll');
      const table = el('table', 'data-table');
      const thead = el('thead');
      const hr = el('tr');
      ['短引用', '消息内容', '日期', '时段', '改写', '操作'].forEach((t) => hr.appendChild(el('th', '', t)));
      thead.appendChild(hr);
      table.appendChild(thead);
      const tbody = el('tbody');
      allMessages.forEach((m) => {
        const tr = el('tr');
        const tdRef = el('td');
        tdRef.appendChild(el('code', '', m.ref));
        tr.appendChild(tdRef);
        const tdText = el('td');
        const contentLine = el('div', '');
        contentLine.textContent = m.normalizedText.length > 60 ? `${m.normalizedText.slice(0, 60)}…` : m.normalizedText;
        contentLine.title = m.normalizedText;
        tdText.appendChild(contentLine);
        tr.appendChild(tdText);
        tr.appendChild(el('td', '', m.dateKey));
        tr.appendChild(el('td', '', m.timeSlot));
        const tdRewrite = el('td');
        if (m.rewritten) tdRewrite.appendChild(badge('已改写', 'badge--warn'));
        else tdRewrite.appendChild(el('span', 'muted', '原样'));
        tr.appendChild(tdRewrite);
        const tdOps = el('td');
        const delBtn = el('button', 'btn btn--danger btn--sm', '删除');
        delBtn.addEventListener('click', () => confirmDelete(m));
        tdOps.appendChild(delBtn);
        tr.appendChild(tdOps);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      scroll.appendChild(table);
      msgBox.appendChild(scroll);
    }

    async function loadMessages(reset: boolean, keyword?: string): Promise<void> {
      if (reset) {
        msgBox.replaceChildren(el('span', '', '加载中…'));
        allMessages = [];
        nextCursor = null;
      }
      moreBtn.disabled = true;
      try {
        const data = await api.listAdminMessages(reset ? undefined : nextCursor ?? undefined, 20, keyword);
        if (reset) allMessages = data.entries;
        else allMessages = allMessages.concat(data.entries);
        nextCursor = data.nextCursor;
        moreBtn.style.display = nextCursor ? '' : 'none';
        renderMessages();
      } catch (err) {
        msgBox.replaceChildren(el('span', '', err instanceof ApiError ? err.message : '加载失败'));
      } finally {
        moreBtn.disabled = false;
      }
    }

    msgRefreshBtn.addEventListener('click', () => void loadMessages(true, searchInput.value.trim()));
    moreBtn.addEventListener('click', () => void loadMessages(false));
    searchInput.addEventListener('input', () => {
      if (searchTimer !== null) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => void loadMessages(true, searchInput.value.trim()), 350);
    });

    function confirmDelete(m: AdminMessage): void {
      clearError();
      const reason = window.prompt(`删除消息（引用 ${m.ref}）？\n请输入删除原因`, '');
      if (reason === null) return;
      void (async () => {
        try {
          await api.deleteAdminMessage(m.id, reason.trim() || '管理员删除');
          allMessages = allMessages.filter((x) => x.id !== m.id);
          toast('消息已删除', 'ok');
          renderMessages();
        } catch (err) {
          showError(err instanceof ApiError ? err.message : '删除失败');
        }
      })();
    }

    void loadMessages(true, '');
  }

  // ================= 页签 D：房间审批 =================
  function buildRoomsTab(): void {
    const section = el('section', 'admin-section');
    section.appendChild(h3(icons.rooms, '房间审批（通过即创建房间，申请人为房主）'));

    const topRow = el('div', 'invite-row');
    const reqRefreshBtn = el('button', 'btn btn--ghost btn--sm', '刷新');
    topRow.appendChild(reqRefreshBtn);
    section.appendChild(topRow);

    const pendingBox = el('div', '', '加载中…');
    pendingBox.style.marginTop = '10px';
    section.appendChild(pendingBox);
    const doneBox = el('div');
    section.appendChild(doneBox);
    paneRooms.appendChild(section);

    async function renderPending(): Promise<void> {
      pendingBox.replaceChildren(el('span', '', '加载中…'));
      try {
        const { requests } = await api.adminRoomRequests('pending');
        pendingBox.replaceChildren();
        if (requests.length === 0) {
          pendingBox.appendChild(el('div', 'muted', '暂无待审批的建房申请'));
          return;
        }
        requests.forEach((req) => {
          const card = el('div', 'rp-request-row');
          const head = el('div', 'rp-request-head');
          head.appendChild(svg(req.type === 'private' ? icons.lock : icons.globe));
          head.appendChild(el('span', 'rp-request-name', req.name));
          head.appendChild(badge('待审批', 'badge--warn'));
          card.appendChild(head);
          const meta = el('div', 'rp-request-meta');
          meta.appendChild(el('div', '', `申请人：${req.requester ?? '匿名'}`));
          meta.appendChild(el('div', '', `申请时间：${new Date(req.createdAt).toLocaleString()}`));
          if (req.description) meta.appendChild(el('div', '', `简介 / 理由：${req.description}`));
          card.appendChild(meta);
          const actRow = el('div', 'vault-actions');
          const approveBtn = el('button', 'btn btn--sm', '通过');
          const rejectBtn = el('button', 'btn btn--danger btn--sm', '拒绝');
          actRow.append(approveBtn, rejectBtn);
          card.appendChild(actRow);

          approveBtn.addEventListener('click', () => {
            approveBtn.disabled = true;
            void (async () => {
              try {
                const res = await api.approveRoomRequest(req.id);
                toast(`房间「${res.room.name}」已创建，申请人为房主`, 'ok');
                await renderPending();
                await renderDone();
              } catch (err) {
                toast(err instanceof ApiError ? err.message : '审批失败', 'error');
                approveBtn.disabled = false;
              }
            })();
          });

          rejectBtn.addEventListener('click', () => {
            const reason = window.prompt(`拒绝「${req.name}」的建房申请，请输入原因`, '');
            if (reason === null) return;
            if (reason.trim().length < 1) {
              showError('请填写拒绝原因');
              return;
            }
            rejectBtn.disabled = true;
            void (async () => {
              try {
                await api.rejectRoomRequest(req.id, reason.trim());
                toast('已拒绝该申请', 'ok');
                await renderPending();
                await renderDone();
              } catch (err) {
                toast(err instanceof ApiError ? err.message : '操作失败', 'error');
                rejectBtn.disabled = false;
              }
            })();
          });

          pendingBox.appendChild(card);
        });
      } catch (err) {
        pendingBox.replaceChildren(el('span', 'muted', err instanceof ApiError ? err.message : '加载失败'));
      }
    }

    // 已处理折叠区（通过 / 拒绝）
    const details = el('details', 'rp-done');
    const summary = el('summary', '', '已处理申请（通过 / 拒绝）');
    details.appendChild(summary);
    const doneList = el('div');
    details.appendChild(doneList);
    doneBox.appendChild(details);
    details.addEventListener('toggle', () => {
      if (details.open) void renderDone();
    });

    async function renderDone(): Promise<void> {
      try {
        const [approved, rejected] = await Promise.all([api.adminRoomRequests('approved'), api.adminRoomRequests('rejected')]);
        const all = [...approved.requests, ...rejected.requests];
        doneList.replaceChildren();
        if (all.length === 0) {
          doneList.appendChild(el('div', 'muted', '暂无已处理的申请'));
          return;
        }
        all.forEach((req) => {
          const row = el('div', 'rp-done-row');
          row.appendChild(el('span', 'rp-request-name', req.name));
          row.appendChild(
            req.status === 'approved' ? badge('已通过', 'badge--safe') : badge('已拒绝'),
          );
          row.appendChild(el('span', 'muted', req.requester ?? '匿名'));
          if (req.status === 'rejected' && req.rejectReason) {
            row.appendChild(el('span', 'muted rp-req-reason', `原因：${req.rejectReason}`));
          }
          doneList.appendChild(row);
        });
      } catch (err) {
        doneList.replaceChildren(el('span', 'muted', err instanceof ApiError ? err.message : '加载失败'));
      }
    }

    reqRefreshBtn.addEventListener('click', () => {
      void renderPending();
      void renderDone();
    });
    void renderPending();
  }

  // ================= 页签 E：房间管理 =================
  function buildRoomAdminTab(): void {
    const section = el('section', 'admin-section');
    section.appendChild(h3(icons.rooms, '房间管理（含已归档；彻底删除不可恢复）'));

    const topRow = el('div', 'invite-row');
    const roomRefreshBtn = el('button', 'btn btn--ghost btn--sm', '刷新');
    topRow.appendChild(roomRefreshBtn);
    section.appendChild(topRow);

    const roomBox = el('div', '', '加载中…');
    roomBox.style.marginTop = '10px';
    section.appendChild(roomBox);
    paneRoomAdmin.appendChild(section);

    /** 时间粗化为日期（本地时区 yyyy-mm-dd），不显示毫秒 */
    function roomDateKey(ts: number): string {
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return '—';
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }

    function renderRooms(rooms: AdminRoom[]): void {
      roomBox.replaceChildren();
      if (rooms.length === 0) {
        roomBox.appendChild(el('div', 'muted', '暂无房间'));
        return;
      }
      const scroll = el('div', 'table-scroll');
      const table = el('table', 'data-table');
      const thead = el('thead');
      const hr = el('tr');
      ['房间名', '类型', '成员数', '消息数', '状态', '创建日期', '操作'].forEach((t) => hr.appendChild(el('th', '', t)));
      thead.appendChild(hr);
      table.appendChild(thead);
      const tbody = el('tbody');
      rooms.forEach((room) => {
        const tr = el('tr', room.archivedAt !== null ? 'room-row--archived' : '');
        const tdName = el('td');
        tdName.appendChild(el('span', 'rp-request-name', room.name));
        tr.appendChild(tdName);
        const tdType = el('td');
        tdType.appendChild(el('span', '', room.type === 'private' ? '私密' : '公开'));
        tr.appendChild(tdType);
        tr.appendChild(el('td', '', String(room.memberCount)));
        tr.appendChild(el('td', '', String(room.messageCount)));
        const tdStatus = el('td');
        tdStatus.appendChild(
          room.archivedAt !== null ? badge('已归档', 'badge--warn') : badge('正常', 'badge--safe'),
        );
        tr.appendChild(tdStatus);
        tr.appendChild(el('td', '', roomDateKey(room.createdAt)));
        const tdOps = el('td');
        if (room.archivedAt !== null) {
          const restoreBtn = el('button', 'btn btn--ghost btn--sm', '恢复');
          restoreBtn.title = `恢复房间「${room.name}」`;
          restoreBtn.addEventListener('click', () => {
            restoreBtn.disabled = true;
            void (async () => {
              try {
                await api.adminRestoreRoom(room.id);
                toast(`房间「${room.name}」已恢复`, 'ok');
                await loadRoomList();
              } catch (err) {
                toast(err instanceof ApiError ? err.message : '恢复失败', 'error');
                restoreBtn.disabled = false;
              }
            })();
          });
          tdOps.appendChild(restoreBtn);
        } else {
          const archiveBtn = el('button', 'btn btn--ghost btn--sm', '归档');
          archiveBtn.title = `归档房间「${room.name}」`;
          archiveBtn.addEventListener('click', () => {
            archiveBtn.disabled = true;
            void (async () => {
              try {
                await api.adminArchiveRoom(room.id);
                toast(`房间「${room.name}」已归档`, 'ok');
                await loadRoomList();
              } catch (err) {
                toast(err instanceof ApiError ? err.message : '归档失败', 'error');
                archiveBtn.disabled = false;
              }
            })();
          });
          tdOps.appendChild(archiveBtn);
        }
        const delBtn = el('button', 'btn btn--danger btn--sm', '彻底删除');
        delBtn.title = `彻底删除房间「${room.name}」（不可恢复）`;
        delBtn.addEventListener('click', () => confirmPermanentDelete(room));
        tdOps.appendChild(delBtn);
        tr.appendChild(tdOps);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      scroll.appendChild(table);
      roomBox.appendChild(scroll);
    }

    async function loadRoomList(): Promise<void> {
      roomBox.replaceChildren(el('span', '', '加载中…'));
      try {
        const { rooms } = await api.adminRooms();
        renderRooms(rooms);
      } catch (err) {
        roomBox.replaceChildren(el('span', '', err instanceof ApiError ? err.message : '加载失败'));
      }
    }

    /** 彻底删除二次确认：必须输入房间名原文才能点「永久删除」 */
    function confirmPermanentDelete(room: AdminRoom): void {
      const dBackdrop = el('div', 'modal-backdrop');
      const dModal = el('div', 'modal modal--danger-confirm');
      dBackdrop.appendChild(dModal);

      const dClose = el('button', 'modal-close', '×');
      dClose.title = '关闭';
      dClose.setAttribute('aria-label', '关闭');
      dModal.appendChild(dClose);

      const dTitle = el('h2');
      dTitle.appendChild(svg(icons.rooms));
      dTitle.appendChild(document.createTextNode(' 彻底删除房间'));
      dModal.appendChild(dTitle);

      const warn = el('p', 'sub');
      warn.appendChild(document.createTextNode(
        `删除「${room.name}」将永久清除其全部消息、成员与建房申请，且无法恢复。`,
      ));
      dModal.appendChild(warn);
      dModal.appendChild(el('p', 'sub', '请输入房间名原文以确认：'));

      const nameField = el('div', 'field');
      const nameInput = el('input', 'input');
      nameInput.placeholder = room.name;
      nameField.appendChild(nameInput);
      dModal.appendChild(nameField);

      const actRow = el('div', 'vault-actions');
      const cancelBtn = el('button', 'btn btn--ghost btn--sm', '取消');
      const confirmBtn = el('button', 'btn btn--danger btn--sm', '永久删除');
      confirmBtn.disabled = true;
      actRow.append(cancelBtn, confirmBtn);
      dModal.appendChild(actRow);

      const closeModal = (): void => dBackdrop.remove();
      cancelBtn.addEventListener('click', closeModal);
      dClose.addEventListener('click', closeModal);
      dBackdrop.addEventListener('click', (event: MouseEvent) => {
        if (event.target === dBackdrop) closeModal();
      });
      nameInput.addEventListener('input', () => {
        confirmBtn.disabled = nameInput.value.trim() !== room.name;
      });
      confirmBtn.addEventListener('click', () => {
        if (nameInput.value.trim() !== room.name) return;
        confirmBtn.disabled = true;
        void (async () => {
          try {
            await api.adminDeleteRoom(room.id);
            closeModal();
            toast(`房间「${room.name}」已彻底删除`, 'ok');
            await loadRoomList();
          } catch (err) {
            restartConfirm();
            toast(err instanceof ApiError ? err.message : '删除失败', 'error');
          }
        })();
      });

      function restartConfirm(): void {
        confirmBtn.disabled = true;
        nameInput.value = '';
        nameInput.focus();
      }

      nameInput.focus();
      document.body.appendChild(dBackdrop);
    }

    roomRefreshBtn.addEventListener('click', () => void loadRoomList());
    void loadRoomList();
  }

  // ================= 页签 F：模型设置 =================
  function buildLlmTab(): void {
    const section = el('section', 'admin-section');
    section.appendChild(h3(icons.settings, '模型设置（settings > 环境变量 > 默认值，保存即热生效）'));
    paneLlm.appendChild(section);

    const form = el('div', 'llm-form');
    section.appendChild(form);

    // ---- provider 单选（卡片式）----
    const providerField = el('div', 'field');
    providerField.appendChild(el('label', '', '模型服务'));
    const providerRow = el('div', 'llm-providers');
    const providerDefs: Array<{ id: LlmProviderId; label: string; hint: string }> = [
      { id: 'coze', label: '扣子智能体', hint: '扣子部署的改写智能体：需要 baseUrl 与 API Token' },
      { id: 'openai', label: 'OpenAI 兼容', hint: '任意 OpenAI 兼容接口（含国内中转）：baseUrl、model 与 API Key' },
      { id: 'ollama', label: '本地 Ollama', hint: '本地 / 内网 Ollama 服务：baseUrl 与 model，一般无需 API Key' },
    ];
    const providerButtons = new Map<LlmProviderId, HTMLButtonElement>();
    let provider: LlmProviderId = 'openai';
    const providerHint = el('span', 'llm-provider-hint', '');
    providerDefs.forEach((p) => {
      const btn = el('button', 'btn btn--sm llm-provider', p.label);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        provider = p.id;
        providerButtons.forEach((_, id) => providerButtons.get(id)?.classList.remove('llm-provider--active'));
        btn.classList.add('llm-provider--active');
        providerHint.replaceChildren(document.createTextNode(p.hint));
      });
      providerButtons.set(p.id, btn);
      providerRow.appendChild(btn);
    });
    providerField.append(providerRow, providerHint);
    form.appendChild(providerField);

    // ---- base url / model / api key / timeout / onFailure / enabled ----
    const baseUrlInput = el('input', 'input');
    baseUrlInput.placeholder = 'https://...（留空沿用环境变量）';
    baseUrlInput.spellcheck = false;
    form.append(fieldRow('Base URL', baseUrlInput));

    const modelInput = el('input', 'input');
    modelInput.placeholder = '模型名，如 gpt-4o-mini / qwen2.5:7b（留空沿用环境变量）';
    modelInput.spellcheck = false;
    form.append(fieldRow('Model', modelInput));

    const apiKeyInput = el('input', 'input');
    apiKeyInput.type = 'password';
    apiKeyInput.autocomplete = 'new-password';
    apiKeyInput.placeholder = '未配置';
    const apiKeyRow = fieldRow('API Key', apiKeyInput);
    const clearKeyBtn = el('button', 'btn btn--ghost btn--sm llm-clear-key', '清除已存 Key');
    clearKeyBtn.type = 'button';
    apiKeyRow.querySelector('.llm-field-controls')!.appendChild(clearKeyBtn);
    form.appendChild(apiKeyRow);

    const timeoutInput = el('input', 'input');
    timeoutInput.type = 'number';
    timeoutInput.min = '100';
    timeoutInput.max = '600000';
    timeoutInput.value = '8000';
    form.append(fieldRow('超时（ms）', timeoutInput));

    const onFailureSelect = el('select', 'input llm-select');
    const optPassthrough = el('option', '', 'passthrough（失败放行原文）');
    optPassthrough.value = 'passthrough';
    const optError = el('option', '', 'error（失败即报错拒绝发送）');
    optError.value = 'error';
    onFailureSelect.append(optPassthrough, optError);
    form.append(fieldRow('失败策略', onFailureSelect));

    const enabledLabel = el('label', 'llm-enabled');
    const enabledCheck = el('input');
    enabledCheck.type = 'checkbox';
    enabledCheck.checked = true;
    enabledLabel.appendChild(enabledCheck);
    enabledLabel.appendChild(document.createTextNode(' 启用语气归一化（改写开关）'));
    form.appendChild(enabledLabel);

    // ---- 操作按钮 ----
    const actions = el('div', 'vault-actions');
    const saveBtn = el('button', 'btn btn--sm', '保存');
    const testBtn = el('button', 'btn btn--ghost btn--sm', '测试连通性');
    actions.append(saveBtn, testBtn);
    form.appendChild(actions);

    // ---- 测试结果区 ----
    const testResult = el('div', 'llm-test-result');
    testResult.style.display = 'none';
    form.appendChild(testResult);

    // ---- 用量统计 ----
    const usageSection = el('section', 'admin-section');
    usageSection.appendChild(h3(icons.refresh, '用量统计（真实 LLM 调用，token 以响应字段为准）'));
    const usageBox = el('div', '', '加载中…');
    usageSection.appendChild(usageBox);
    paneLlm.appendChild(usageSection);

    function fieldRow(labelText: string, control: HTMLElement): HTMLElement {
      const field = el('div', 'field');
      field.appendChild(el('label', '', labelText));
      const controls = el('div', 'llm-field-controls');
      controls.appendChild(control);
      field.appendChild(controls);
      return field;
    }

    function applyConfigView(view: LlmConfigView): void {
      provider = view.provider;
      providerButtons.forEach((btn, id) => btn.classList.toggle('llm-provider--active', id === provider));
      const hint = providerDefs.find((p) => p.id === provider)?.hint ?? '';
      providerHint.replaceChildren(document.createTextNode(hint));
      baseUrlInput.value = view.baseUrl ?? '';
      modelInput.value = view.model ?? '';
      apiKeyInput.placeholder = `当前：${view.apiKeyMasked}（留空不改）`;
      timeoutInput.value = String(view.timeoutMs);
      onFailureSelect.value = view.onFailure;
      enabledCheck.checked = view.enabled;
    }

    async function loadConfig(): Promise<void> {
      try {
        applyConfigView(await api.adminLlmConfig());
      } catch (err) {
        showError(err instanceof ApiError ? err.message : '配置加载失败');
      }
    }

    saveBtn.addEventListener('click', () => {
      saveBtn.disabled = true;
      void (async () => {
        try {
          const payload: {
            provider?: LlmProviderId;
            baseUrl?: string;
            model?: string;
            timeoutMs?: number;
            onFailure?: 'passthrough' | 'error';
            enabled?: boolean;
            apiKey?: string;
          } = {};
          payload.provider = provider;
          if (baseUrlInput.value.trim()) payload.baseUrl = baseUrlInput.value.trim();
          if (modelInput.value.trim()) payload.model = modelInput.value.trim();
          const t = Number(timeoutInput.value);
          if (Number.isFinite(t) && t >= 100 && t <= 600000) payload.timeoutMs = Math.round(t);
          payload.onFailure = (onFailureSelect.value === 'error' ? 'error' : 'passthrough');
          payload.enabled = enabledCheck.checked;
          const rawKey = apiKeyInput.value;
          if (rawKey) payload.apiKey = rawKey;
          const view = await api.adminSaveLlmConfig(payload);
          applyConfigView(view);
          apiKeyInput.value = '';
          toast('配置已保存并热生效', 'ok');
          await loadUsage();
        } catch (err) {
          toast(err instanceof ApiError ? err.message : '保存失败', 'error');
        } finally {
          saveBtn.disabled = false;
        }
      })();
    });

    clearKeyBtn.addEventListener('click', () => {
      if (!window.confirm('清除已保存的 API Key？将回退到环境变量配置。')) return;
      clearKeyBtn.disabled = true;
      void (async () => {
        try {
          const view = await api.adminSaveLlmConfig({ apiKey: '' });
          applyConfigView(view);
          apiKeyInput.value = '';
          toast('已清除 API Key', 'ok');
        } catch (err) {
          toast(err instanceof ApiError ? err.message : '清除失败', 'error');
        } finally {
          clearKeyBtn.disabled = false;
        }
      })();
    });

    testBtn.addEventListener('click', () => {
      testBtn.disabled = true;
      testResult.style.display = '';
      testResult.replaceChildren(el('span', 'muted', '测试中…'));
      void (async () => {
        try {
          const res = await api.adminTestLlm();
          testResult.className = 'llm-test-result llm-test-result--ok';
          testResult.replaceChildren();
          const headRow = el('div', 'llm-test-head');
          headRow.appendChild(badge('连通正常', 'badge--safe'));
          headRow.appendChild(el('span', 'muted', `${res.provider}${res.model ? ' / ' + res.model : ''} · ${res.latencyMs}ms`));
          testResult.appendChild(headRow);
          if (res.usage) {
            const usageLine = el('div', '', `输入 ${res.usage.inputTokens ?? '—'} · 输出 ${res.usage.outputTokens ?? '—'} · 合计 ${res.usage.totalTokens ?? '—'} tokens`);
            testResult.appendChild(usageLine);
          }
          if (res.sample) {
            const sampleBox = el('div', 'llm-test-sample');
            const sampleTitle = el('div', 'muted', '改写样例：');
            sampleBox.appendChild(sampleTitle);
            sampleBox.appendChild(el('div', '', res.sample));
            testResult.appendChild(sampleBox);
          }
          await loadUsage();
        } catch (err) {
          testResult.className = 'llm-test-result llm-test-result--err';
          testResult.replaceChildren(el('span', '', err instanceof ApiError ? err.message : '测试失败'));
          await loadUsage();
        } finally {
          testBtn.disabled = false;
        }
      })();
    });

    async function loadUsage(): Promise<void> {
      usageBox.replaceChildren(el('span', 'muted', '加载中…'));
      try {
        const view = await api.adminLlmUsage(20);
        renderUsage(view);
      } catch (err) {
        usageBox.replaceChildren(el('span', 'muted', err instanceof ApiError ? err.message : '用量统计加载失败'));
      }
    }

    function renderUsage(view: LlmUsageView): void {
      usageBox.replaceChildren();
      const cards = el('div', 'usage-cards');
      const card = (label: string, value: string | number, danger = false): HTMLElement => {
        const c = el('div', 'usage-card' + (danger ? ' usage-card--danger' : ''));
        c.appendChild(el('div', 'usage-card-label', label));
        c.appendChild(el('div', 'usage-card-value', String(value)));
        return c;
      };
      cards.append(
        card('累计调用', view.total.calls),
        card('总 Token', view.total.totalTokens),
        card('输入 / 输出', `${view.total.inputTokens} / ${view.total.outputTokens}`),
        card('平均耗时', `${view.total.avgLatencyMs}ms`),
        card('失败次数', view.total.failCount, view.total.failCount > 0),
      );
      usageBox.appendChild(cards);

      if (view.recent.length === 0) {
        usageBox.appendChild(el('div', 'muted llm-usage-empty', '暂无 LLM 调用记录'));
        return;
      }
      const scroll = el('div', 'table-scroll');
      const table = el('table', 'data-table');
      const thead = el('thead');
      const hr = el('tr');
      ['时间', 'provider', 'model', '输入', '输出', '合计', '耗时', '状态'].forEach((t) =>
        hr.appendChild(el('th', '', t)),
      );
      thead.appendChild(hr);
      table.appendChild(thead);
      const tbody = el('tbody');
      view.recent.forEach((row) => {
        const tr = el('tr');
        const time = el('td', '', new Date(row.createdAt).toLocaleString());
        const providerCell = el('td', '', row.provider);
        const modelCell = el('td', '', row.model || '—');
        const inCell = el('td', '', row.inputTokens != null ? String(row.inputTokens) : '—');
        const outCell = el('td', '', row.outputTokens != null ? String(row.outputTokens) : '—');
        const totalCell = el('td', '', row.totalTokens != null ? String(row.totalTokens) : '—');
        const latencyCell = el('td', '', row.latencyMs != null ? `${row.latencyMs}ms` : '—');
        const statusCell = row.ok
          ? badge('成功', 'badge--safe')
          : badge('失败', 'badge--danger');
        tr.append(time, providerCell, modelCell, inCell, outCell, totalCell, latencyCell, statusCell);
        if (!row.ok) {
          const errTr = el('tr', 'llm-usage-err');
          const errTd = el('td', 'muted', row.error ? `失败原因：${row.error}` : '调用失败');
          errTd.colSpan = 8;
          errTr.appendChild(errTd);
          tbody.append(tr, errTr);
        } else {
          tbody.appendChild(tr);
        }
      });
      table.appendChild(tbody);
      scroll.appendChild(table);
      usageBox.appendChild(scroll);
    }

    void loadConfig();
    void loadUsage();
  }

  // 门限值提示（取自保险库状态；加载失败时退回展示 '-'）
  function vaultKHint(): string {
    return String(lastVaultK ?? '-');
  }

  const close = (): void => backdrop.remove();
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (event: MouseEvent) => {
    if (event.target === backdrop) close();
  });
  document.body.appendChild(backdrop);
}
