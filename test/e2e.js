/**
 * 端到端集成测试：覆盖注册登录、加密 WS 收发、已读回执、撤回、群聊、
 * 表情包/语音消息、音视频通话信令中继、
 * 服务端聊天记录搜索、以及"数据库中只存密文"的断言。
 * 运行方式：先启动服务（npm start），再 node test/e2e.js
 */

const WebSocket = require('ws');
const crypto = require('node:crypto');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const HOST = process.env.HOST || 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'server', 'data', 'sakura-chat.db');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}`); }
}

/* ---- 与服务端一致的 AES-256-GCM：IV(12) + 密文 + Tag(16) ---- */
function enc(key, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const cipher = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, cipher, c.getAuthTag()]).toString('base64');
}
function dec(key, b64) {
  const buf = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString('utf8');
}

async function http(method, p, body, token) {
  const res = await fetch(HOST + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function connect(token, sid, keyB64) {
  const key = Buffer.from(keyB64, 'base64');
  const wsBase = HOST.replace(/^http/, 'ws');   // 与 HTTP 同源，避免 WS 地址硬编码
  const ws = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(token)}&sid=${encodeURIComponent(sid)}`);
  const client = {
    ws, key, events: [],
    send: (obj) => ws.send(JSON.stringify({ sid, d: enc(key, JSON.stringify(obj)) })),
    wait: (pred, timeout = 4000) => new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function loop() {
        const i = client.events.findIndex(e => pred(e));
        if (i >= 0) return resolve(client.events.splice(i, 1)[0]);
        if (Date.now() - t0 > timeout) return reject(new Error('等待事件超时'));
        setTimeout(loop, 50);
      })();
    }),
  };
  ws.on('message', (raw) => {
    let obj = JSON.parse(raw.toString());
    if (obj && typeof obj.d === 'string') obj = JSON.parse(dec(client.key, obj.d));
    client.events.push(obj);
  });
  return new Promise((res, rej) => {
    ws.on('open', () => res(client));
    ws.on('error', rej);
  });
}

async function ensureUser(username, password, nickname) {
  try {
    await http('POST', '/api/auth/register', { username, password, nickname });
  } catch (e) {
    if (!/已被注册/.test(e.message)) throw e;
  }
  const data = await http('POST', '/api/auth/login', { username, password });
  const sess = await http('GET', '/api/auth/session', null, data.token);
  return { ...data, sessionId: sess.sessionId, sessionKey: sess.sessionKey };
}

(async () => {
  const s = Math.floor(Math.random() * 100000);
  console.log('--- 注册 / 登录 / 会话密钥 ---');
  const alice = await ensureUser('alice_' + s, 'pass1234', '爱丽丝');
  const bob = await ensureUser('bob_' + s, 'pass1234', '鲍勃');
  const carol = await ensureUser('carol_' + s, 'pass1234', '凯若');
  check('登录返回 token + 会话密钥', !!alice.token && /^[A-Za-z0-9+/=]{40,}$/.test(alice.sessionKey));
  check('JWT 为 payload.signature 结构', alice.token.includes('.') && alice.token.split('.').length === 2);

  console.log('--- 好友关系 ---');
  await http('POST', '/api/friends/request', { userId: bob.user.id }, alice.token);
  let reqs = (await http('GET', '/api/friends/requests', null, bob.token)).requests;
  check('Bob 收到好友请求', reqs.length === 1 && reqs[0].username === alice.user.username);
  await http('POST', '/api/friends/requests/' + reqs[0].id + '/accept', null, bob.token);
  const convs = (await http('GET', '/api/conversations', null, alice.token)).conversations;
  check('Alice 会话列表出现 Bob', convs.some(c => c.convType === 'single' && c.peer.id === bob.user.id));
  const singleConvId = convs.find(c => c.convType === 'single' && c.peer.id === bob.user.id).convId;
  await http('POST', '/api/friends/request', { userId: carol.user.id }, alice.token);
  reqs = (await http('GET', '/api/friends/requests', null, carol.token)).requests;
  await http('POST', '/api/friends/requests/' + reqs[0].id + '/accept', null, carol.token);

  console.log('--- 加密 WebSocket 通信 ---');
  const ca = await connect(alice.token, alice.sessionId, alice.sessionKey);
  const cb = await connect(bob.token, bob.sessionId, bob.sessionKey);
  const cc = await connect(carol.token, carol.sessionId, carol.sessionKey);
  const connected = await Promise.race([
    ca.wait(e => e.type === 'connected'),
    new Promise((r) => setTimeout(() => r(null), 2000)),
  ]);
  check('WS 建立并收到 connected 事件', !!connected);

  const secret = '这是一条加密聊天记录' + Date.now();
  const msgId = 't_' + crypto.randomUUID();
  ca.send({ type: 'chat', msg: { msgId, convType: 'single', to: bob.user.id, kind: 'text', content: { text: secret } } });
  const bobGot = await cb.wait(e => e.type === 'message' && e.msg?.msgId === msgId);
  check('Bob 收到加密消息且内容正确解密', bobGot?.msg?.content?.text === secret);
  const ack = await ca.wait(e => e.type === 'ack' && e.msgId === msgId);
  check('Alice 收到 ACK（服务端已持久化）', !!ack?.serverId);

  await cb.send({ type: 'read', convId: singleConvId });
  const readEvt = await ca.wait(e => e.type === 'read' && e.convId === singleConvId);
  check('已读回执送达 Alice', !!readEvt);

  ca.send({ type: 'typing', convId: singleConvId, typing: true });
  let typingOk = false;
  try { typingOk = !!(await cb.wait(e => e.type === 'typing' && e.typing === true, 3000)); }
  catch (_) {}
  check('输入中提示送达 Bob', typingOk);

  const msgId2 = 't_' + crypto.randomUUID();
  ca.send({ type: 'chat', msg: { msgId: msgId2, convType: 'single', to: bob.user.id, kind: 'text', content: { text: '待撤回消息' } } });
  await cb.wait(e => e.type === 'message' && e.msg?.msgId === msgId2);
  await new Promise(r => setTimeout(r, 300));
  ca.send({ type: 'recall', msgId: msgId2 });
  const recallEvt = await cb.wait(e => e.type === 'recall' && e.msgId === msgId2);
  check('撤回事件送达 Bob', !!recallEvt);

  console.log('--- 群聊 ---');
  const { group } = await http('POST', '/api/groups', { name: '测试群', memberIds: [bob.user.id, carol.user.id] }, alice.token);
  check('建群成功（3 人）', !!group.id);
  const gmsgId = 't_' + crypto.randomUUID();
  ca.send({ type: 'chat', msg: { msgId: gmsgId, convType: 'group', groupId: group.id, kind: 'text', content: { text: '群聊你好' } } });
  const [gb, gc] = await Promise.all([
    cb.wait(e => e.type === 'message' && e.msg?.msgId === gmsgId),
    cc.wait(e => e.type === 'message' && e.msg?.msgId === gmsgId),
  ]);
  check('群消息送达所有在线成员', !!gb && !!gc);

  console.log('--- 表情包 / 语音消息 ---');
  const stMsgId = 't_' + crypto.randomUUID();
  ca.send({ type: 'chat', msg: { msgId: stMsgId, convType: 'single', to: bob.user.id, kind: 'sticker', content: { url: '/stickers/happy.svg' } } });
  const stAck = await ca.wait(e => e.type === 'ack' && e.msgId === stMsgId);
  const stGot = await cb.wait(e => e.type === 'message' && e.msg?.msgId === stMsgId);
  check('表情包消息发送并送达', !!stAck && stGot?.msg?.kind === 'sticker' && stGot.msg.content.url === '/stickers/happy.svg');

  const voMsgId = 't_' + crypto.randomUUID();
  const voiceContent = { url: '/uploads/voice_x.webm', duration: 3, peaks: [0.1, 0.5, 0.9] };
  ca.send({ type: 'chat', msg: { msgId: voMsgId, convType: 'single', to: bob.user.id, kind: 'voice', content: voiceContent } });
  const voAck = await ca.wait(e => e.type === 'ack' && e.msgId === voMsgId);
  const voGot = await cb.wait(e => e.type === 'message' && e.msg?.msgId === voMsgId);
  check('语音消息发送并送达（含波形数据）', !!voAck && voGot?.msg?.kind === 'voice' && Array.isArray(voGot.msg.content.peaks) && voGot.msg.content.peaks.length === 3);

  console.log('--- 音视频通话信令中继（WebRTC）---');
  const callId = 'call_test_' + crypto.randomUUID();
  ca.send({ type: 'call_offer', to: bob.user.id, callId, media: 'video', sdp: 'FAKE_SDP_OFFER' });
  const bobOffer = await cb.wait(e => e.type === 'call_offer' && e.callId === callId);
  check('通话邀请被中继到被叫', bobOffer?.sdp === 'FAKE_SDP_OFFER' && bobOffer.media === 'video' && bobOffer.from === alice.user.id);
  cb.send({ type: 'call_answer', to: alice.user.id, callId, sdp: 'FAKE_SDP_ANSWER' });
  const aliceAns = await ca.wait(e => e.type === 'call_answer' && e.callId === callId);
  check('通话应答被中继到主叫', aliceAns?.sdp === 'FAKE_SDP_ANSWER');
  ca.send({ type: 'call_ice', to: bob.user.id, callId, candidate: { candidate: 'FAKE_ICE', sdpMid: '0' } });
  const bobIce = await cb.wait(e => e.type === 'call_ice' && e.callId === callId);
  check('ICE 候选被中继', bobIce?.candidate?.candidate === 'FAKE_ICE');
  cb.send({ type: 'call_reject', to: alice.user.id, callId, reason: 'busy' });
  const aliceRej = await ca.wait(e => e.type === 'call_reject' && e.callId === callId);
  check('拒绝通话被中继', !!aliceRej);
  ca.send({ type: 'call_end', to: bob.user.id, callId, reason: 'hangup' });
  const bobEnd = await cb.wait(e => e.type === 'call_end' && e.callId === callId);
  check('挂断信令被中继', !!bobEnd);

  // 非好友的通话邀请应被丢弃
  const dave = await ensureUser('dave_' + s, 'pass1234', '戴夫');
  const cd = await connect(dave.token, dave.sessionId, dave.sessionKey);
  const blockedId = 'call_blocked_' + crypto.randomUUID();
  ca.send({ type: 'call_offer', to: dave.user.id, callId: blockedId, media: 'audio', sdp: 'X' });
  let blocked = false;
  try { await cd.wait(e => e.type === 'call_offer' && e.callId === blockedId, 1500); }
  catch (_) { blocked = true; }
  check('非好友的通话邀请被丢弃', blocked);
  cd.ws.close();

  // 通话记录：主叫方写入系统消息，双方都能收到
  ca.send({ type: 'call_log', to: bob.user.id, text: '语音通话 00:05' });
  const [logA, logB] = await Promise.all([
    ca.wait(e => e.type === 'message' && e.msg?.kind === 'system' && (e.msg?.content?.text || '').includes('语音通话')),
    cb.wait(e => e.type === 'message' && e.msg?.kind === 'system' && (e.msg?.content?.text || '').includes('语音通话')),
  ]);
  check('通话记录系统消息送达双方', !!logA && !!logB && logB.msg.content.text === '语音通话 00:05');

  cc.ws.close();
  await new Promise(r => setTimeout(r, 300));
  const offId = 'call_off_' + crypto.randomUUID();
  ca.send({ type: 'call_offer', to: carol.user.id, callId: offId, media: 'audio', sdp: 'X' });
  const failed = await ca.wait(e => e.type === 'call_failed' && e.callId === offId);
  check('呼叫离线用户返回 call_failed(offline)', failed?.reason === 'offline');

  console.log('--- 服务端聊天记录搜索（依赖服务端解密能力）---');
  const { results } = await http('GET', '/api/conversations/' + singleConvId + '/search?q=' + encodeURIComponent('加密聊天记录'), null, alice.token);
  check('搜索命中加密聊天记录', results.some(r => r.content.text === secret));

  console.log('--- 引用回复 / 表情反应 / 消息编辑 / 拍一拍 ---');
  // 引用回复
  const repId = 't_' + crypto.randomUUID();
  ca.send({ type: 'chat', msg: { msgId: repId, convType: 'single', to: bob.user.id, kind: 'text', content: { text: '被引用的原话' } } });
  await cb.wait(e => e.type === 'message' && e.msg?.msgId === repId);
  const replyId = 't_' + crypto.randomUUID();
  ca.send({ type: 'chat', msg: { msgId: replyId, convType: 'single', to: bob.user.id, kind: 'text', content: { text: '这是引用回复' }, replyTo: repId, replySnip: '我：被引用的原话' } });
  const replyGot = await cb.wait(e => e.type === 'message' && e.msg?.msgId === replyId);
  check('引用回复字段透传', replyGot?.msg?.replyTo === repId && replyGot.msg.replySnip?.includes('被引用的原话'));

  // 表情反应
  ca.send({ type: 'react', msgId: repId, emoji: '👍', on: true });
  const reactGot = await cb.wait(e => e.type === 'react' && e.msgId === repId);
  check('表情反应广播给对方', !!reactGot && reactGot.reactions?.['👍']?.includes(alice.user.id));
  // 历史消息也能带 reactions
  const hist = (await http('GET', '/api/conversations/' + singleConvId + '/messages', null, bob.token)).messages;
  check('历史消息携带 reactions 字段', hist.some(m => m.msgId === repId && m.reactions && m.reactions['👍']));

  // 消息编辑（限本人 24h 内）
  ca.send({ type: 'edit', msgId: repId, text: '被编辑后的内容' });
  const editGot = await cb.wait(e => e.type === 'edit' && e.msgId === repId);
  check('消息编辑事件广播', editGot?.text === '被编辑后的内容');
  const hist2 = (await http('GET', '/api/conversations/' + singleConvId + '/messages', null, alice.token)).messages;
  check('编辑后的内容已持久化', hist2.some(m => m.msgId === repId && m.content.text === '被编辑后的内容' && m.edited));
  // 他人消息禁止编辑
  let editDenied = false;
  try { await cb.send({ type: 'edit', msgId: replyId, text: '恶意修改' }); }
  catch (_) { editDenied = true; }
  const hist3 = (await http('GET', '/api/conversations/' + singleConvId + '/messages', null, alice.token)).messages;
  check('他人消息不可编辑', !hist3.some(m => m.msgId === replyId && m.content.text === '恶意修改'));

  // 拍一拍
  ca.send({ type: 'pat', convId: singleConvId, to: bob.user.id });
  let patGot = null;
  try {
    patGot = await cb.wait(e => e.type === 'message' && e.msg?.kind === 'system' && e.msg?.isPat, 5000);
  } catch (e) {
    console.log('  [诊断] pat 超时，cb 队列:', JSON.stringify(cb.events.map(x => ({ type: x.type, kind: x.msg?.kind, isPat: x.msg?.isPat }))).slice(0, 300));
  }
  check('拍一拍系统消息送达', !!patGot && (patGot.msg.content.text || '').includes('拍了拍'));

  console.log('--- 置顶 / 免打扰 / 全局搜索 / 收藏 / 在线状态 ---');
  await http('PATCH', '/api/conversations/' + singleConvId + '/settings', { pinned: true, muted: true }, alice.token);
  const convs2 = (await http('GET', '/api/conversations', null, alice.token)).conversations;
  const sc = convs2.find(c => c.convId === singleConvId);
  check('会话置顶 + 免打扰生效', sc?.pinned === true && sc?.muted === true);
  check('置顶会话排在列表最前', convs2[0].convId === singleConvId || convs2[0].pinned);

  // 全局搜索
  const all = (await http('GET', '/api/conversations/search/all?q=' + encodeURIComponent('加密聊天记录'), null, alice.token));
  check('全局搜索命中消息', Array.isArray(all.messages) && all.messages.some(m => (m.snip || '').includes('加密聊天记录')));

  // 收藏
  const saved = await http('POST', '/api/stickers/saved', { msg: { msgId: repId, kind: 'text', content: { text: '被引用的原话' }, snip: '被引用的原话' } }, alice.token);
  const savedList = (await http('GET', '/api/stickers/saved', null, alice.token)).saved;
  check('收藏消息并可列出', savedList.some(x => x.msg.snip === '被引用的原话'));
  await http('DELETE', '/api/stickers/saved/' + saved.id, null, alice.token);
  const savedList2 = (await http('GET', '/api/stickers/saved', null, alice.token)).saved;
  check('取消收藏生效', !savedList2.some(x => x.id === saved.id));

  // 在线状态（隐身对他人表现为离线）——用 status 精确匹配，避免命中连接时的旧 presence 事件
  await http('PUT', '/api/users/me/status', { status: 'invisible' }, bob.token);
  const pres = await ca.wait(e => e.type === 'presence' && e.userId === bob.user.id && e.status === 'invisible');
  check('隐身状态广播且对他人表现为离线', pres?.online === false && pres?.status === 'invisible');
  await http('PUT', '/api/users/me/status', { status: 'online' }, bob.token);
  const pres2 = await ca.wait(e => e.type === 'presence' && e.userId === bob.user.id && e.status === 'online' && e.online === true);
  check('恢复在线状态广播', !!pres2);

  console.log('--- 存储加密断言（数据库中不得出现明文）---');
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = db.prepare("SELECT content_enc FROM messages WHERE conv_id = ? AND kind = 'text'").all(singleConvId);
  check('数据库中不存在明文聊天记录', !rows.some(r => r.content_enc.includes(secret)));
  db.close();

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  ca.ws.close(); cb.ws.close(); cc.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(2); });

