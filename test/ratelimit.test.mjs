'use strict';

/**
 * 登录/注册限流回归：createLimiter 单元测试（时钟注入）+ HTTP 集成（自启隔离服务，
 * 会故意触发限流，所以不能跑在 run-isolated 的共享服务上）。
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
import { createLimiter } from '../server/rate-limit.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const srv = net.createServer();
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise(resolve => srv.close(resolve));
  return port;
}

/** 启动临时 Sakura-Chat 服务（隔离端口与数据目录） */
async function startChat() {
  const port = await freePort();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sakura-rl-'));
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('OAUTH_') && k !== 'APP_BASE_URL')
  );
  const env = {
    ...baseEnv, PORT: String(port), SAKURA_DATA_DIR: dataDir,
    SSL_KEY_PATH: '', SSL_CERT_PATH: '', JWT_SECRET: 'ratelimit-test-' + port,
  };
  const child = spawn(process.execPath, [path.join(root, 'server/index.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', c => { log += c; });
  child.stderr.on('data', c => { log += c; });
  const origin = 'http://127.0.0.1:' + port;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('限流测试服务提前退出:\n' + log);
    try { if ((await fetch(origin + '/api/health')).ok) { ready = true; break; } } catch (_) {}
    await sleep(100);
  }
  if (!ready) throw new Error('限流测试服务启动超时:\n' + log);
  return {
    origin,
    stop: async () => {
      if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
      await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

async function post(url, body, headers) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

test('createLimiter：阈值、锁定窗口、过期自动解锁（注入时钟）', () => {
  let t = 1_000_000;
  const clock = () => t;
  const lim = createLimiter({ maxFails: 3, lockSec: 60, clock });
  assert.equal(lim.tooMany('k'), false);
  lim.hit('k'); lim.hit('k');
  assert.equal(lim.tooMany('k'), false, '未达阈值不锁定');
  lim.hit('k');
  assert.equal(lim.tooMany('k'), true, '达到阈值锁定');

  // 窗口内继续命中不续期（避免被持续刷就持续锁）
  t += 30 * 1000;
  lim.hit('k');
  assert.equal(lim.tooMany('k'), true);

  // 窗口过期自动放行，新一轮从 1 次开始
  t += 31 * 1000;
  assert.equal(lim.tooMany('k'), false);
  lim.hit('k');
  assert.equal(lim.tooMany('k'), false, '新窗口重新计数');

  lim.clear('k');
  assert.equal(lim.tooMany('k'), false);
});

test('createLimiter：键互相隔离，Map 有硬上限', () => {
  let t = 0;
  const lim = createLimiter({ maxFails: 2, lockSec: 60, maxKeys: 50, clock: () => t });
  lim.hit('a'); lim.hit('a');
  assert.equal(lim.tooMany('a'), true);
  assert.equal(lim.tooMany('b'), false, '不同键独立计数');
  for (let i = 0; i < 500; i++) lim.hit('burst-' + i);
  assert.ok(lim.size <= 50, '硬上限防止内存无限增长: ' + lim.size);
  // 突发流量下旧键可能被逐出（提前解锁），这是内存保护下的有意取舍；
  // 但新键自身的锁定状态必须准确。
  lim.hit('burst-499'); lim.hit('burst-499');
  assert.equal(lim.tooMany('burst-499'), true, '新键的锁定状态准确');
});

test('HTTP 集成：登录失败锁定与注册限频', async t => {
  const chat = await startChat();
  try {
    await t.test('连续 5 次密码错误后锁定，锁定期内正确密码也被拒绝', async () => {
      await post(chat.origin + '/api/auth/register', { username: 'rl_alice', password: 'pass1234' });
      for (let i = 0; i < 5; i++) {
        const r = await post(chat.origin + '/api/auth/login', { username: 'rl_alice', password: 'wrongpw' });
        assert.equal(r.status, 401);
      }
      const wrongAgain = await post(chat.origin + '/api/auth/login', { username: 'rl_alice', password: 'wrongpw' });
      assert.equal(wrongAgain.status, 429);
      assert.ok(wrongAgain.data.error);
      const correct = await post(chat.origin + '/api/auth/login', { username: 'rl_alice', password: 'pass1234' });
      assert.equal(correct.status, 429, '锁定窗口内即使密码正确也拒绝');
    });

    await t.test('计数按 ip+用户名隔离：另一账号不受牵连', async () => {
      await post(chat.origin + '/api/auth/register', { username: 'rl_bob', password: 'pass1234' });
      const wrong = await post(chat.origin + '/api/auth/login', { username: 'rl_bob', password: 'badpass' });
      assert.equal(wrong.status, 401, '另一账号的失败仍按 401 处理');
      const ok = await post(chat.origin + '/api/auth/login', { username: 'rl_bob', password: 'pass1234' });
      assert.equal(ok.status, 200);
    });

    await t.test('成功登录清零失败计数，不累积历史失败', async () => {
      await post(chat.origin + '/api/auth/register', { username: 'rl_carol', password: 'pass1234' });
      for (let i = 0; i < 4; i++) {
        const r = await post(chat.origin + '/api/auth/login', { username: 'rl_carol', password: 'badpass' });
        assert.equal(r.status, 401);
      }
      const ok = await post(chat.origin + '/api/auth/login', { username: 'rl_carol', password: 'pass1234' });
      assert.equal(ok.status, 200);
      for (let i = 0; i < 5; i++) {
        const r = await post(chat.origin + '/api/auth/login', { username: 'rl_carol', password: 'badpass' });
        assert.equal(r.status, 401, '清零后又能失败 5 次而不被锁');
      }
      const locked = await post(chat.origin + '/api/auth/login', { username: 'rl_carol', password: 'badpass' });
      assert.equal(locked.status, 429, '第 6 次失败才锁定');
    });

    await t.test('注册限频：独立 IP（X-Forwarded-For）10 次后拒绝', async () => {
      const fwd = { 'X-Forwarded-For': '10.1.2.3' };
      for (let i = 0; i < 10; i++) {
        const r = await post(chat.origin + '/api/auth/register', { username: 'rl_reg_' + i, password: 'pass1234' }, fwd);
        assert.equal(r.status, 200);
      }
      const blocked = await post(chat.origin + '/api/auth/register', { username: 'rl_reg_x', password: 'pass1234' }, fwd);
      assert.equal(blocked.status, 429);
      // 另一个 IP 的配额独立
      const other = await post(chat.origin + '/api/auth/register', { username: 'rl_reg_y', password: 'pass1234' }, { 'X-Forwarded-For': '10.9.9.9' });
      assert.equal(other.status, 200);
    });

    await t.test('限流不影响健康检查等公开接口', async () => {
      const r = await fetch(chat.origin + '/api/health');
      assert.equal(r.status, 200);
      const providers = await fetch(chat.origin + '/api/auth/providers');
      assert.equal(providers.status, 200);
    });
  } finally {
    await chat.stop();
  }
});
