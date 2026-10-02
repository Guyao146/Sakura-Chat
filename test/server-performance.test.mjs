import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { SessionStore, SESSION_TTL, SESSION_LIMIT } from '../server/sessions.js';
const require = createRequire(import.meta.url);
// 模块仍正常加载，仅注入内存数据库配置，绝不读写真实数据目录。
const configPath = require.resolve('../server/config');
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true,
  exports: { dbPath: ':memory:', dataKey: randomBytes(32), historyPageSize: 30 } };
const { db } = require('../server/db');
const crypt = require('../server/crypto');
const { searchHistory, positiveInteger } = require('../server/history-search');
const router = require('../server/api/conversations');
const state = require('../server/state');
const route = path => router.stack.find(l => l.route?.path === path).route.stack[0].handle;
after(() => db.close());
db.prepare('INSERT INTO group_members(group_id,user_id,joined_at) VALUES(1,1,0)').run();
const insert = db.prepare("INSERT INTO messages(msg_id,conv_type,conv_id,sender_id,kind,content_enc,created_at,revoked) VALUES(?,'group','g_1',1,'text',?,?,?)");
db.exec('BEGIN');
for (let i = 1; i <= 2200; i++) {
  insert.run('m' + i, crypt.encryptMessageContent({ text: i <= 70 ? 'needle' : 'ordinary' }), i, i === 35 ? 1 : 0);
}
db.exec('COMMIT');

test('分页参数：负数、小数、无穷、数组均不能取消 LIMIT', () => {
  for (const value of [-1, 0, 0.5, 'Infinity', 'bad', ['200'], undefined]) {
    assert.equal(positiveInteger(value, 30, 100), 30);
    let response;
    route('/:convId/messages')({ user: { id: 1 }, params: { convId: 'g_1' }, query: { limit: value } }, { json: v => response = v });
    assert.equal(response.messages.length, 30);
  }
  assert.equal(positiveInteger('999', 30, 100), 100);
});

test('搜索让出事件循环，单页扫描有界，游标续查不漏不重且排除撤回', async () => {
  let yielded = false;
  setImmediate(() => { yielded = true; });
  const first = await searchHistory({ userId: 1, convId: 'g_1', q: 'needle' });
  assert.equal(yielded, true);
  assert.equal(first.matches.length, 0);
  assert.equal(first.nextBefore, 1201);
  const found = [];
  let before = first.nextBefore, pages = 1;
  while (before) {
    const page = await searchHistory({ userId: 1, convId: 'g_1', q: 'needle', before });
    found.push(...page.matches.map(m => m.row.id));
    assert.ok(page.matches.length <= 30);
    assert.ok(!page.nextBefore || page.nextBefore < before);
    before = page.nextBefore;
    assert.ok(++pages < 10);
  }
  assert.equal(found.length, 69);
  assert.equal(new Set(found).size, 69);
  assert.ok(!found.includes(35));
});

// 单批内凑满上限时，续查仍覆盖本批未扫描的更旧记录（密集匹配场景）。
test('密集匹配分页续查不漏记录', async () => {
  db.exec('BEGIN');
  for (let i = 3000; i < 3200; i++) insert.run('dense' + i, crypt.encryptMessageContent({ text: 'needle' }), i, 0);
  db.exec('COMMIT');
  const found = [];
  let before = null, pages = 0;
  while (true) {
    const page = await searchHistory({ userId: 1, convId: 'g_1', q: 'needle', before });
    found.push(...page.matches.map(m => m.row.id));
    before = page.nextBefore;
    if (!before) break;
    assert.ok(++pages < 12);
  }
  assert.equal(found.length, 200 + 69);
  assert.equal(new Set(found).size, found.length);
});

test('新搜索取代同一用户的旧搜索，旧任务返回 null 且不报繁忙', async () => {
  const stale = searchHistory({ userId: 2, convId: 'g_1', q: 'needle' });
  const fresh = await searchHistory({ userId: 2, convId: 'g_1', q: 'needle' });
  assert.equal(await stale, null);
  assert.equal(fresh.matches.length, 30);
});

test('客户端断开或切换会话时搜索及时停止，不占用后续请求', async () => {
  assert.equal(await searchHistory({ userId: 3, convId: 'g_1', q: 'needle', cancelled: () => true }), null);
  const page = await searchHistory({ userId: 3, convId: 'g_1', q: 'needle', before: 71 });
  assert.equal(page.matches.length, 30);
});

test('1000 次断线后密钥数量有界，宽限期后归零', () => {
  let now = 0;
  const store = new SessionStore(() => now);
  for (let i = 0; i < 1000; i++) {
    const sid = 's' + i, ws = { userId: 1, sessionId: sid };
    store.bind(1, sid, Buffer.alloc(32)); store.connect(ws); store.disconnect(ws);
  }
  assert.ok(store.users.get(1).size <= SESSION_LIMIT);
  assert.ok(store.get(1, 's999'));
  now += SESSION_TTL + 1; store.prune();
  assert.equal(store.users.size, 0);
});

test('活跃会话不被 TTL 淘汰；共享密钥的最后一个连接断开才开始计时', () => {
  let now = 0;
  const store = new SessionStore(() => now), key = Buffer.alloc(32);
  const a = { userId: 1, sessionId: 's' }, b = { ...a };
  store.bind(1, 's', key); store.connect(a); store.connect(b); store.disconnect(a);
  now += SESSION_TTL * 2; store.prune();
  assert.equal(store.get(1, 's'), key);
  store.disconnect(b); now += SESSION_TTL - 1;
  assert.equal(store.get(1, 's'), key);
  store.connect(a); now += SESSION_TTL; store.prune();
  assert.equal(store.get(1, 's'), key);
  store.disconnect(a); now += SESSION_TTL; store.prune();
  assert.equal(store.get(1, 's'), null);
});

test('未连接会话到期清理；满额活跃会话不能被新请求踢下线', () => {
  let now = 0;
  const store = new SessionStore(() => now);
  store.bind(2, 'idle', Buffer.alloc(32)); now += SESSION_TTL;
  assert.equal(store.get(2, 'idle'), null);
  for (let i = 0; i < SESSION_LIMIT; i++) {
    store.bind(1, String(i), Buffer.alloc(32)); store.connect({ userId: 1, sessionId: String(i) });
  }
  assert.throws(() => store.bind(1, 'overflow', Buffer.alloc(32)), { status: 429 });
  assert.ok(store.get(1, '0'));
});

test('密码验证兼容原哈希且不阻塞主循环，并发计算有上限', async () => {
  const salt = crypt.makeSalt(), hash = crypt.hashPassword('pass1234', salt);
  let yielded = false;
  const work = crypt.verifyPassword('pass1234', salt, hash);
  setImmediate(() => { yielded = true; });
  assert.equal(await work, true);
  assert.equal(yielded, true);
  assert.equal(await crypt.verifyPassword('wrong123', salt, hash), false);
  assert.equal(await crypt.hashPasswordAsync('pass1234', salt), hash);
  const jobs = Array.from({ length: 4 }, () => crypt.hashPasswordAsync('pass1234', salt));
  await assert.rejects(crypt.hashPasswordAsync('pass1234', salt), { status: 429 });
  await Promise.all(jobs);
  assert.equal(await crypt.verifyPassword('pass1234', salt, hash), true);
});

test('反向好友、群列表、未读消息使用对应索引', () => {
  for (const [sql, index] of [
    ['SELECT group_id FROM group_members WHERE user_id=1', 'idx_group_members_user'],
    ['SELECT user_id FROM friendships WHERE friend_id=1 AND status=1', 'idx_friendships_receiver'],
    ["SELECT id FROM messages WHERE conv_id='g_1' AND receiver_id=1 AND read_at IS NULL", 'idx_messages_unread'],
  ]) assert.ok(db.prepare('EXPLAIN QUERY PLAN ' + sql).all().some(r => r.detail.includes(index)));
});

test('慢 WebSocket 连接终止而非继续堆积；缺失密钥禁止降级明文发送', () => {
  let terminated = false, closed = null;
  const ws = { readyState: 1, bufferedAmount: 1024 * 1024 + 1, userId: 1, sessionId: 'absent',
    terminate: () => terminated = true, close: code => closed = code, send: () => assert.fail('不应发送') };
  state.sendSocket(ws, { type: 'message' });
  assert.equal(terminated, true);
  ws.bufferedAmount = 0;
  state.sendSocket(ws, { type: 'message' });
  assert.equal(closed, 4002);
});

test('会话列表批量查询保留最新消息、设置和已读时间', () => {
  db.prepare("INSERT INTO groups(id,name,owner_id,created_at) VALUES(1,'group',1,0)").run();
  db.prepare("INSERT INTO conv_settings VALUES(1,'g_1',1,1)").run();
  db.prepare("INSERT INTO unread_counts VALUES(1,'g_1',12,100)").run();
  let response;
  route('/')({ user: { id: 1 } }, { json: v => response = v });
  const conv = response.conversations.find(c => c.convId === 'g_1');
  const latest = db.prepare("SELECT msg_id, content_enc FROM messages WHERE id = (SELECT max(id) FROM messages WHERE conv_id = 'g_1')").get();
  assert.equal(conv.lastMessage.msgId, latest.msg_id);
  assert.equal(conv.lastMessage.content.text, crypt.decryptMessageContent(latest.content_enc).text);
  assert.equal(conv.unread, 12); assert.equal(conv.lastReadTs, 100);
  assert.equal(conv.pinned, true); assert.equal(conv.muted, true);
});
