'use strict';

/**
 * 与真实 Sakura-Auth-Server（SakuraID）联调
 *
 * 流程：给临时数据目录的 SakuraID 播种（站点设置 + 普通用户 + 公开客户端）→
 * 启动 IdP → 启动接入了 OAUTH_SAKURA_* 的 Sakura-Chat → 浏览器授权码 + PKCE 全流程。
 * 这个工具验证的是「对接真实标准 IdP」的兼容性（Mock IdP 覆盖不到 RS256 令牌、
 * 真实发现文档、真实 userinfo 验签等细节）。
 *
 * 运行：node tools/oauth-sakuraid-smoke.mjs
 * 前提：同级目录存在 ../Sakura-Auth-Server；不存在时输出 SKIP 并以 0 退出（可在 CI 中无条件执行）。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const chatRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const idpRoot = path.resolve(chatRoot, '..', 'Sakura-Auth-Server');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let pass = 0;
const check = (name, ok) => {
  if (!ok) { console.error('  [FAIL] ' + name); process.exitCode = 1; return; }
  console.log('  [PASS] ' + name);
  pass++;
};

/** 不跟随重定向、可带请求体与 Cookie 的 HTTP 客户端 */
function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** 极简 Cookie Jar：收集 Set-Cookie 回写请求头 */
class Jar {
  constructor() { this.map = new Map(); }
  capture(res) {
    const sc = res.headers['set-cookie'];
    if (!sc) return;
    for (const c of (Array.isArray(sc) ? sc : [sc])) {
      const m = /^([^=;]+)=([^;]*)/.exec(c);
      if (m) this.map.set(m[1].trim(), m[2]);
    }
  }
  header() { return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
}

async function freePort() {
  const srv = net.createServer();
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise(resolve => srv.close(resolve));
  return port;
}

/** 等待服务就绪（起不来则打印日志并失败） */
async function waitReady(healthUrl, child, logFn) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) { console.error(logFn()); throw new Error('服务提前退出（exit ' + child.exitCode + '）'); }
    try { if ((await request(healthUrl)).status === 200) return; } catch (_) {}
    await sleep(100);
  }
  console.error(logFn());
  throw new Error('服务启动超时: ' + healthUrl);
}

/**
 * 用 SakuraID 自身的模块直接播种临时数据库（跳过 Web 配置向导）：
 * 站点设置 + 一个普通用户 + 一个公开客户端（PKCE，免密钥）。
 */
async function seedIdp(dataDir, { issuer, redirectUri, username, password, name }) {
  process.env.DATA_DIR = dataDir;   // SakuraID 的 core/config 在 import 时读取
  const imp = rel => import(pathToFileURL(path.join(idpRoot, rel)).href);
  const dbMod = await imp('src/core/db.js');
  const keysMod = await imp('src/core/keys.js');
  const settingsMod = await imp('src/models/settings.js');
  const runtimeMod = await imp('src/core/runtime.js');
  const usersMod = await imp('src/models/users.js');
  const clientsMod = await imp('src/models/clients.js');
  const passwordMod = await imp('src/core/password.js');

  dbMod.initDb();
  runtimeMod.bindSettings(settingsMod.getMap);
  settingsMod.setSetting('site_name', 'SakuraID 联调');
  settingsMod.setSetting('issuer', issuer);
  settingsMod.setSetting('setup_done', '1');          // 跳过部署守卫
  settingsMod.setSetting('allow_register', '0');
  runtimeMod.reloadRuntime();
  keysMod.initKeys();                                 // 生成 RS256 签名密钥

  usersMod.create({ username, passwordHash: passwordMod.hashPassword(password), name });
  usersMod.create({ username: 'sso_bob', passwordHash: passwordMod.hashPassword(password), name: '联调鲍勃' });
  const client = clientsMod.create({
    name: 'Sakura Chat 联调',
    redirectUris: [redirectUri],
    scopes: 'openid profile',
    isPublic: true,           // token_auth=none：公开客户端，仅靠 PKCE
    pkceRequired: true,
    requireConsent: false,    // 联调脚本不渲染同意页
  });
  dbMod.getDb().close();
  return client.client_id;
}

function spawnServer(file, cwd, env) {
  const child = spawn(process.execPath, [file], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', c => { log += c; });
  child.stderr.on('data', c => { log += c; });
  return { child, log: () => log };
}

async function main() {
  if (!existsSync(path.join(idpRoot, 'server.js'))) {
    console.log('SKIP: 同级目录未找到 Sakura-Auth-Server（' + idpRoot + '），跳过真实联调');
    return;
  }

  const idpPort = await freePort();
  const chatPort = await freePort();
  const chat = 'http://127.0.0.1:' + chatPort;
  const idp = 'http://127.0.0.1:' + idpPort;
  const redirectUri = chat + '/api/auth/oauth/sakura/callback';
  const idpData = mkdtempSync(path.join(tmpdir(), 'sakuraid-'));
  const chatData = mkdtempSync(path.join(tmpdir(), 'sakura-chat-smoke-'));
  let idpChild = null, chatChild = null;

  try {
    // 先播种再启动：client_id 在 Sakura-Chat 启动前就要确定
    const clientId = await seedIdp(idpData, {
      issuer: idp, redirectUri, username: 'sso_alice', password: 'alice-pass-123', name: '联调爱丽丝',
    });
    console.log('（已播种 SakuraID：client_id = ' + clientId + '）');

    idpChild = spawnServer('server.js', idpRoot, {
      ...process.env, PORT: String(idpPort), DATA_DIR: idpData, BASE_URL: idp,
    });
    chatChild = spawnServer(path.join(chatRoot, 'server/index.js'), chatRoot, {
      ...process.env, PORT: String(chatPort), SAKURA_DATA_DIR: chatData,
      SSL_KEY_PATH: '', SSL_CERT_PATH: '', JWT_SECRET: 'smoke-test-only',
      OAUTH_SAKURA_ISSUER: idp, OAUTH_SAKURA_CLIENT_ID: clientId,
    });

    await waitReady(idp + '/healthz', idpChild.child, idpChild.log);
    await waitReady(chat + '/api/health', chatChild.child, chatChild.log);

    // 1. 登录页提供方清单
    {
      const res = await request(chat + '/api/auth/providers');
      check('登录页暴露 Sakura 提供方', res.status === 200 &&
        JSON.parse(res.body).providers.some(p => p.id === 'sakura' && p.name === 'Sakura'));
    }

    // 2. 在真实 IdP 上建立用户会话
    const idpJar = new Jar();
    {
      const res = await request(idp + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'sso_alice', password: 'alice-pass-123' }),
      });
      idpJar.capture(res);
      check('真实登录 SakuraID 用户', res.status === 200 && !!idpJar.map.get('sid'));
    }

    // 3. 完整授权流程（start → authorize → callback → finish）
    const runFlow = async ({ link = false, finishBearer = null, idpSession = idpJar } = {}) => {
      const start = await request(chat + '/api/auth/oauth/sakura/start' + (link ? '?link=1' : ''));
      check('start 重定向到 IdP authorize', start.status === 302 && start.headers.location.startsWith(idp + '/authorize'));
      const au = new URL(start.headers.location);
      check('授权请求携带 PKCE S256 且不含 verifier',
        au.searchParams.get('code_challenge_method') === 'S256' && !au.searchParams.has('code_verifier'));

      const authorize = await request(start.headers.location, { headers: { cookie: idpSession.header() } });
      check('IdP 直接签发授权码（已禁用同意页）',
        authorize.status === 302 && authorize.headers.location.startsWith(chat + '/api/auth/oauth/sakura/callback'));

      const chatJar = new Jar();
      const cb = await request(authorize.headers.location);
      chatJar.capture(cb);
      if (link) {
        check('绑定回调跳回应用页并签发票据',
          cb.status === 302 && cb.headers.location.includes('oauth=link') && !!chatJar.map.get('sc_oauth_ticket'));
      } else {
        check('回调签发票据并跳回登录页',
          cb.status === 302 && cb.headers.location.includes('oauth=callback') && !!chatJar.map.get('sc_oauth_ticket'));
      }

      const headers = { cookie: chatJar.header(), 'Content-Length': '0' };
      if (finishBearer) headers.authorization = 'Bearer ' + finishBearer;
      const fin = await request(chat + '/api/auth/oauth/finish', { method: 'POST', headers });
      return { status: fin.status, data: fin.body ? JSON.parse(fin.body) : null };
    };

    const first = await runFlow();
    check('票据换取本站会话', first.status === 200 &&
      !!(first.data.token && first.data.sessionId && first.data.sessionKey));
    check('影子账号用户名取自 preferred_username', first.data.user.username === 'sso_alice');
    check('昵称取自 IdP name claim', first.data.user.nickname === '联调爱丽丝');
    check('影子账号带 shadow 标记', first.data.user.shadow === true);

    {
      const me = await request(chat + '/api/auth/me', { headers: { authorization: 'Bearer ' + first.data.token } });
      check('签发的 JWT 通过本站鉴权', me.status === 200 && JSON.parse(me.body).user.id === first.data.user.id);
    }

    // 4. 再次登录复用同一账号
    const second = await runFlow();
    check('同一外部身份复用同一账号', second.status === 200 && second.data.user.id === first.data.user.id);

    // 5. 本地账号绑定真实外部身份（用另一个 IdP 用户，避免与已建影子账号冲突）
    {
      const bobJar = new Jar();
      const idpLogin = await request(idp + '/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'sso_bob', password: 'alice-pass-123' }),
      });
      bobJar.capture(idpLogin);
      check('登录第二个 SakuraID 用户（绑定用）', idpLogin.status === 200 && !!bobJar.map.get('sid'));

      await request(chat + '/api/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'local_bob', password: 'pass1234' }),
      });
      const login = await request(chat + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'local_bob', password: 'pass1234' }),
      });
      const bob = JSON.parse(login.body);
      check('本地账号注册并登录', login.status === 200 && !!bob.token);

      const noToken = await runFlow({ link: true, idpSession: bobJar });
      check('绑定票据要求登录态（无 token 时拒绝）', noToken.status === 401);

      const linkRes = await runFlow({ link: true, finishBearer: bob.token, idpSession: bobJar });
      check('本地账号绑定真实 SakuraID 身份',
        linkRes.status === 200 && linkRes.data.user.id === bob.user.id &&
        linkRes.data.user.authProvider === 'sakura' && linkRes.data.user.shadow === false);

      // 绑定后：用该外部身份直接登录应复用本地账号（用户名保持本地注册值）
      const reuse = await runFlow({ idpSession: bobJar });
      check('绑定后的外部身份登录复用本地账号', reuse.status === 200 && reuse.data.user.id === bob.user.id &&
        reuse.data.user.username === 'local_bob');
    }

    // 5. 数据库层面断言（只读打开，聊天服务仍在线）
    {
      const db = new DatabaseSync(path.join(chatData, 'sakura-chat.db'), { readOnly: true });
      const row = db.prepare('SELECT auth_provider, auth_sub, password_hash FROM users WHERE id = ?')
        .get(first.data.user.id);
      db.close();
      check('库中记录外部身份且为影子账号',
        !!(row && row.auth_provider === 'sakura' && row.auth_sub && row.password_hash));
    }

    chatChild.child.kill();
    await once(chatChild.child, 'exit').catch(() => {});
    console.log('真实联调结果: ' + pass + ' 通过' + (process.exitCode ? '，存在失败' : ''));
  } finally {
    for (const c of [idpChild, chatChild]) if (c && c.child.exitCode === null) c.child.kill();
    for (const c of [idpChild, chatChild]) if (c && c.child.exitCode === null) await once(c.child, 'exit').catch(() => {});
    for (const dir of [idpData, chatData]) {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
      catch (_) { /* Windows 下 SQLite WAL 可能仍被占用，交给系统临时目录清理 */ }
    }
  }
}

main().catch(err => { console.error('联调异常:', err); process.exitCode = 1; });


