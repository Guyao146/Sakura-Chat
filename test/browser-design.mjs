// 视觉与动效回归：真实 Chrome，静态测试页 + 仅测试服务器暴露的渲染入口。
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { launchBrowser, sleep } from './browser-helper.mjs';

const root = fileURLToPath(new URL('../public/', import.meta.url));
const html = (await readFile(path.join(root, 'index.html'), 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const source = await readFile(path.join(root, 'js/app.js'), 'utf8');
const app = express();
app.get('/', (req, res) => res.type('html').send(html));
app.get('/js/app.js', (req, res) => res.type('js').send(source + '\nexport { state, renderMessages, renderConvList };'));
app.use(express.static(root));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
let browser, passed = 0;
const check = (name, ok) => { assert.ok(ok, name); console.log('  [PASS] ' + name); passed++; };
try {
  browser = await launchBrowser();
  const { send, evaluate, wait, click } = browser;
  const size = async (width, height) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await sleep(350);
  };
  const capture = async name => {
    if (!process.env.UI_SCREENSHOT_DIR) return;
    const dir = path.resolve(process.env.UI_SCREENSHOT_DIR);
    await mkdir(dir, { recursive: true });
    await sleep(700);
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(dir, name + '.png'), Buffer.from(data, 'base64'));
  };
  await size(1280, 800);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port });
  await wait("document.readyState === 'complete'");
  await evaluate(`(async () => {
    window.ui = await import('/js/lib/util.js');
    window.bench = await import('/js/app.js');
    const { api } = await import('/js/lib/api.js'); window.api = api;
    api.providers = async () => ({ providers: [] });
    const { initLogin } = await import('/js/login.js'); initLogin(() => {});
  })()`);
  check('主题样式已加载，花瓣有有限入场动画', await evaluate(`(() => {
    const s = getComputedStyle(document.querySelector('.brand-petals i'));
    return s.animationName === 'petal-arrive' && s.animationIterationCount === '1'
      && getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() === '#8950b5';
  })()`));
  await capture('login-desktop');
  await click('#tab-register');
  await sleep(350);
  check('注册滑块位移且同步可访问状态', await evaluate(`(() => {
    const tabs = document.querySelector('.login-tabs');
    return tabs.dataset.active === 'register' && document.querySelector('#tab-register').getAttribute('aria-pressed') === 'true'
      && document.querySelector('#form-register').checkVisibility()
      && new DOMMatrixReadOnly(getComputedStyle(tabs, '::before').transform).m41 > 0;
  })()`));
  await evaluate(`(() => {
    api.register = () => new Promise(resolve => window.finishRegister = resolve);
    document.querySelector('#reg-username').value = 'motion_test';
    document.querySelector('#reg-password').value = 'pass1234';
    document.querySelector('#form-register').requestSubmit();
  })()`);
  check('提交中显示忙碌状态且禁止重复点击', await evaluate(`(() => {
    const b = document.querySelector('#form-register button');
    return b.disabled && b.getAttribute('aria-busy') === 'true' && getComputedStyle(b, '::before').animationName === 'spin';
  })()`));
  await evaluate('finishRegister({})');
  await wait("!document.querySelector('#form-register button').disabled");
  check('成功后恢复按钮和登录滑块', await evaluate(`document.querySelector('.login-tabs').dataset.active === 'login'
    && !document.querySelector('#form-register button').hasAttribute('aria-busy')`));
  await evaluate(`(async () => {
    api.login = async () => { throw new Error('测试登录失败'); };
    document.querySelector('#form-login').requestSubmit();
    await new Promise(resolve => setTimeout(resolve, 0));
  })()`);
  check('失败后恢复按钮且错误信息可见', await evaluate(`!document.querySelector('#form-login button').disabled
    && !document.querySelector('#form-login button').hasAttribute('aria-busy')
    && document.querySelector('#login-error').textContent === '测试登录失败'`));
  await evaluate(`document.querySelector('#login-error').textContent = ''; document.querySelector('#toast-wrap').replaceChildren()`);
  await size(390, 844);
  await capture('login-mobile');
  check('移动端登录卡片无水平溢出', await evaluate(`document.documentElement.scrollWidth === innerWidth
    && !document.querySelector('.brand-panel').checkVisibility()
    && document.querySelector('.login-card').getBoundingClientRect().right <= innerWidth`));

  await evaluate(`(() => {
    bench.state.me = { id: 1, nickname: '小樱' };
    const conv = { convId: 'u_1_2', convType: 'single', peer: { id: 2, nickname: '春日来信' }, unread: 2 };
    bench.state.conversations = [conv]; bench.state.convMap.set(conv.convId, conv); bench.state.activeConvId = conv.convId;
    bench.state.users.set(2, conv.peer);
    const messages = Array.from({ length: 3 }, (_, i) => ({ id: i + 1, msgId: 'design_' + i, convId: conv.convId,
      convType: 'single', senderId: i % 2 ? 1 : 2, kind: 'text', content: { text: ['今天的晚霞很漂亮，想分享给你 🌸', '收到！把这些小美好都收藏起来。', '周末一起去看看樱花吧。'][i] }, createdAt: 1700000000000 + i * 1000, status: 'read' }));
    bench.state.messages.set(conv.convId, messages);
    document.querySelector('#login-view').hidden = true; document.querySelector('#app-view').hidden = false;
    document.querySelector('#my-nickname').textContent = '小樱'; document.querySelector('#my-signature').textContent = '记录生活的小美好';
    document.querySelector('#my-avatar').textContent = '樱'; document.querySelector('#my-avatar').style.background = '#ba7ab8';
    document.querySelector('#chat-title').textContent = '春日来信'; document.querySelector('#chat-subtitle').textContent = '在线';
    bench.renderConvList();
  })()`);
  await size(1280, 800);
  await capture('empty-desktop');
  await evaluate(`document.querySelector('#chat-empty').hidden = true; document.querySelector('#chat-main').hidden = false; bench.renderMessages()`);
  check('历史消息与时间标签不播放入场动画', await evaluate(`Array.from(document.querySelectorAll('.msg-row, .msg-time')).every(e => getComputedStyle(e).animationName === 'none')`));
  check('未读角标不循环跳动', await evaluate(`getComputedStyle(document.querySelector('.conv-unread')).animationName === 'none'`));
  await capture('chat-desktop');
  check('只对新追加消息播放动画，保留旧 DOM', await evaluate(`(() => {
    const first = document.querySelector('.msg-row');
    const list = bench.state.messages.get('u_1_2');
    list.push({ ...list[1], id: 4, msgId: 'design_new', content: { text: '好呀，周末见！' } }); bench.renderMessages(false, true);
    return first.isConnected && document.querySelectorAll('.msg-in').length === 1
      && getComputedStyle(document.querySelector('.msg-in')).animationName === 'message-enter';
  })()`));
  await sleep(350);
  check('消息动画结束不保留 transform 合成层', await evaluate(`getComputedStyle(document.querySelector('.msg-in')).transform === 'none'`));
  await evaluate(`ui.openModal('<div class="modal-header">一点小美好</div><div class="modal-body"><input class="modal-input" aria-label="昵称" placeholder="你的昵称"><button class="modal-btn">保存</button></div>')`);
  check('弹窗使用轻量展开动画', await evaluate(`getComputedStyle(document.querySelector('#modal-box')).animationName === 'panel-enter'`));
  await capture('modal-desktop');
  await evaluate('ui.closeModal()');
  await wait("!document.querySelector('#modal-mask').checkVisibility()");
  await evaluate(`ui.openModal('<div class="modal-body">重新打开</div>')`);
  check('关闭再打开后动画重新触发', await evaluate(`document.querySelector('#modal-box').getAnimations().length > 0`));
  await evaluate('ui.closeModal(); ui.toast("退出动效", 400)');
  await sleep(460);
  check('Toast 退出透明度不被入场动画锁住', await evaluate(`getComputedStyle(document.querySelector('.toast')).opacity < 1`));
  await wait("!document.querySelector('.toast')");
  for (const width of [390, 320]) {
    await size(width, 700);
    check(width + 'px 输入区和工具按钮无横向溢出', await evaluate(`(() => {
      const input = document.querySelector('#msg-input').getBoundingClientRect();
      const send = document.querySelector('#btn-send').getBoundingClientRect();
      const row = document.querySelector('.input-row');
      return input.width > innerWidth - 40 && send.right <= innerWidth && send.top >= input.bottom
        && row.scrollWidth <= row.clientWidth && document.documentElement.scrollWidth === innerWidth;
    })()`));
  }
  await size(390, 844);
  await capture('chat-mobile');
  await evaluate(`document.querySelector('#emoji-panel').hidden = false`);
  check('手机表情面板未超出屏幕', await evaluate(`document.querySelector('#emoji-panel').getBoundingClientRect().right <= innerWidth`));
  await evaluate(`document.querySelector('#emoji-panel').hidden = true; document.body.classList.add('show-sidebar')`);
  await sleep(350);
  check('手机会话列表占满屏幕', await evaluate(`document.querySelector('.sidebar').getBoundingClientRect().width === innerWidth`));
  await capture('sidebar-mobile');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await evaluate(`document.body.classList.remove('show-sidebar'); ui.openModal('<div class="modal-body">减少动态效果</div>'); ui.toast('提示仍然可见')`);
  check('减少动态效果关闭新旧动画及伪元素动画', await evaluate(`Array.from(document.querySelectorAll('*')).every(e =>
    [null, '::before', '::after'].every(p => {
      const s = getComputedStyle(e, p); return s.animationName === 'none' && s.transitionDuration === '0s';
    }))`));
  check('减少动态效果时弹窗仍可见可关闭', await evaluate(`(() => {
    const visible = document.querySelector('#modal-box').checkVisibility() && getComputedStyle(document.querySelector('#modal-box')).opacity === '1';
    ui.closeModal(); return visible && !document.querySelector('#modal-mask').checkVisibility();
  })()`));
  await evaluate(`document.querySelector('#app-view').hidden = true; document.querySelector('#login-view').hidden = false`);
  await click('#tab-register');
  check('减少动态效果仍即时更新滑块选中位置', await evaluate(`new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.login-tabs'), '::before').transform).m41 > 0
    && document.querySelector('#form-register').checkVisibility()`));
  check('图标引用完整且所有图标按钮有可访问名称', await evaluate(`Array.from(document.querySelectorAll('.ui-icon use')).every(e =>
    !!document.querySelector(e.getAttribute('href')) && (!e.closest('button') || e.closest('button').getAttribute('aria-label') || e.closest('button').textContent.trim()))`));
  check('视觉回归无浏览器未捕获异常', browser.errors.length === 0);
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
console.log('浏览器视觉回归: ' + passed + ' 通过');
