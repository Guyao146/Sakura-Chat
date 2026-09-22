'use strict';

/**
 * WebSocket 服务器：实时消息收发、已读回执、输入中提示、撤回、在线状态
 * 所有业务载荷均经应用层 AES-256-GCM 加密（会话密钥在登录/刷新会话时下发）
 */

const { WebSocketServer } = require('ws');
const token = require('./token');
const state = require('./state');
const { decrypt, encrypt, encryptMessageContent } = require('./crypto');
const { db, singleConvId, groupConvId, getUserById } = require('./db');
const svc = require('./services');
const { insertSystemMessage } = require('./messaging');
const config = require('./config');

const KINDS = new Set(['text', 'image', 'emoji', 'file', 'voice', 'sticker']);

function send(ws, obj) {
  if (ws.readyState !== 1) return;
  const key = state.getKey(ws.userId, ws.sessionId);
  const data = key ? { sid: ws.sessionId, d: encrypt(key, JSON.stringify(obj)) } : obj;
  ws.send(JSON.stringify(data));
}

function attach(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const payload = token.verify(url.searchParams.get('token') || '');
    const sid = url.searchParams.get('sid') || '';
    if (!payload || !payload.uid) { ws.close(4001, 'unauthorized'); return; }
    const key = state.getKey(payload.uid, sid);
    ws.userId = payload.uid;
    ws.sessionId = sid;
    ws.isAlive = true;
    state.addSocket(ws);
    if (key) send(ws, { type: 'connected', encrypted: true });
    // 隐身用户对他人表现为离线
    const me = getUserById(ws.userId);
    const visible = !(me && me.status === 'invisible');
    svc.broadcastPresence(ws.userId, visible, me?.status || (visible ? 'online' : 'offline'));

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => {
      try { onMessage(ws, raw); } catch (err) { console.error('[ws] handle error:', err.message); }
    });
    ws.on('close', () => {
      state.removeSocket(ws);
      if (!state.isOnline(ws.userId)) svc.broadcastPresence(ws.userId, false);
    });
    ws.on('error', () => {});
  });

  // 心跳：30s 探活，超时连接直接终止
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch (_) {}
    }
  }, 30000);

  wss.on('close', () => { clearInterval(interval); });
}

function onMessage(ws, raw) {
  let obj;
  try { obj = JSON.parse(raw.toString()); } catch (_) { return; }
  if (!obj || typeof obj !== 'object') return;

  let payload;
  if (typeof obj.d === 'string') {
    const key = state.getKey(ws.userId, obj.sid);
    if (!key) return;                       // 找不到会话密钥，丢弃
    try { payload = JSON.parse(decrypt(key, obj.d)); } catch (_) { return; }
  } else {
    payload = obj;                          // 明文降级：仅用于 ping/pong
  }

  switch (payload.type) {
    case 'ping': send(ws, { type: 'pong' }); return;
    case 'chat': handleChat(ws, payload); return;
    case 'read': handleRead(ws, payload); return;
    case 'typing': handleTyping(ws, payload); return;
    case 'recall': handleRecall(ws, payload); return;
    case 'react': handleReact(ws, payload); return;
    case 'edit': handleEdit(ws, payload); return;
    case 'pat': handlePat(ws, payload); return;
    // 音视频通话信令（仅好友间、纯中继、不落库）
    case 'call_offer': return handleCallSignal(ws, payload, 'call_offer');
    case 'call_answer': return handleCallSignal(ws, payload, 'call_answer');
    case 'call_ice': return handleCallSignal(ws, payload, 'call_ice');
    case 'call_reject': return handleCallSignal(ws, payload, 'call_reject');
    case 'call_busy': return handleCallSignal(ws, payload, 'call_busy');
    case 'call_end': return handleCallSignal(ws, payload, 'call_end');
    case 'call_log': return handleCallLog(ws, payload);   // 通话记录（系统消息，只由主叫方发送一次）
    default: return;
  }
}

/* ---------------- 音视频通话信令中继 ---------------- */

function handleCallSignal(ws, p, type) {
  const to = Number(p.to);
  if (!to || to === ws.userId) return;
  // 仅允许好友间发起通话（与单聊消息一致的权限模型）
  if (!svc.areFriends(ws.userId, to)) return;
  if (!state.isOnline(to)) {
    send(ws, { type: 'call_failed', callId: String(p.callId || '').slice(0, 64), to, reason: 'offline' });
    return;
  }
  const out = {
    type, from: ws.userId, to,
    callId: String(p.callId || '').slice(0, 64),
    media: p.media === 'video' ? 'video' : 'audio',
  };
  if (typeof p.sdp === 'string' && p.sdp.length < 64 * 1024) out.sdp = p.sdp;
  if (p.candidate && typeof p.candidate === 'object') out.candidate = p.candidate;
  if (typeof p.reason === 'string') out.reason = p.reason.slice(0, 32);
  state.sendToUser(to, out, ws);   // 排除发送方连接，避免自己收到自己的信令
}

/* ---------------- 通话记录（写入系统消息，供双方回看） ---------------- */

function handleCallLog(ws, p) {
  const to = Number(p.to);
  if (!to || to === ws.userId) return;
  if (!svc.areFriends(ws.userId, to)) return;
  const text = String(p.text || '').slice(0, 64);
  if (!text) return;
  const convId = singleConvId(ws.userId, to);
  const sys = insertSystemMessage('single', convId, text);
  const sysMsg = {
    id: sys.id, msgId: 'sys', convType: 'single', convId, senderId: 0,
    kind: 'system', content: { text }, createdAt: sys.createdAt, revoked: 0,
  };
  // 推给通话双方（含主叫自己的其它标签页）
  state.sendToUser(ws.userId, { type: 'message', msg: sysMsg });
  state.sendToUser(to, { type: 'message', msg: sysMsg });
}

function handleChat(ws, p) {
  const m = p.msg || {};
  const userId = ws.userId;
  if (typeof m.msgId !== 'string' || !m.msgId) return;
  const kind = KINDS.has(m.kind) ? m.kind : 'text';
  const convType = m.convType === 'group' ? 'group' : 'single';

  let convId, receiverId = null, groupId = null;
  if (convType === 'single') {
    const to = Number(m.to);
    if (!to || to === userId) return;
    if (!svc.areFriends(userId, to)) return;          // 非好友禁止发送
    convId = singleConvId(userId, to);
    receiverId = to;
  } else {
    groupId = Number(m.groupId);
    if (!groupId || !svc.isGroupMember(groupId, userId)) return;
    convId = groupConvId(groupId);
  }

  const content = (m.content && typeof m.content === 'object') ? m.content : { text: String(m.content ?? '') };
  const json = JSON.stringify(content);
  if (Buffer.byteLength(json) > config.maxMessageBytes) {
    send(ws, { type: 'error', code: 'too_large', msgId: m.msgId });
    return;
  }

  // 幂等：同一 msgId 重复发送只回 ACK
  const exist = db.prepare('SELECT id, created_at, delivered FROM messages WHERE msg_id = ?').get(m.msgId);
  if (exist) {
    send(ws, { type: 'ack', msgId: m.msgId, serverId: exist.id, ts: exist.created_at, status: 'sent', delivered: exist.delivered });
    return;
  }

  // ---- 扩展字段（引用 / 转发 / @）----
  const replyTo = typeof m.replyTo === 'string' && m.replyTo.length < 128 ? m.replyTo : null;
  const replySnip = typeof m.replySnip === 'string' && m.replySnip.length < 200
    ? m.replySnip.replace(/[<>"]/g, '') : null;
  const forwardFrom = typeof m.forwardFrom === 'string' && m.forwardFrom.length < 60
    ? m.forwardFrom.replace(/[<>"]/g, '') : null;
  const ats = Array.isArray(m.ats) ? m.ats.map(Number).filter(x => Number.isInteger(x) && x > 0).slice(0, 50) : [];

  const ts = Date.now();
  const info = db.prepare(`
    INSERT INTO messages (msg_id, conv_type, conv_id, sender_id, receiver_id, group_id, kind, content_enc, created_at, delivered,
                          reply_to, reply_snip, forward_from, ats)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(m.msgId, convType, convId, userId, receiverId, groupId, kind,
      encryptMessageContent(content), ts, convType === 'group' ? 1 : 0,
      replyTo, replySnip, forwardFrom, ats.length ? JSON.stringify(ats) : null);
  const id = Number(info.lastInsertRowid);

  const recipients = convType === 'single'
    ? [receiverId]
    : svc.groupMemberIds(groupId).filter(u => u !== userId);

  const unreadStmt = db.prepare(
    'INSERT INTO unread_counts (user_id, conv_id, count) VALUES (?, ?, 1) ON CONFLICT DO UPDATE SET count = count + 1'
  );
  const vo = msgVO(id, m.msgId, convType, convId, userId, receiverId, groupId, kind, content, ts, {
    replyTo, replySnip, forwardFrom,
    ats: ats.length ? ats : null,
  });
  for (const uid of recipients) {
    unreadStmt.run(uid, convId);
    state.sendToUser(uid, { type: 'message', msg: vo });
  }

  let delivered = convType === 'group' ? 1 : 0;
  if (convType === 'single' && state.isOnline(receiverId)) {
    db.prepare('UPDATE messages SET delivered = 1 WHERE id = ?').run(id);
    delivered = 1;
  }
  send(ws, { type: 'ack', msgId: m.msgId, serverId: id, ts, status: 'sent', delivered });
  if (delivered && convType === 'single') {
    send(ws, { type: 'status', convId, msgId: m.msgId, status: 'delivered', ts });
  }
}

function msgVO(id, msgId, convType, convId, senderId, receiverId, groupId, kind, content, ts, extra = {}) {
  return {
    id, msgId, convType, convId, senderId, receiverId, groupId, kind, content,
    createdAt: ts, revoked: false,
    replyTo: extra.replyTo || null,
    replySnip: extra.replySnip || null,
    forwardFrom: extra.forwardFrom || null,
    ats: extra.ats || null,
    edited: extra.edited || 0,
    editedAt: extra.editedAt || null,
    reactions: extra.reactions || null,
  };
}

function handleRead(ws, p) {
  const convId = p.convId;
  if (!svc.canAccessConv(ws.userId, convId)) return;
  db.prepare('UPDATE unread_counts SET count = 0 WHERE user_id = ? AND conv_id = ?').run(ws.userId, convId);
  if (convId.startsWith('u_')) {
    const other = svc.convParticipants(convId).find(x => x !== ws.userId);
    const now = Date.now();
    const info = db.prepare(
      'UPDATE messages SET read_at = ?, delivered = 1 WHERE conv_id = ? AND receiver_id = ? AND read_at IS NULL'
    ).run(now, convId, ws.userId);
    if (other) state.sendToUser(other, { type: 'read', convId, ts: now, count: info.changes });
  }
}

function handleTyping(ws, p) {
  const convId = p.convId;
  if (!svc.canAccessConv(ws.userId, convId)) return;
  const evt = { type: 'typing', convId, from: ws.userId, typing: !!p.typing };
  if (convId.startsWith('u_')) {
    const other = svc.convParticipants(convId).find(x => x !== ws.userId);
    if (other) state.sendToUser(other, evt);
  } else {
    svc.broadcastToConv(convId, evt, ws.userId);
  }
}

function handleRecall(ws, p) {
  const msgId = p.msgId;
  if (typeof msgId !== 'string' || !msgId) return;
  const m = db.prepare('SELECT * FROM messages WHERE msg_id = ?').get(msgId);
  if (!m || m.sender_id !== ws.userId || m.revoked) return;
  if (Date.now() - m.created_at > config.recallWindowMs) {
    send(ws, { type: 'error', code: 'recall_too_late', msgId });
    return;
  }
  db.prepare('UPDATE messages SET revoked = 1 WHERE id = ?').run(m.id);
  const evt = { type: 'recall', msgId, convId: m.conv_id, ts: Date.now() };
  svc.broadcastToConv(m.conv_id, evt, ws.userId);
  send(ws, { ...evt, mine: true });
}

/* ---------------- 表情反应（Discord / Telegram 式） ---------------- */
function handleReact(ws, p) {
  const msgId = p.msgId;
  const emoji = String(p.emoji || '').slice(0, 8);
  if (typeof msgId !== 'string' || !msgId || !emoji) return;
  const m = db.prepare('SELECT * FROM messages WHERE msg_id = ?').get(msgId);
  if (!m || m.revoked || m.kind === 'system') return;
  if (!svc.canAccessConv(ws.userId, m.conv_id)) return;

  // reactions: {"👍": [uid, ...]}
  let map = {};
  try { map = m.reactions ? JSON.parse(m.reactions) : {}; } catch (_) { map = {}; }
  const set = new Set(map[emoji] || []);
  if (p.on) set.add(ws.userId); else set.delete(ws.userId);
  if (set.size) map[emoji] = [...set]; else delete map[emoji];
  const json = JSON.stringify(map);
  db.prepare('UPDATE messages SET reactions = ? WHERE id = ?').run(json, m.id);

  const evt = { type: 'react', msgId, convId: m.conv_id, emoji, on: !!p.on, from: ws.userId, reactions: map };
  svc.broadcastToConv(m.conv_id, evt, ws.userId);
  send(ws, { ...evt, mine: true });
}

/* ---------------- 消息编辑（Telegram 式，限本人 24 小时内） ---------------- */
function handleEdit(ws, p) {
  const msgId = p.msgId;
  if (typeof msgId !== 'string' || !msgId) return;
  const m = db.prepare('SELECT * FROM messages WHERE msg_id = ?').get(msgId);
  if (!m || m.sender_id !== ws.userId || m.revoked) return;
  if (m.kind !== 'text' && m.kind !== 'emoji') return;
  if (Date.now() - m.created_at > 24 * 3600 * 1000) {
    send(ws, { type: 'error', code: 'edit_too_late', msgId });
    return;
  }
  const text = String(p.text ?? '').slice(0, config.maxMessageBytes);
  if (!text) return;
  const content = { text };
  db.prepare('UPDATE messages SET content_enc = ?, edited = 1, edited_at = ? WHERE id = ?')
    .run(encryptMessageContent(content), Date.now(), m.id);
  const evt = { type: 'edit', msgId, convId: m.conv_id, text, editedAt: Date.now() };
  svc.broadcastToConv(m.conv_id, evt, ws.userId);
  send(ws, { ...evt, mine: true });
}

/* ---------------- 拍一拍（微信式轻互动） ---------------- */
function handlePat(ws, p) {
  const convId = p.convId;
  if (typeof convId !== 'string' || !svc.canAccessConv(ws.userId, convId)) return;
  const to = Number(p.to);
  const me = getUserById(ws.userId);
  const who = to ? getUserById(to) : null;
  if (to && !who) return;
  const text = `🤚 ${me.nickname} 拍了拍${who && who.id !== ws.userId ? ' ' + who.nickname : '自己'}`;
  const sys = insertSystemMessage(convId.startsWith('g_') ? 'group' : 'single', convId, text);
  const sysMsg = {
    id: sys.id, msgId: 'sys_pat_' + sys.id, convType: convId.startsWith('g_') ? 'group' : 'single',
    convId, senderId: 0, kind: 'system', content: { text }, createdAt: sys.createdAt, revoked: 0,
    isPat: true, patTo: to || null,
  };
  svc.broadcastToConv(convId, { type: 'message', msg: sysMsg });
}

module.exports = { attach, send };

