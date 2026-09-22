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
}
