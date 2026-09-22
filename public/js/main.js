/** 启动入口：根据本地 token 决定进入登录页还是主应用 */

import { api, setToken } from './lib/api.js';
import { initLogin } from './login.js';
import { initApp } from './app.js';

function onLoginSuccess({ token, user, sessionId, sessionKey }) {
  localStorage.setItem('sc_token', token);
  setToken(token);
  initApp({ token, user, sessionId, sessionKey });
}

async function boot() {
  const saved = localStorage.getItem('sc_token');
  if (saved) {
    setToken(saved);
    try {
      const [sess, me] = await Promise.all([api.session(), api.me()]);
      initApp({ token: saved, user: me.user, sessionId: sess.sessionId, sessionKey: sess.sessionKey });
      return;
    } catch (err) {
      console.warn('登录态失效：', err.message);
      localStorage.removeItem('sc_token');
      setToken(null);
    }
  }
  initLogin(onLoginSuccess);
}

boot();
