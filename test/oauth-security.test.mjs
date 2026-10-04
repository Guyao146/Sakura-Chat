import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const require = createRequire(import.meta.url);
const configPath = require.resolve('../server/config');
const config = { dbPath: ':memory:', dataKey: randomBytes(32), oauthRedirectBase: '', useTls: false };
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: config };
const { db } = require('../server/db');
const oauth = require('../server/oauth');
after(() => db.close());

const identity = (sub, username) => ({ providerId: 'test', sub, username, nickname: username });

test('OAuth 并发首次登录：相同外部身份复用账号而非 UNIQUE 异常', async () => {
  const users = await Promise.all([oauth.resolveUser(identity('same', 'sameuser')),
    oauth.resolveUser(identity('same', 'sameuser'))]);
  assert.equal(users[0].id, users[1].id);
  assert.equal(db.prepare("SELECT count(*) AS n FROM users WHERE auth_sub = 'same'").get().n, 1);
});

test('OAuth 并发首次登录：不同身份同名时各自创建带后缀的账号', async () => {
  const users = await Promise.all([oauth.resolveUser(identity('one', 'sharedname')),
    oauth.resolveUser(identity('two', 'sharedname'))]);
  assert.notEqual(users[0].id, users[1].id);
  assert.notEqual(users[0].username, users[1].username);
});

test('OAuth 哈希期间完成本地注册：插入时重新挑选用户名', async () => {
  const pending = oauth.resolveUser(identity('race-local', 'localname'));
  db.prepare('INSERT INTO users(username,nickname,password_hash,salt,created_at) VALUES(?,?,?,?,0)')
    .run('localname', 'local', 'unused', 'unused');
  assert.notEqual((await pending).username, 'localname');
});

test('OAuth 昵称与本地资料保持 20 字符上限', async () => {
  const user = await oauth.resolveUser({ ...identity('long-nick', 'longnick'), nickname: 'x'.repeat(1000) });
  assert.equal(user.nickname.length, 20);
});

test('OAuth Cookie：HttpOnly、SameSite、浏览器复用，以及代理 HTTPS 的 Secure 属性', () => {
  const headers = [];
  const res = { append: (name, value) => { assert.equal(name, 'Set-Cookie'); headers.push(value); } };
  const req = { headers: {}, secure: false };
  const id = oauth.bindBrowser(req, res);
  assert.match(headers.at(-1), /HttpOnly; SameSite=Lax; Max-Age=600/);
  assert.ok(!headers.at(-1).includes('; Secure'));
  req.headers.cookie = 'other=1; sc_oauth_browser=' + id;
  assert.equal(oauth.readBrowserCookie(req), id);
  assert.equal(oauth.bindBrowser(req, res), id, '多标签页复用浏览器绑定，不覆盖已有流程');

  req.secure = true;
  oauth.bindBrowser(req, res);
  assert.ok(headers.at(-1).endsWith('; Secure'));
  oauth.setTicketCookie(res, 'ticket', req);
  assert.ok(headers.at(-1).endsWith('; Secure'));
  oauth.clearTicketCookie(res, req);
  assert.match(headers.at(-1), /Max-Age=0; Secure$/);

  req.secure = false;
  config.oauthRedirectBase = 'https://chat.example.com';
  try {
    oauth.setTicketCookie(res, 'ticket', req);
    assert.ok(headers.at(-1).endsWith('; Secure'));
  } finally { config.oauthRedirectBase = ''; }
});

test('OAuth 协议：不直接信任伪造的 X-Forwarded-Proto', () => {
  const req = { headers: { host: 'chat.example.com', 'x-forwarded-proto': 'https' }, secure: false };
  assert.equal(oauth.requestBase(req), 'http://chat.example.com');
  req.secure = true;
  assert.equal(oauth.requestBase(req), 'https://chat.example.com');
});
