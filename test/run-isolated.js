'use strict';

// 独立端口 + 临时数据库，仅关闭本脚本创建的服务。可加 --browser 运行 Chrome 回归。
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const root = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run(script, env) {
  const child = spawn(process.execPath, [path.join(__dirname, script)], { cwd: root, env, stdio: 'inherit' });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(script + ' failed: ' + code);
}

(async () => {
  const port = Number(process.env.TEST_PORT || 3130);
  // 检查占用而非杀掉已有服务。
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, resolve); });
  await new Promise(resolve => probe.close(resolve));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sakura-test-'));
  const env = { ...process.env, PORT: String(port), HOST: 'http://127.0.0.1:' + port,
    SAKURA_DATA_DIR: dataDir, SSL_KEY_PATH: '', SSL_CERT_PATH: '', JWT_SECRET: 'isolated-test-only' };
  const server = spawn(process.execPath, [path.join(root, 'server/index.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', chunk => { log += chunk; });
  server.stderr.on('data', chunk => { log += chunk; });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error('测试服务提前退出');
      try { ready = (await fetch(env.HOST + '/api/health')).ok; } catch (_) {}
      if (ready) break;
      await sleep(100);
    }
    if (!ready) throw new Error('测试服务启动超时');
    await run('drafts.test.mjs', env);
    await run('media-lifecycle.test.mjs', env);
    await run('client-performance.test.mjs', env);
    await run('server-performance.test.mjs', env);
    await run('oauth.test.mjs', env);   // 自带 Mock IdP 与独立实例，不依赖上面的端口
    await run('ratelimit.test.mjs', env);   // 自启独立实例：会故意触发限流，不能跑在共享服务上
    // 与真实 Sakura-Auth-Server 联调（同级目录不存在时自动跳过，CI 安全）
    await run('../tools/oauth-sakuraid-smoke.mjs', env);
    await run('e2e.js', env);
    if (process.argv.includes('--browser')) {
      await run('browser-login.mjs', env);
      await run('browser-input-height.mjs', env);
      await run('browser-chat.mjs', env);
      await run('browser-media.mjs', env);
      await run('browser-performance.mjs', env);
    }
  } catch (e) {
    console.error(log);
    throw e;
  } finally {
    if (server.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
