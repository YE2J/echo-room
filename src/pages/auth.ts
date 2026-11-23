// ABOUTME: 登录/注册页（准入：邀请码 + 本地账户）。

import { api, ApiError, type AuthResult } from '../api';
import { alertBox, icons, toast } from '../components';

export function renderAuthPage(onAuthed: (result: AuthResult) => void): HTMLElement {
  let mode: 'login' | 'register' = 'login';

  const wrap = document.createElement('div');
  wrap.className = 'auth-wrap';

  const card = document.createElement('div');
  card.className = 'auth-card';

  card.innerHTML = `
    <div class="auth-brand">
      <span class="auth-logo">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 10.5a4 4 0 0 1 0 3"/><path d="M15.5 10.5a4 4 0 0 0 0 3"/><path d="M10 14.5h4"/></svg>
      </span>
      <h1>匿名回音</h1>
      <p class="auth-subtitle">企业内部意见收集 · 问题匿名举报通道</p>
    </div>
    <form class="auth-form" autocomplete="off">
      <div class="field">
        <label for="f-username">企业账号</label>
        <input class="input" id="f-username" name="username" required minlength="3" maxlength="64"
               autocomplete="username" placeholder="请输入分配的账号" />
      </div>
      <div class="field">
        <label for="f-password">密码</label>
        <input class="input" id="f-password" name="password" type="password" required minlength="8" maxlength="128"
               autocomplete="current-password" placeholder="至少 8 位" />
      </div>
      <div class="field" data-role="invite-field" hidden>
        <label for="f-invite">邀请码</label>
        <input class="input" id="f-invite" name="invite" maxlength="64"
               placeholder="管理员发放的一次性邀请码" />
      </div>
      <div data-role="form-error"></div>
      <button class="btn btn--block" type="submit" data-role="submit">登 录</button>
    </form>
    <div class="auth-switch">
      <span data-role="switch-text">没有账号？</span>
      <button type="button" data-role="switch">使用邀请码注册</button>
    </div>
    <div class="auth-foot">
      <span class="auth-foot-icon">${icons.shield}</span>
      <span>登录后系统为你签发随机匿名昵称，聊天室中任何人都无法看到你的真实身份。身份映射表整表加密，密钥按 Shamir 门限分片保管。</span>
    </div>
  `;

  const form = card.querySelector<HTMLFormElement>('.auth-form')!;
  const inviteField = card.querySelector<HTMLElement>('[data-role="invite-field"]')!;
  const inviteInput = card.querySelector<HTMLInputElement>('#f-invite')!;
  const submitBtn = card.querySelector<HTMLButtonElement>('[data-role="submit"]')!;
  const switchText = card.querySelector<HTMLElement>('[data-role="switch-text"]')!;
  const switchBtn = card.querySelector<HTMLButtonElement>('[data-role="switch"]')!;
  const errorBox = card.querySelector<HTMLElement>('[data-role="form-error"]')!;

  switchBtn.addEventListener('click', () => {
    mode = mode === 'login' ? 'register' : 'login';
    const isRegister = mode === 'register';
    inviteField.hidden = !isRegister;
    inviteInput.required = isRegister;
    submitBtn.textContent = isRegister ? '注册并进入' : '登 录';
    switchText.textContent = isRegister ? '已有账号？' : '没有账号？';
    switchBtn.textContent = isRegister ? '返回登录' : '使用邀请码注册';
    errorBox.replaceChildren();
  });

  form.addEventListener('submit', async (event: SubmitEvent) => {
    event.preventDefault();
    errorBox.replaceChildren();
    const username = (card.querySelector<HTMLInputElement>('#f-username')!).value.trim();
    const password = (card.querySelector<HTMLInputElement>('#f-password')!).value;
    const inviteCode = inviteInput.value.trim();

    if (username.length < 3 || password.length < 8) {
      errorBox.appendChild(alertBox('error', '账号至少 3 位、密码至少 8 位。'));
      return;
    }
    if (mode === 'register' && !inviteCode) {
      errorBox.appendChild(alertBox('error', '注册需要管理员邀请码。'));
      return;
    }

    submitBtn.disabled = true;
    const originalLabel = submitBtn.textContent;
    submitBtn.textContent = '请稍候…';
    try {
      const result =
        mode === 'register'
          ? await api.register(username, password, inviteCode)
          : await api.login(username, password);
      toast(`已进入聊天室，你的匿名身份：${result.alias}`, 'ok', 4500);
      onAuthed(result);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : '网络错误，请稍后重试';
      errorBox.appendChild(alertBox('error', message));
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel ?? '提 交';
    }
  });

  wrap.appendChild(card);
  return wrap;
}
