import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../public/js/lib/performance.js', import.meta.url), 'utf8');
const { singleFlight, pruneMessageCache, dropMessageCache } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

test('30 次相同用户并发查询只调用一次，失败后可重试', async () => {
  let calls = 0, release;
  const get = singleFlight(() => { calls++; return new Promise(resolve => release = resolve); });
  const pending = Array.from({ length: 30 }, () => get(7));
  await Promise.resolve();
  assert.equal(calls, 1); release('user');
  assert.deepEqual(await Promise.all(pending), Array(30).fill('user'));
  let attempts = 0;
  const retry = singleFlight(() => { if (++attempts === 1) throw new Error('failed'); return 'ok'; });
  await assert.rejects(retry(7));
  assert.equal(await retry(7), 'ok');
});

function fixture() {
  const state = { activeConvId: 'c0', messages: new Map(), msgMap: new Map(), hasMore: new Map() };
  for (let i = 0; i < 30; i++) {
    const list = Array.from({ length: 200 }, (_, j) => ({ convId: 'c' + i, msgId: i + '_' + j, status: j === 0 && i === 1 ? 'sending' : 'sent' }));
    state.messages.set('c' + i, list);
    for (const m of list) state.msgMap.set(m.msgId, m);
  }
  return state;
}

test('非活跃消息缓存有界，保留阅读会话和未确认消息，索引同步淘汰', () => {
  const state = fixture();
  pruneMessageCache(state);
  assert.equal(state.messages.size, 20);
  assert.equal(state.messages.get('c0').length, 200);
  assert.equal(state.messages.get('c1').length, 101);
  assert.equal(state.messages.get('c1')[0].status, 'sending');
  assert.equal(state.msgMap.size, [...state.messages.values()].reduce((n, list) => n + list.length, 0));
  assert.equal(state.hasMore.get('c1'), true);
  assert.ok(!state.msgMap.has('1_1'));
});

test('删除会话同时清除消息、索引和分页状态', () => {
  const state = fixture(); state.hasMore.set('c1', true);
  dropMessageCache(state, 'c1');
  assert.equal(state.messages.has('c1'), false);
  assert.equal(state.hasMore.has('c1'), false);
  assert.ok(![...state.msgMap.values()].some(m => m.convId === 'c1'));
});
