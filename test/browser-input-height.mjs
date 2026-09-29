// 真实 Chrome CDP 输入事件；不直接调用应用内部函数，不把隐藏元素当有效布局。
import assert from 'node:assert/strict';
import { launchBrowser, sleep } from './browser-helper.mjs';
const host = process.env.HOST || 'http://127.0.0.1:3130';
let passed = 0;
function check(name, condition) { assert.ok(condition, name); console.log('  [PASS] ' + name); passed++; }
async function api(method, route, body, token) {
  const res = await fetch(host + '/api' + route, { method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  assert.ok(res.ok, route + ': ' + res.status);
  return res.json();
}
const username = 'ui_' + Date.now();
await api('POST', '/auth/register', { username, password: 'pass1234' });
const login = await api('POST', '/auth/login', { username, password: 'pass1234' });
const browser = await launchBrowser();
const { send, evaluate, wait, click, drag, point, mouse } = browser;
const size = async (width, height) => {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await sleep(250);
};
const layout = () => evaluate(`(() => {
  const input = document.querySelector('#msg-input'), main = document.querySelector('#chat-main');
  const area = document.querySelector('.input-area'), list = document.querySelector('#msg-list');
  return { h: input.getBoundingClientRect().height, list: list.clientHeight,
    visible: input.checkVisibility(), bottom: area.getBoundingClientRect().bottom,
    max: getComputedStyle(input).maxHeight, resize: getComputedStyle(input).resize,
    area: area.offsetHeight, anchor: parseFloat(main.style.getPropertyValue('--input-area-h')),
    sidebar: document.querySelector('.sidebar').getBoundingClientRect().width,
    sidebarShown: document.body.classList.contains('show-sidebar'),
    saved: localStorage.getItem('sakura-input-height-v2'),
    dragging: !!document.querySelector('.input-resizer.dragging'),
    cursor: document.body.style.cursor, select: document.body.style.userSelect };
})()`);
const text = async value => {
  await evaluate(`document.querySelector('#msg-input').value = ''`);
  await click('#msg-input');
  if (value) await send('Input.insertText', { text: value });
  else await evaluate(`document.querySelector('#msg-input').dispatchEvent(new Event('input', { bubbles: true }))`);
};
const openHelper = async () => {
  await wait(`!!document.querySelector('.conv-item')`);
  await click('.conv-item');
  await wait(`document.querySelector('#msg-input').checkVisibility() && !document.querySelector('.skel-wrap')`);
  await sleep(200);
};
try {
  await size(1200, 800);
  await send('Page.navigate', { url: host });
  await wait(`location.origin === ${JSON.stringify(host)} && document.readyState === 'complete'`);
  await evaluate(`localStorage.clear(); localStorage.setItem('sc_token', ${JSON.stringify(login.token)}); localStorage.setItem('sc_sidebar_width', '340px');`);
  await send('Page.reload');
  await openHelper();
  let l = await layout();
  check('可见聊天输入框默认单行 40px', l.visible && Math.abs(l.h - 40) < 1);
  check('CSS max-height 被正确解析', l.max === '580px' && l.resize === 'none');
  check('兼容旧版带 px 的侧边栏宽度记忆', l.sidebar === 340);
  await drag('#input-resizer', 0, -100);
  l = await layout();
  check('真实鼠标向上拖大且记忆高度', Math.abs(l.h - 140) < 1 && Number(l.saved) === 140);
  check('拖完释放状态与光标', !l.dragging && l.cursor === '' && l.select === '');
  check('面板锚定实际输入区高度', l.anchor === l.area + 6);
  await drag('#input-resizer', 0, 50);
  check('真实鼠标向下拖小', Math.abs((await layout()).h - 90) < 1);
  await click('#input-resizer', 2);
  l = await layout();
  check('真实鼠标双击复位且清除记忆', Math.abs(l.h - 40) < 1 && l.saved === null);
  await text(Array(10).fill('长文本回归').join('\n'));
  const expanded = (await layout()).h;
  check('长文本自动长高', expanded > 180);
  await drag('#input-resizer', 0, -10);
  check('长文本从实际高度起拖不跳回基准', Math.abs((await layout()).h - expanded - 10) < 1);
  await drag('#input-resizer', 0, 40);
  check('长文本可手动缩小并在内部滚动', Math.abs((await layout()).h - expanded + 30) < 1);
  await text('');
  await click('#input-resizer', 2);
  const p = await point('#input-resizer');
  await mouse('mousePressed', p, { button: 'right', buttons: 2 });
  await mouse('mouseMoved', { x: p.x, y: p.y - 50 }, { buttons: 2 });
  await mouse('mouseReleased', p, { button: 'right', buttons: 0 });
  check('右键不能启动拖拽', (await layout()).h === 40 && !(await layout()).dragging);
  await mouse('mousePressed', p, { button: 'left', buttons: 1, clickCount: 1 });
  await mouse('mouseMoved', { x: p.x, y: p.y - 50 }, { buttons: 1 });
  await evaluate(`window.dispatchEvent(new Event('blur'))`);
  await mouse('mouseReleased', p, { button: 'left', buttons: 0 });
  check('失焦取消拖拽并恢复选择状态', !(await layout()).dragging && (await layout()).select === '');
  await drag('#sidebar-resizer', 30, 0);
  check('侧边栏拖动并存为数值', (await layout()).sidebar === 370 && await evaluate(`localStorage.getItem('sc_sidebar_width') === '370'`));
  await send('Page.reload');
  await openHelper();
  check('刷新恢复输入框与侧边栏尺寸', (await layout()).h === 90 && (await layout()).sidebar === 370);
  await evaluate(`localStorage.setItem('sakura-input-height-v2', '99999')`);
  await send('Page.reload');
  await openHelper();
  l = await layout();
  check('脏的大高度值被钳制', l.h <= 480 && l.list >= 120 && l.bottom <= 800);
  await size(1200, 400);
  l = await layout();
  check('缩短视口后仍保留消息区且不溢出', l.list >= 120 && l.bottom <= 400);
  await size(1200, 800);
  check('恢复视口重新按持久化偏好计算', (await layout()).h === 480);
  await click('#input-resizer', 2);
  await size(900, 800);
  check('跨移动断点保留当前聊天', (await layout()).visible && !(await layout()).sidebarShown);
  await size(900, 450);
  check('窄屏高度变化不返回会话列表', (await layout()).visible && !(await layout()).sidebarShown);
  await click('#btn-back');
  await size(900, 600);
  check('用户手动返回列表后高度变化保留列表', (await layout()).sidebarShown);
  await openHelper();
  await size(1200, 800);
  await text('浏览器实际发送验证');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await wait(`document.querySelector('#msg-input').value === '' && document.querySelector('#msg-list').textContent.includes('浏览器实际发送验证')`);
  check('真实 Enter 发送后输入框回单行', (await layout()).h === 40);
  check('没有前端未捕获异常', browser.errors.length === 0);
  console.log('浏览器布局回归: ' + passed + ' 通过');
} finally {
  await browser.close();
}
