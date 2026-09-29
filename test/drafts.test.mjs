import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../public/js/lib/drafts.js', import.meta.url), 'utf8');
const { DraftStore } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
function storage() {
  const data = new Map();
  return { get length() { return data.size; }, key: i => [...data.keys()][i],
    getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}
test('按账号和会话隔离，刷新恢复文字和引用', () => {
  const db = storage(), a = new DraftStore(1, db);
  a.set('u_1_2', '草稿 A', { msgId: 'm1', snip: '引用' });
  a.set('g_3', '草稿 B', null);
  assert.deepEqual(new DraftStore(1, db).get('u_1_2'), { text: '草稿 A', reply: { msgId: 'm1', snip: '引用' } });
  assert.equal(a.get('g_3').text, '草稿 B');
  assert.equal(new DraftStore(2, db).get('u_1_2'), null);
});
test('清空草稿后删除存储；退出仅清除当前账号', () => {
  const db = storage(), a = new DraftStore(1, db), b = new DraftStore(2, db);
  a.set('a', '文字', null); a.set('b', '', { msgId: 'm', snip: '只有引用' }); b.set('a', '保留', null);
  a.set('a', '', null);
  assert.equal(new DraftStore(1, db).get('a'), null);
  a.clear();
  assert.equal(db.length, 1);
  assert.equal(new DraftStore(2, db).get('a').text, '保留');
});
test('损坏或不可用的存储不阻断输入，引用对象不共享', () => {
  const db = storage(); db.setItem('sc_draft_v1:1:a', '{invalid');
  assert.equal(new DraftStore(1, db).get('a'), null);
  const a = new DraftStore(1, { setItem() { throw new Error('quota'); }, getItem() { throw new Error('blocked'); } });
  const reply = { msgId: 'm', snip: '引用' };
  a.set('a', '仍可输入', reply); reply.snip = '已改变';
  assert.equal(a.get('a').reply.snip, '引用');
  assert.equal(a.get('a').text, '仍可输入');
  assert.doesNotThrow(() => a.clear());
});
