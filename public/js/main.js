/** 启动入口：根据本地 token 决定进入登录页还是主应用 */

import { api, setToken } from './lib/api.js';
import { initLogin } from './login.js';
import { initApp } from './app.js';
import { toast } from './lib/util.js';

function onLoginSuccess({ token, user, sessionId, sessionKey }) {
  localStorage.setItem('sc_token', token);
  setToken(token);
  initApp({ token, user, sessionId, sessionKey });
}

/** 绑定第三方身份的回调（/?oauth=link）：当前已登录，用票据+登录态完成绑定 */
async function handleLinkCallback(app) {
  history.replaceState(null, '', location.pathname);
  try {
    const { user } = await api.oauthFinish();
    app.applyMyUser(user);
    toast('第三方账号绑定成功');
  } catch (err) {
    toast(err.message || '绑定失败，请重试');
  }
}

async function boot() {
  const saved = localStorage.getItem('sc_token');
  const linkCallback = new URLSearchParams(location.search).get('oauth') === 'link';
  if (saved) {
    setToken(saved);
    try {
      const [sess, me] = await Promise.all([api.session(), api.me()]);
      const app = await initApp({ token: saved, user: me.user, sessionId: sess.sessionId, sessionKey: sess.sessionKey });
      if (linkCallback) await handleLinkCallback(app);
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
