/** 登录 / 注册视图 */

import { $, toast } from './lib/util.js';
import { api } from './lib/api.js';

export function initLogin(onSuccess) {
  $('#login-view').hidden = false;
  $('#app-view').hidden = true;
  $('#login-error').textContent = '';

  const switchTab = (tab) => {
    const isLogin = tab === 'login';
    $('#tab-login').classList.toggle('active', isLogin);
    $('#tab-register').classList.toggle('active', !isLogin);
    $('#form-login').hidden = !isLogin;
    $('#form-register').hidden = isLogin;
    $('#login-error').textContent = '';
  };
  $('#tab-login').onclick = () => switchTab('login');
  $('#tab-register').onclick = () => switchTab('register');

  const bindFormSubmit = (formId, btnLabel, action) => {
    $(formId).addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = $('#login-error');
      errEl.textContent = '';
      const btn = e.target.querySelector('button[type=submit]');
      const originLabel = btn.textContent;
      try {
        btn.disabled = true; btn.textContent = '处理中...';
        await action(e.target);
      } catch (err) {
        errEl.textContent = err.message;
        btn.disabled = false; btn.textContent = originLabel;   // 失败后恢复按钮，可直接重输
      }
    });
  };

  bindFormSubmit('#form-login', '登 录', async () => {
    const username = $('#login-username').value.trim();
    const password = $('#login-password').value;
    const data = await api.login({ username, password });
    toast('登录成功');
    onSuccess(data);
  });

  bindFormSubmit('#form-register', '注 册', async () => {
    const username = $('#reg-username').value.trim();
    const nickname = $('#reg-nickname').value.trim();
    const password = $('#reg-password').value;
    await api.register({ username, nickname, password });
    toast('注册成功，请登录');
    $('#login-username').value = username;
    $('#login-password').value = password;
    $('#reg-username').value = '';
    $('#reg-nickname').value = '';
    $('#reg-password').value = '';
    switchTab('login');
  });

  loadProviders();
  handleOAuthCallback(onSuccess);
}

/** 拉取已配置的第三方登录提供方并渲染按钮（未配置时整块隐藏） */
async function loadProviders() {
  try {
    const { providers = [] } = await api.providers();
    if (!providers.length) return;
    const btns = $('#oauth-btns');
    btns.textContent = '';
    for (const p of providers) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'oauth-btn';
      btn.textContent = p.name;
      btn.addEventListener('click', () => {
        btn.disabled = true;
        btn.textContent = '正在跳转...';
        location.href = '/api/auth/oauth/' + encodeURIComponent(p.id) + '/start';
      });
      btns.appendChild(btn);
    }
    $('#login-oauth').hidden = false;
  } catch (_) { /* 接口不可用时静默：仅保留本地登录 */ }
}

/** 第三方登录回调：?oauth=callback 用票据换会话；?oauth=error 展示失败原因；?oauth=link 为登录态过期场景 */
async function handleOAuthCallback(onSuccess) {
  const params = new URLSearchParams(location.search);
  const mode = params.get('oauth');
  if (!mode) return;
  const errEl = $('#login-error');
  const cleanUrl = () => history.replaceState(null, '', location.pathname);
  if (mode === 'callback') {
    errEl.textContent = '第三方登录中...';
    try {
      const data = await api.oauthFinish();
      cleanUrl();
      toast('登录成功');
      onSuccess(data);
    } catch (err) {
      cleanUrl();
      errEl.textContent = err.message || '第三方登录失败，请重试';
    }
  } else if (mode === 'link') {
    // 绑定流程的回调到达登录页 = 发起绑定时所用的本站登录态已过期
    cleanUrl();
    errEl.textContent = '登录已过期，请先登录本站账号，再在资料页绑定第三方账号';
  } else if (mode === 'error') {
    cleanUrl();
    errEl.textContent = params.get('msg') || '第三方登录失败，请重试';
  }
}
