// 会话竞态/草稿/历史操作/消息渲染的浏览器回归；仅注入 API 延迟，不导出应用私有状态。
import assert from 'node:assert/strict';
import { launchBrowser, sleep } from './browser-helper.mjs';
const host = process.env.HOST || 'http://127.0.0.1:3130';
let passed = 0;
const check = (name, ok) => { assert.ok(ok, name); console.log('  [PASS] ' + name); passed++; };
let login;
async function api(method, route, body) {
  const res = await fetch(host + '/api' + route, { method,
    headers: { 'Content-Type': 'application/json', ...(login ? { Authorization: 'Bearer ' + login.token } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  assert.ok(res.ok, route + ': ' + res.status);
  return res.json();
}
const username = 'chat_' + Date.now();
await api('POST', '/auth/register', { username, password: 'pass1234' });
login = await api('POST', '/auth/login', { username, password: 'pass1234' });
const members = [];
for (const suffix of ['b', 'c']) {
  const { user } = await api('POST', '/auth/register', { username: username + suffix, password: 'pass1234' });
  members.push(user.id);
}
const { group } = await api('POST', '/groups', { name: '竞态测试群', memberIds: members });
const convs = (await api('GET', '/conversations')).conversations;
const helper = convs.find(c => c.convType === 'single');
const groupId = 'g_' + group.id;
const browser = await launchBrowser();
const { send, evaluate, wait, click, mouse, point } = browser;
const inputValue = () => evaluate(`document.querySelector('#msg-input').value`);
const selector = id => '.conv-item[data-convid="' + id + '"]';
const open = async id => {
  await click(selector(id));
  await wait(`!document.querySelector('.skel-wrap') && document.querySelector('#msg-input').checkVisibility()`);
};
const input = async value => {
  await evaluate(`document.querySelector('#msg-input').value = ${JSON.stringify(value)}; document.querySelector('#msg-input').dispatchEvent(new Event('input', { bubbles: true }));`);
};
const action = async (id, act) => {
  const row = `.msg-row[data-msgid="${id}"]`;
  await evaluate(`document.querySelector(${JSON.stringify(row)}).scrollIntoView({ block: 'center' })`);
  await mouse('mouseMoved', await point(row));
  await evaluate(`document.querySelector(${JSON.stringify(row)}).classList.add('hovered')`);
  const button = row + ' button[data-act="' + act + '"]';
  await wait(`document.querySelector(${JSON.stringify(button)}).checkVisibility()`);
  await click(button);
  await sleep(100);
};
try {
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: host });
  await wait(`location.origin === ${JSON.stringify(host)} && document.readyState === 'complete'`);
  await evaluate(`localStorage.setItem('sc_token', ${JSON.stringify(login.token)});`);
  // 使用应用的真实加密客户端准备历史消息，随后刷新测试索引恢复。
  const ids = await evaluate(`(async () => {
    const { ChatSocket } = await import('/js/lib/socket.js');
    const pending = new Map(); let connected;
    const ready = new Promise(resolve => connected = resolve);
    const socket = new ChatSocket({ ...${JSON.stringify(login)}, onMessage: e => {
      if (e.type === 'connected') connected();
      if (e.type === 'ack') { pending.get(e.msgId)?.(); pending.delete(e.msgId); }
    }});
    await socket.connect(); await ready;
    const send = async (kind, content, extra = {}) => {
      const msgId = crypto.randomUUID();
      const ack = new Promise(resolve => pending.set(msgId, resolve));
      await socket.send({ type: 'chat', msg: { msgId, convType: 'single', to: ${helper.peer.id}, kind, content, ...extra } });
      await ack; return msgId;
    };
    const original = await send('text', { text: '历史原文' });
    const reply = await send('text', { text: '历史引用' }, { replyTo: original, replySnip: '引用原文' });
    await send('image', { url: '/bad" onerror="window.injected=1' });
    await send('voice', { url: '/bad" onclick="window.injected=2', duration: '<img src=x onerror=window.injected=3>' });
    await send('file', { url: 'javascript:window.injected=4', name: '危险链接', size: 1 });
    socket.close(); return { original, reply };
  })()`);
  await send('Page.reload');
  await wait(`document.querySelectorAll('.conv-item').length >= 2`);
  await open(helper.convId);
  check('恶意媒体字段不生成事件属性或可执行链接', await evaluate(`!document.querySelector('#msg-list [onerror], #msg-list [onclick], #msg-list a[href^="javascript:"]') && !window.injected`));
  await action(ids.original, 'reply');
  check('刷新后历史消息回复按钮有效', await evaluate(`!document.querySelector('#reply-bar').hidden && document.querySelector('#reply-bar').textContent.includes('历史原文')`));
  await input('给助手的草稿');
  await open(groupId);
  check('切换会话隔离文字与引用', await inputValue() === '' && await evaluate(`document.querySelector('#reply-bar').hidden`));
  await input('群聊草稿');
  await open(helper.convId);
  check('切回恢复文字与引用', await inputValue() === '给助手的草稿' && await evaluate(`!document.querySelector('#reply-bar').hidden`));
  check('会话列表有草稿标记', await evaluate(`document.querySelectorAll('.draft-label').length === 2`));
  await send('Page.reload');
  await wait(`document.querySelectorAll('.conv-item').length >= 2`);
  await open(helper.convId);
  check('刷新恢复本标签页草稿', await inputValue() === '给助手的草稿' && await evaluate(`!document.querySelector('#reply-bar').hidden`));
  await click('#btn-send');
  await wait(`document.querySelector('#msg-input').value === ''`);
  check('发送清除当前草稿但保留其他会话草稿', await evaluate(`document.querySelectorAll('.draft-label').length === 1`));
  await send('Page.reload');
  await wait(`document.querySelectorAll('.conv-item').length >= 2`);
  await open(helper.convId);
  await wait(`document.querySelector('#msg-list').textContent.includes('历史原文')`);
  await action(ids.original, 'edit');
  await wait(`!!document.querySelector('#edit-text')`);
  await evaluate(`document.querySelector('#edit-text').value = '历史原文已编辑'`);
  await click('#btn-do-edit');
  await wait(`document.querySelector('#msg-list').textContent.includes('历史原文已编辑')`);
  check('历史消息编辑事件更新当前消息对象', true);
  const replyCard = `.msg-row[data-msgid="${ids.reply}"] .msg-reply`;
  // 引用卡片可能正被 hover 操作条遮挡或处于渲染动画中：校验落点并重试。
  let jumped = null;
  for (let attempt = 0; attempt < 5 && !jumped; attempt++) {
    await evaluate(`document.querySelector(${JSON.stringify(replyCard)}).scrollIntoView({ block: 'center' })`);
    await sleep(250);
    const p = await point(replyCard);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(300);
    jumped = await evaluate(`document.querySelector('.msg-row.flash')?.dataset.msgid || null`);
  }
  const jump = { flash: jumped };
  if (jump.flash !== ids.original) {
    await evaluate(`document.querySelector(${JSON.stringify(replyCard)}).click()`);
    await sleep(200);
    jump.synthetic = await evaluate(`(document.querySelector('.msg-row.flash')?.dataset.msgid) || 'none'`);
  }
  check('引用跳转按消息编号定位，不受系统消息影响', jump.flash === ids.original || (console.log('  [诊断]', JSON.stringify(jump)), false));
  await action(ids.original, 'forward');
  await click('[data-fwdconv="' + helper.convId + '"]');
  await wait(`!!document.querySelector('.msg-fwd')`);
  check('发送方实时显示转发消息', true);
  await input('前后');
  await evaluate(`document.querySelector('#msg-input').setSelectionRange(1, 1)`);
  await click('#btn-emoji');
  const emoji = await evaluate(`document.querySelector('#emoji-panel button').dataset.emoji`);
  await click('#emoji-panel button');
  check('表情插入光标处且纳入草稿', await inputValue() === '前' + emoji + '后');
  await input('');
  await click('#btn-search-history');
  await evaluate(`(async () => {
    const { api } = await import('/js/lib/api.js');
    const original = api.searchHistory;
    api.searchHistory = async (...args) => {
      const result = await original(...args);
      if (args[1] === '历史原文') { window.searchPaused = true; await new Promise(r => window.releaseSearch = r); }
      return result;
    };
    const el = document.querySelector('#history-search-input');
    el.value = '历史原文'; el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await wait('window.searchPaused');
  await evaluate(`const el = document.querySelector('#history-search-input'); el.value = '历史引用'; el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`);
  await wait(`document.querySelector('#search-results').textContent.includes('历史引用')`);
  await evaluate('window.releaseSearch()');
  await sleep(150);
  check('旧搜索晚返回不会覆盖新关键词结果', await evaluate(`document.querySelector('#search-results').textContent.includes('历史引用') && !document.querySelector('#search-results').textContent.includes('历史原文')`));
  await send('Page.reload');
  await wait(`document.querySelectorAll('.conv-item').length >= 2`);
  await evaluate(`(async () => {
    const { api } = await import('/js/lib/api.js');
    const original = api.group;
    api.group = async (...args) => { const result = await original(...args); window.groupPaused = true; await new Promise(r => window.releaseGroup = r); return result; };
  })()`);
  await open(groupId);
  await wait('window.groupPaused');
  await open(helper.convId);
  const subtitle = await evaluate(`document.querySelector('#chat-subtitle').textContent`);
  await evaluate('window.releaseGroup()');
  await sleep(150);
  check('旧群资料请求不能覆盖当前单聊标题', await evaluate(`document.querySelector('#chat-subtitle').textContent`) === subtitle);
  await evaluate(`(async () => {
    const { api } = await import('/js/lib/api.js');
    const original = api.messages;
    api.messages = async (...args) => {
      const result = await original(...args);
      if (args[0] === ${JSON.stringify(helper.convId)} && !window.historyPaused) {
        window.historyPaused = true; await new Promise(r => window.releaseHistory = r);
      }
      return result;
    };
  })()`);
  await click(selector(helper.convId));
  await wait('window.historyPaused');
  await input('历史请求等待期间发送');
  await click('#btn-send');
  await wait(`document.querySelector('#msg-list').textContent.includes('历史请求等待期间发送')`);
  await evaluate('window.releaseHistory()');
  await sleep(150);
  check('历史响应不覆盖加载期间发送的消息', await evaluate(`document.querySelector('#msg-list').textContent.includes('历史请求等待期间发送')`));
  const safe = await evaluate(`(async () => {
    const { avatarHtml, renderMarkdown } = await import('/js/lib/util.js');
    const el = document.createElement('div');
    el.innerHTML = avatarHtml({ avatar: '/uploads/a\" onmouseover=\"window.injected=9', nickname: 'x' })
      + renderMarkdown('[链接](https://example.com/**x**) 和 ' + String.fromCharCode(96) + 'https://example.com' + String.fromCharCode(96));
    return !el.querySelector('[onmouseover]') && el.querySelectorAll('a').length === 1
      && el.querySelector('a').getAttribute('href') === 'https://example.com/**x**'
      && el.querySelector('code').textContent === 'https://example.com';
  })()`);
  check('头像属性安全，Markdown 不改写链接属性或代码', safe);
  await click('#btn-logout');
  await wait(`!localStorage.getItem('sc_token') && document.querySelector('#login-view').checkVisibility()`);
  check('退出登录清除本账号标签页草稿', await evaluate(`!Object.keys(sessionStorage).some(k => k.startsWith('sc_draft_v1:${login.user.id}:'))`));
  check('会话回归无未捕获异常', browser.errors.length === 0);
  console.log('浏览器会话回归: ' + passed + ' 通过');
} finally {
  await browser.close();
}
