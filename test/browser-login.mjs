// 登录页回归：本地登录表单 / OAuth 区块显隐 / oauth=error 回调提示 / 资料弹窗登录方式徽章
import assert from 'node:assert/strict';
import { launchBrowser, sleep } from './browser-helper.mjs';
const host = process.env.HOST || 'http://127.0.0.1:3130';
let passed = 0;
const check = (name, ok) => { assert.ok(ok, name); console.log('  [PASS] ' + name); passed++; };
async function api(method, route, body) {
  const res = await fetch(host + '/api' + route, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.ok(res.ok, route + ': ' + res.status);
  return res.json();
}
const username = 'chat_' + Date.now();
await api('POST', '/auth/register', { username, password: 'pass1234' });
const browser = await launchBrowser();
const { send, evaluate, wait, click } = browser;
const navigateAndReady = async url => {
  await send('Page.navigate', { url });
  await wait(`location.origin === ${JSON.stringify(host)} && document.readyState === 'complete'`);
};
const fillAndSubmit = async (user, pass) => {
  await evaluate(`document.querySelector('#login-username').value = ${JSON.stringify(user)};
    document.querySelector('#login-password').value = ${JSON.stringify(pass)};
    document.querySelector('#form-login').requestSubmit();`);
};
try {
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await navigateAndReady(host);

  check('登录表单渲染', await evaluate(`document.querySelector('#form-login').checkVisibility()`));
  check('未配置第三方登录时 OAuth 区块整块隐藏', await evaluate(`document.querySelector('#login-oauth').hidden`));

  // oauth=error 回调：地址栏参数被清除、失败原因展示在错误区
  await navigateAndReady(host + '/?oauth=error&msg=' + encodeURIComponent('联调失败原因'));
  await wait(`document.querySelector('#login-error').textContent !== ''`);
  check('oauth=error 展示失败原因', await evaluate(`document.querySelector('#login-error').textContent === '联调失败原因'`));
  check('回调参数已从地址栏清除', await evaluate(`location.search === ''`));

  // 本地登录:错误密码 → 错误文案 + 按钮恢复
  await fillAndSubmit(username, 'wrong-password');
  await wait(`document.querySelector('#login-error').textContent !== ''`);
  check('错误密码显示错误文案', await evaluate(`document.querySelector('#login-error').textContent.length > 0`));
  check('失败后登录按钮恢复可用', await evaluate(`!document.querySelector('#form-login button[type=submit]').disabled`));

  // 本地登录:正确密码 → 进入应用
  await fillAndSubmit(username, 'pass1234');
  await wait(`!document.querySelector('#login-view').checkVisibility() && document.querySelector('#app-view').checkVisibility()`);
  check('本地登录成功进入应用', true);
  check('token 已持久化到 localStorage', await evaluate(`!!localStorage.getItem('sc_token')`));

  // safeUser 透出 authProvider(本地账号为空字符串)
  const me = await evaluate(`(async () => (await (await fetch('/api/auth/me', {
    headers: { Authorization: 'Bearer ' + localStorage.getItem('sc_token') } })).json()).user)()`);
  check('本地账号 authProvider 为空', me && me.authProvider === '');

  // 资料弹窗:本地账号无登录方式徽章
  await click('#btn-profile');
  await wait(`document.querySelector('#profile-nickname').checkVisibility()`);
  check('资料弹窗打开且本地账号不显示登录方式', await evaluate(`!document.querySelector('.profile-auth-method')`));
  await click('.modal-close');
  await wait(`!document.querySelector('#modal-box .modal-body')`);

  // 退出登录
  await click('#btn-logout');
  await wait(`!localStorage.getItem('sc_token') && document.querySelector('#login-view').checkVisibility()`);
  check('退出登录回到登录页并清除 token', true);
  check('登录页回归无未捕获异常', browser.errors.length === 0);
} catch (err) {
  console.error('登录页回归失败:', err.message);
  throw err;
} finally {
  await browser.close();
}
console.log(`登录页回归 ${passed} 项通过`);
