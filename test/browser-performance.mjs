// 仅测试服务器在内存中附加私有导出；生产文件不暴露调试状态。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { launchBrowser } from './browser-helper.mjs';
const root = fileURLToPath(new URL('../public/', import.meta.url));
const app = express();
const html = (await readFile(root + '/index.html', 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const source = await readFile(root + '/js/app.js', 'utf8');
app.get('/', (req, res) => res.type('html').send(html));
app.get('/js/app.js', (req, res) => res.type('js').send(source + '\nexport { state, renderMessages, renderConvList, onAck, onRead, onReact, onEditMessage, onRecall, onGroupDismissed, updateConvItem, cacheUsers, searchHistory };'));
app.use(express.static(root));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
let browser, passed = 0;
const check = (name, ok) => { assert.ok(ok, name); console.log('  [PASS] ' + name); passed++; };
try {
  browser = await launchBrowser();
  const { send, evaluate, wait } = browser;
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port });
  await wait("document.readyState === 'complete' && !!document.querySelector('#msg-list')");
  await evaluate(`(async () => {
    window.bench = await import('/js/app.js');
    const { api } = await import('/js/lib/api.js'); window.api = api;
    bench.state.me = { id: 1, nickname: 'Benchmark' };
    const conv = { convId: 'u_1_2', convType: 'single', peer: { id: 2, nickname: 'Peer' } };
    bench.state.conversations = [conv]; bench.state.convMap.set(conv.convId, conv); bench.state.activeConvId = conv.convId;
    document.querySelector('#login-view').hidden = true; document.querySelector('#app-view').hidden = false;
    document.querySelector('#chat-empty').hidden = true; document.querySelector('#chat-main').hidden = false;
    window.setMessages = n => {
      const list = Array.from({ length: n }, (_, i) => ({ id: i + 1, msgId: 'bench_' + i, convId: conv.convId,
        convType: 'single', senderId: 1, kind: 'text', content: { text: 'Benchmark message **bold** ' + i }, createdAt: 1700000000000 + i * 1000, status: 'sent' }));
      bench.state.messages.set(conv.convId, list); bench.state.msgMap = new Map(list.map(m => [m.msgId, m]));
    };
    setMessages(3000); bench.renderMessages();
    window.originalRow = document.querySelector('.msg-row');
    window.originalLast = document.querySelector('.msg-row:last-child');
  })()`);
  const timing = await evaluate(`(() => {
    const t = performance.now(); bench.onAck({ msgId: 'bench_0', serverId: 1, ts: 1700000000000, delivered: true });
    const ackMs = performance.now() - t;
    const t2 = performance.now(); bench.renderMessages();
    return { ackMs, renderMs: performance.now() - t2, same: originalRow === document.querySelector('.msg-row') && originalRow.isConnected };
  })()`);
  check('3000 条历史下 ACK 与随后渲染均保留原消息节点', timing.same);
  console.log('  [基准] ' + JSON.stringify(timing));
  check('已读只更新状态，保留历史 DOM', await evaluate(`(() => {
    bench.onRead({ convId: 'u_1_2', ts: 1700000001000 });
    return originalRow.isConnected && originalLast.isConnected && originalRow.querySelector('.msg-status').textContent === '已读';
  })()`));
  check('编辑与回应只替换目标消息，随后渲染不还原旧内容', await evaluate(`(() => {
    bench.onEditMessage({ msgId: 'bench_0', text: 'edited', editedAt: Date.now() });
    bench.onReact({ msgId: 'bench_0', reactions: { '👍': [1] } }); bench.renderMessages();
    return originalLast.isConnected && document.querySelector('.msg-row').textContent.includes('edited') && !!document.querySelector('.reaction-chip');
  })()`));
  check('撤回只更新目标，其他消息保留', await evaluate(`(() => {
    bench.onRecall({ msgId: 'bench_0' }); bench.renderMessages();
    return originalLast.isConnected && !!document.querySelector('.msg-recall');
  })()`));
  check('追加与前插历史不替换原有消息节点', await evaluate(`(() => {
    const list = bench.state.messages.get('u_1_2');
    list.push({ ...list.at(-1), id: 4000, msgId: 'new', content: { text: 'new' } });
    list.unshift({ ...list[1], id: 0, msgId: 'older', createdAt: 1699990000000 });
    bench.renderMessages(true, true);
    return originalLast.isConnected && document.querySelectorAll('.msg-row').length === 3001;
  })()`));
  check('资料缓存的相同发送者只发出一个请求', await evaluate(`(async () => {
    let calls = 0, release;
    api.getUser = () => { calls++; return new Promise(resolve => release = resolve); };
    bench.cacheUsers(Array(30).fill(7)); bench.cacheUsers([7]);
    await Promise.resolve(); release({ user: { id: 7, nickname: 'Sender' } });
    await new Promise(resolve => setTimeout(resolve, 0));
    bench.cacheUsers([7]); await Promise.resolve();
    return calls === 1;
  })()`));
  check('侧栏普通重绘和草稿预览更新保留其他会话节点', await evaluate(`(() => {
    const conv = { convId: 'g_8', convType: 'group', group: { id: 8, name: 'Other' } };
    bench.state.conversations.push(conv); bench.state.convMap.set(conv.convId, conv);
    bench.renderConvList(); const other = document.querySelector('[data-convid="g_8"]');
    bench.updateConvItem('u_1_2'); bench.renderConvList();
    return other.isConnected;
  })()`));
  check('搜索无匹配批次仍能继续检索更早记录', await evaluate(`(async () => {
    document.querySelector('#search-panel').hidden = false;
    api.searchHistory = async (id, q, before) => before
      ? { results: [{ msgId: 'hit', senderId: 1, content: { text: 'earlier needle' }, kind: 'text', createdAt: 1 }], nextBefore: null }
      : { results: [], nextBefore: 100 };
    await bench.searchHistory('needle');
    const more = document.querySelector('[data-search-more]');
    if (!more) return false;
    more.click(); await new Promise(resolve => setTimeout(resolve, 0));
    return document.querySelector('#search-results').textContent.includes('earlier needle') && !document.querySelector('[data-search-more]');
  })()`));
  check('新搜索取消前一个请求，迟到结果不覆盖新结果', await evaluate(`(async () => {
    let oldSignal, release;
    api.searchHistory = (id,q,before,signal) => q === 'old'
      ? new Promise(resolve => { oldSignal=signal; release=resolve; })
      : Promise.resolve({ results: [], nextBefore: null });
    const old = bench.searchHistory('old'); await bench.searchHistory('new');
    release({ results: [{ msgId:'stale',senderId:1,kind:'text',content:{text:'STALE'},createdAt:1 }],nextBefore:null });
    await old;
    return oldSignal.aborted && !document.querySelector('#search-results').textContent.includes('STALE');
  })()`));
  check('解散当前群清理消息索引和 DOM 引用', await evaluate(`(() => {
    const id='g_99', m={ msgId:'removed',convId:id,convType:'group',senderId:1,kind:'text',content:{text:'removed'},createdAt:1 };
    bench.state.activeConvId=id; bench.state.messages.set(id,[m]); bench.state.msgMap.set(m.msgId,m); bench.renderMessages();
    bench.onGroupDismissed({ groupId:99,groupName:'Removed' });
    return !bench.state.messages.has(id) && !bench.state.msgMap.has(m.msgId) && !document.querySelector('#msg-list').firstChild;
  })()`));
  check('性能回归无浏览器未捕获异常', browser.errors.length === 0);
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
console.log('浏览器性能回归: ' + passed + ' 通过');
