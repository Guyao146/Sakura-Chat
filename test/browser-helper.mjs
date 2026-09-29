import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function launchBrowser() {
  const candidates = [process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  let exe;
  for (const candidate of candidates.filter(Boolean)) {
    try { await access(candidate); exe = candidate; break; } catch (_) {}
  }
  if (!exe) throw new Error('找不到 Chrome/Edge，请设置 CHROME_PATH');
  const profile = await mkdtemp(path.join(tmpdir(), 'sakura-chrome-'));
  const child = spawn(exe, ['--headless=new', '--remote-debugging-port=0', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let socket;
  const close = async () => {
    socket?.close();
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  };
  try {
    let port;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error('浏览器提前退出');
      try { port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch (_) {}
      if (port) break;
      await sleep(100);
    }
    if (!port) throw new Error('Chrome 调试端口启动超时');
    const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await once(socket, 'open');
    let seq = 0;
    const pending = new Map(), errors = [];
    socket.on('message', raw => {
      const message = JSON.parse(raw);
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
      if (!message.id) return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 10000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const wait = async (expression, timeout = 10000) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (await evaluate(expression)) return;
        await sleep(50);
      }
      throw new Error('等待浏览器条件超时: ' + expression);
    };
    const point = selector => evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el || !el.checkVisibility()) throw new Error('元素不可见: ' + ${JSON.stringify(selector)});
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    const mouse = (type, p, extra = {}) => send('Input.dispatchMouseEvent', { type, ...p, ...extra });
    const click = async (selector, count = 1) => {
      const p = await point(selector);
      for (let n = 1; n <= count; n++) {
        await mouse('mousePressed', p, { button: 'left', buttons: 1, clickCount: n });
        await mouse('mouseReleased', p, { button: 'left', buttons: 0, clickCount: n });
      }
    };
    const drag = async (selector, dx, dy) => {
      const p = await point(selector);
      await mouse('mousePressed', p, { button: 'left', buttons: 1, clickCount: 1 });
      const end = { x: p.x + dx, y: p.y + dy };
      await mouse('mouseMoved', end, { button: 'left', buttons: 1 });
      await mouse('mouseReleased', end, { button: 'left', buttons: 0, clickCount: 1 });
    };
    await send('Runtime.enable');
    await send('Page.enable');
    return { send, evaluate, wait, click, drag, point, mouse, close, errors };
  } catch (e) { await close(); throw e; }
}
