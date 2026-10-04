'use strict';

/**
 * 安全回归：上传静态资源防护
 * - SVG 可内嵌 <script>，顶层导航到 /uploads/x.svg 会同源执行脚本（可窃取 localStorage token），
 *   服务端强制 Content-Disposition: attachment 使浏览器下载而非渲染；<img> 标签加载不受影响。
 * - 全局 X-Content-Type-Options: nosniff 禁止内容类型嗅探。
 * 自启隔离服务（与 ratelimit.test.mjs 同样的模式）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const srv = net.createServer();
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise(resolve => srv.close(resolve));
  return port;
}

async function startChat() {
  const port = await freePort();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sakura-sec-'));
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('OAUTH_') && k !== 'APP_BASE_URL')
  );
  const env = {
    ...baseEnv, PORT: String(port), SAKURA_DATA_DIR: dataDir,
    SSL_KEY_PATH: '', SSL_CERT_PATH: '', JWT_SECRET: 'security-test-' + port,
  };
  const child = spawn(process.execPath, [path.join(root, 'server/index.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', c => { log += c; });
  child.stderr.on('data', c => { log += c; });
  const origin = 'http://127.0.0.1:' + port;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('安全测试服务提前退出:\n' + log);
    try { if ((await fetch(origin + '/api/health')).ok) { ready = true; break; } } catch (_) {}
    await sleep(100);
  }
  if (!ready) throw new Error('安全测试服务启动超时:\n' + log);
  return {
    origin,
    stop: async () => {
      if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
      await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

async function post(url, body, token) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

// 含 <script> 的恶意 SVG：请求应成功（白名单保留 SVG），但静态响应强制附件下载
const EVIL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>fetch("/api/auth/me")</script></svg>';
const evilSvgData = 'data:image/svg+xml;base64,' + Buffer.from(EVIL_SVG).toString('base64');
const pngPixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

test('上传资源安全：SVG 强制附件下载 + nosniff 头', async () => {
  const chat = await startChat();
  try {
    const user = 'sec_' + Date.now();
    await post(chat.origin + '/api/auth/register', { username: user, password: 'pass1234' });
    const login = await post(chat.origin + '/api/auth/login', { username: user, password: 'pass1234' });
    assert.equal(login.status, 200);
    const token = login.data.token;

    const svg = await post(chat.origin + '/api/upload', { data: evilSvgData, filename: 'evil.svg' }, token);
    assert.equal(svg.status, 200, 'SVG 上传本身不被拒绝（头像/图片消息仍可用 <img> 加载）');
    assert.ok(svg.data.url.startsWith('/uploads/'));

    const res = await fetch(chat.origin + svg.data.url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/svg+xml');
    assert.equal(res.headers.get('content-disposition'), 'attachment', 'SVG 必须强制附件下载，阻断同源脚本执行');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

    // express.static 会解码路径，防护不能只匹配原始 req.path。
    for (const url of [svg.data.url.replace('.svg', '%2Esvg'), svg.data.url.replace('.svg', '.%73vg'),
      svg.data.url.replace('/uploads/', '/%75ploads/')]) {
      const encoded = await fetch(chat.origin + url);
      assert.equal(encoded.status, 200);
      assert.equal(encoded.headers.get('content-disposition'), 'attachment', url);
      await encoded.arrayBuffer();
    }

    const png = await post(chat.origin + '/api/upload', { data: pngPixel, filename: 'dot.png' }, token);
    assert.equal(png.status, 200);
    const pngRes = await fetch(chat.origin + png.data.url);
    assert.equal(pngRes.status, 200);
    assert.equal(pngRes.headers.get('content-disposition'), null, '普通图片正常内联展示');

    const htmlRes = await fetch(chat.origin + '/index.html');
    assert.equal(htmlRes.headers.get('x-content-type-options'), 'nosniff', '全局 nosniff 头');
  } finally {
    await chat.stop();
  }
});

test('非法上传文件名返回 400 而不是导致服务退出', async () => {
  const chat = await startChat();
  try {
    await post(chat.origin + '/api/auth/register', { username: 'bad_upload', password: 'pass1234' });
    const login = await post(chat.origin + '/api/auth/login', { username: 'bad_upload', password: 'pass1234' });
    for (const filename of [{ name: 'test.png' }, ['test.png'], 42]) {
      const res = await post(chat.origin + '/api/upload', { data: pngPixel, filename }, login.data.token);
      assert.equal(res.status, 400);
      assert.equal((await fetch(chat.origin + '/api/health')).status, 200);
    }
  } finally { await chat.stop(); }
});

test('群资料越权：非成员读取群成员名单被拒绝', async () => {
  const chat = await startChat();
  try {
    const base = 'grp_' + Date.now();
    const mk = async name => {
      await post(chat.origin + '/api/auth/register', { username: name, password: 'pass1234' });
      const r = await post(chat.origin + '/api/auth/login', { username: name, password: 'pass1234' });
      return r.data;
    };
    const a = await mk(base + '_a'), b = await mk(base + '_b'), c = await mk(base + '_b2'), d = await mk(base + '_d');
    const res = await fetch(chat.origin + '/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + a.token },
      body: JSON.stringify({ name: '测试群', memberIds: [b.user.id, c.user.id] }),
    });
    assert.equal(res.status, 200);
    const { group } = await res.json();

    // 成员可读
    const okRes = await fetch(chat.origin + '/api/groups/' + group.id, {
      headers: { Authorization: 'Bearer ' + a.token },
    });
    assert.equal(okRes.status, 200);
    assert.ok((await okRes.json()).group.members.length >= 3);

    // 非成员被拒（曾经返回完整成员名单）
    const badRes = await fetch(chat.origin + '/api/groups/' + group.id, {
      headers: { Authorization: 'Bearer ' + d.token },
    });
    assert.equal(badRes.status, 403);
  } finally {
    await chat.stop();
  }
});
