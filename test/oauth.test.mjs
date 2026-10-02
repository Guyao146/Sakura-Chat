'use strict';

/**
 * 第三方登录（OAuth2/OIDC）回归：内嵌一个最小化标准 IdP（discovery / authorize /
 * token / userinfo，含 PKCE 校验），驱动真实服务端走完整授权码流程。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const base64url = buf => buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

/** 不跟随重定向的 HTTP 客户端（fetch 的 manual 模式拿不到 Location，故用 http 模块） */
function httpRequest(url, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function freePort() {
  const srv = net.createServer();
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise(resolve => srv.close(resolve));
  return port;
}

/** 启动临时 Sakura-Chat 服务（隔离端口与数据目录），port 可显式指定（回调地址需先于服务确定） */
async function startChat(envExtra = {}, port) {
  if (!port) port = await freePort();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sakura-oauth-'));
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('OAUTH_') && k !== 'APP_BASE_URL')
  );
  const env = {
    ...baseEnv, PORT: String(port), SAKURA_DATA_DIR: dataDir,
    SSL_KEY_PATH: '', SSL_CERT_PATH: '', JWT_SECRET: 'oauth-test-' + port,
    ...envExtra,
  };
  const child = spawn(process.execPath, [path.join(root, 'server/index.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', c => { log += c; });
  child.stderr.on('data', c => { log += c; });
  child.on('exit', (code, sig) => { log += `[child exit code=${code} sig=${sig}]`; });
  const origin = 'http://127.0.0.1:' + port;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('OAuth 测试服务提前退出:\n' + log);
    try { if ((await httpRequest(origin + '/api/health')).status === 200) { ready = true; break; } } catch (_) {}
    await sleep(100);
  }
  if (!ready) throw new Error('OAuth 测试服务启动超时:\n' + log);
  return {
    origin,
    stop: async () => {
      if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
      await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

/**
 * 最小化 OIDC Provider：
 * - GET  /.well-known/openid-configuration
 * - GET  /authorize?...&login_as=<用户名>  （login_as 由测试注入，模拟用户已完成登录/同意）
 * - POST /token（校验 PKCE S256；公开客户端禁止携带密钥）
 * - GET  /userinfo（Bearer access_token → claims）
 */
function createIdp({ expectedClientId, expectedRedirectUri }) {
  const users = new Map();   // login_as -> { sub, preferred_username, name }
  const codes = new Map();   // code -> { user, challenge, redirectUri, clientId, used }
  const tokens = new Map();  // accessToken -> user
  let server = null;
  let base = '';

  const json = (res, status, obj, extraHeaders = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
    res.end(JSON.stringify(obj));
  };

  const handle = (req, res) => {
    const url = new URL(req.url, 'http://idp.local');
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: base + '/authorize',
        token_endpoint: base + '/token',
        userinfo_endpoint: base + '/userinfo',
        jwks_uri: base + '/jwks.json',
      });
    }
    if (url.pathname === '/authorize' && req.method === 'GET') {
      const q = url.searchParams;
      const fail = msg => json(res, 400, { error: 'invalid_request', error_description: msg });
      if (q.get('response_type') !== 'code') return fail('response_type');
      if (q.get('client_id') !== expectedClientId) return fail('client_id');
      if (q.get('redirect_uri') !== expectedRedirectUri) return fail('redirect_uri');
      if (!q.get('state')) return fail('state');
      if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return fail('PKCE');
      if (!q.get('scope') || !q.get('scope').split(/\s+/).includes('openid')) return fail('scope');
      const loginAs = q.get('login_as') || 'alice';
      const user = users.get(loginAs);
      if (!user) return fail('unknown_user');
      const code = base64url(crypto.randomBytes(24));
      codes.set(code, {
        user, challenge: q.get('code_challenge'),
        redirectUri: q.get('redirect_uri'), clientId: q.get('client_id'), used: false,
      });
      const target = new URL(q.get('redirect_uri'));
      target.searchParams.set('code', code);
      target.searchParams.set('state', q.get('state'));
      res.writeHead(302, { Location: target.href });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        const body = new URLSearchParams(raw);
        const fail = (msg, status = 400) => json(res, status, { error: 'invalid_grant', error_description: msg });
        if (body.get('grant_type') !== 'authorization_code') return fail('grant_type');
        if (body.get('client_id') !== expectedClientId) return fail('client_id', 401);
        if (body.get('client_secret')) return fail('公开客户端不应携带密钥', 401);
        const row = codes.get(body.get('code'));
        if (!row || row.used) return fail('授权码无效或已使用');
        if (row.redirectUri !== body.get('redirect_uri')) return fail('redirect_uri 不一致');
        if (!body.get('code_verifier')) return fail('缺少 code_verifier');
        const expected = base64url(crypto.createHash('sha256').update(body.get('code_verifier')).digest());
        if (expected !== row.challenge) return fail('PKCE 校验失败');
        row.used = true;
        const at = base64url(crypto.randomBytes(32));
        tokens.set(at, row.user);
        return json(res, 200, {
          access_token: at, token_type: 'Bearer', expires_in: 3600, scope: 'openid profile',
        }, { 'Cache-Control': 'no-store' });
      });
      return;
    }
    if (url.pathname === '/userinfo' && req.method === 'GET') {
      const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      const user = m && tokens.get(m[1].trim());
      if (!user) return json(res, 401, { error: 'invalid_token' }, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
      return json(res, 200, {
        sub: user.sub,
        preferred_username: user.preferred_username,
        name: user.name,
      });
    }
    json(res, 404, { error: 'not_found' });
  };

  return {
    async start(port) {
      server = http.createServer(handle);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      base = 'http://127.0.0.1:' + server.address().port;
      return base;
    },
    get issuer() { return base; },
    addUser(loginAs, info) { users.set(loginAs, info); },
    async stop() { if (server) await new Promise(r => server.close(r)); },
  };
}

/** 走完整第三方登录流程（start → IdP 授权 → 回调），返回重定向与票据 Cookie */
async function runFlow(chat, idp, loginAs) {
  const r1 = await httpRequest(chat + '/api/auth/oauth/sakura/start');
  assert.equal(r1.status, 302, 'start 应 302 到身份提供方');
  const authorizeUrl = r1.headers.location;
  const authorize = new URL(authorizeUrl);
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(!authorize.searchParams.has('code_verifier'), 'code_verifier 不得出现在 URL');
  assert.ok(authorize.searchParams.get('scope').includes('openid'));

  // 模拟用户在 IdP 完成登录与同意（login_as 注入）
  const r2 = await httpRequest(authorizeUrl + (authorizeUrl.includes('?') ? '&' : '?') + 'login_as=' + encodeURIComponent(loginAs));
  assert.equal(r2.status, 302, 'IdP 应重定向回回调地址');
  const callbackUrl = r2.headers.location;

  const r3 = await httpRequest(callbackUrl);
  // Node http 模块的 set-cookie 是数组；只取第一条 cookie 的 name=value
  const setCookie = r3.headers['set-cookie'];
  const cookie = Array.isArray(setCookie) && setCookie.length ? setCookie[0].split(';')[0]
    : (typeof setCookie === 'string' ? setCookie.split(';')[0] : '');
  return { status: r3.status, location: r3.headers.location, cookie, callbackUrl };
}

/** 用票据 Cookie 换取本站会话 */
async function finish(chat, cookie) {
  const res = await httpRequest(chat + '/api/auth/oauth/finish', {
    method: 'POST', headers: cookie ? { cookie, 'Content-Length': '0' } : { 'Content-Length': '0' },
  });
  let data = null;
  try { data = res.body ? JSON.parse(res.body) : null; } catch (_) {}
  return { status: res.status, data };
}

test('OAuth/OIDC 第三方登录', async t => {
  const chatPort = await freePort();
  const chat = 'http://127.0.0.1:' + chatPort;
  const redirectUri = chat + '/api/auth/oauth/sakura/callback';
  const idp = createIdp({ expectedClientId: 'chat-test', expectedRedirectUri: redirectUri });
  await idp.start(await freePort());
  idp.addUser('alice', { sub: 'sub-alice-1', preferred_username: 'Alice', name: 'Alice Lindgren' });
  idp.addUser('alice2', { sub: 'sub-alice-2', preferred_username: 'Alice', name: 'Alice Cooper' });

  const server = await startChat({
    OAUTH_SAKURA_ISSUER: idp.issuer,
    OAUTH_SAKURA_CLIENT_ID: 'chat-test',
  }, chatPort);

  await t.test('未配置的提供方对前端不可见', async () => {
    const res = await httpRequest(chat + '/api/auth/providers');
    const data = JSON.parse(res.body);
    assert.equal(res.status, 200);
    assert.deepEqual(data.providers, [{ id: 'sakura', name: 'Sakura' }]);

    const unknown = await httpRequest(chat + '/api/auth/oauth/github/start');
    assert.equal(unknown.status, 404);
  });

  await t.test('完整流程：首次登录自动建号并签发本站会话', async () => {
    const flow = await runFlow(chat, idp, 'alice');
    assert.equal(flow.status, 302);
    assert.equal(new URL(flow.location, chat).searchParams.get('oauth'), 'callback');
    assert.ok(flow.cookie && flow.cookie.includes('sc_oauth_ticket='), '应下发票据 Cookie');

    const { status, data } = await finish(chat, flow.cookie);
    assert.equal(status, 200);
    assert.ok(data.token && data.sessionId && data.sessionKey);
    assert.equal(data.user.username, 'Alice');
    assert.equal(data.user.nickname, 'Alice Lindgren');

    // 签发的 JWT 能正常调用鉴权接口
    const me = await httpRequest(chat + '/api/auth/me', { headers: { authorization: 'Bearer ' + data.token } });
    assert.equal(me.status, 200);
    assert.equal(JSON.parse(me.body).user.id, data.user.id);
  });

  await t.test('同一外部身份再次登录复用同一账号', async () => {
    const first = await runFlow(chat, idp, 'alice');
    const a = await finish(chat, first.cookie);
    const second = await runFlow(chat, idp, 'alice');
    const b = await finish(chat, second.cookie);
    assert.equal(a.data.user.id, b.data.user.id, '同一 sub 不得重复建号');
  });

  await t.test('用户名冲突时自动追加后缀', async () => {
    const flow = await runFlow(chat, idp, 'alice2');   // preferred_username 同为 Alice
    const { data } = await finish(chat, flow.cookie);
    assert.ok(data.user.id);
    assert.equal(data.user.username, 'Alice_2');
  });

  await t.test('state 与票据均一次性：重放被拒绝', async () => {
    const flow = await runFlow(chat, idp, 'alice');
    const cookie = flow.cookie;

    // 重放回调 URL：state 已被消费
    const replay = await httpRequest(flow.callbackUrl);
    assert.equal(replay.status, 302);
    const loc = new URL(replay.headers.location, chat);
    assert.equal(loc.pathname, '/login');
    assert.equal(loc.searchParams.get('oauth'), 'error');

    // 票据只能换一次
    const ok = await finish(chat, cookie);
    assert.equal(ok.status, 200);
    const again = await finish(chat, cookie);
    assert.equal(again.status, 401);
    const none = await finish(chat, '');
    assert.equal(none.status, 401);
  });

  await t.test('授权码无效时走错误重定向而非抛 500', async () => {
    const res = await httpRequest(chat + '/api/auth/oauth/sakura/callback?code=fake&state=unknown');
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.location, chat);
    assert.equal(loc.searchParams.get('oauth'), 'error');
    assert.ok(loc.searchParams.get('msg'));
  });

  await t.test('完全未配置时登录页只有本地登录', async () => {
    const plain = await startChat();
    try {
      const res = await httpRequest(plain.origin + '/api/auth/providers');
      assert.deepEqual(JSON.parse(res.body).providers, []);
      const start = await httpRequest(plain.origin + '/api/auth/oauth/sakura/start');
      assert.equal(start.status, 404);
    } finally {
      await plain.stop();
    }
  });

  await server.stop();
  await idp.stop();
});
