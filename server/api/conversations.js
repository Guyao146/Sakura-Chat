'use strict';

const express = require('express');
const { db, singleConvId, groupConvId, safeUser, getUserById } = require('../db');
const { canAccessConv, convParticipants, friendList, groupIdsOf } = require('../services');
const { decryptMessageContent } = require('../crypto');
const state = require('../state');
const config = require('../config');

const router = express.Router();

function lastMessageOf(convId) {
  return db.prepare('SELECT * FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT 1').get(convId) || null;
}

function unreadOf(userId, convId) {
  const r = db.prepare('SELECT count FROM unread_counts WHERE user_id = ? AND conv_id = ?').get(userId, convId);
  return r ? r.count : 0;
}

/** 数据库行 -> 前端消息对象（解密内容） */
function toMsgVO(m, viewerId) {
  const vo = {
    id: m.id, msgId: m.msg_id, convType: m.conv_type, convId: m.conv_id,
    senderId: m.sender_id, groupId: m.group_id, kind: m.kind,
    content: decryptMessageContent(m.content_enc),
    createdAt: m.created_at, revoked: !!m.revoked,
  };
  if (m.reply_to) vo.replyTo = m.reply_to;
  if (m.reply_snip) vo.replySnip = m.reply_snip;
  if (m.forward_from) vo.forwardFrom = m.forward_from;
  if (m.ats) { try { vo.ats = JSON.parse(m.ats); } catch (_) {} }
  if (m.edited) { vo.edited = 1; vo.editedAt = m.edited_at; }
  if (m.reactions) { try { vo.reactions = JSON.parse(m.reactions); } catch (_) {} }
  if (m.conv_type === 'single' && m.sender_id === viewerId) {
    vo.status = m.revoked ? 'revoked'
      : m.read_at ? 'read'
      : m.delivered ? 'delivered' : 'sent';
  }
  return vo;
}

/** 会话级设置（置顶/免打扰） */
function settingsOf(userId, convId) {
  const r = db.prepare('SELECT pinned, muted FROM conv_settings WHERE user_id = ? AND conv_id = ?')
    .get(userId, convId);
  return { pinned: r ? !!r.pinned : false, muted: r ? !!r.muted : false };
}

/** 会话最后已读时间戳（用于未读分界线） */
function lastReadTsOf(userId, convId) {
  const r = db.prepare('SELECT last_read_ts FROM unread_counts WHERE user_id = ? AND conv_id = ?')
    .get(userId, convId);
  return r ? r.last_read_ts : 0;
}

/** 会话列表（最近聊天排序，含未读数与最后一条消息） */
router.get('/', (req, res) => {
  const me = req.user.id;
  const items = [];

  const friends = db.prepare(`
    SELECT friend_id AS uid, remark FROM friendships WHERE user_id = ? AND status = 1
    UNION
    SELECT user_id AS uid, '' AS remark FROM friendships WHERE friend_id = ? AND status = 1
  `).all(me, me);
  for (const f of friends) {
    const convId = singleConvId(me, f.uid);
    const last = lastMessageOf(convId);
    const u = getUserById(f.uid);
    const st = settingsOf(me, convId);
    items.push({
      convId, convType: 'single',
      peer: { ...safeUser(u), remark: f.remark, online: state.isOnline(f.uid) },
      unread: unreadOf(me, convId),
      lastMessage: last ? toMsgVO(last, me) : null,
      lastTime: last ? last.created_at : 0,
      pinned: st.pinned, muted: st.muted,
      lastReadTs: lastReadTsOf(me, convId),
    });
  }

  const groups = db.prepare(`
    SELECT g.id, g.name, g.avatar FROM group_members m JOIN groups g ON g.id = m.group_id
    WHERE m.user_id = ?
  `).all(me);
  for (const g of groups) {
    const convId = groupConvId(g.id);
    const last = lastMessageOf(convId);
    const st = settingsOf(me, convId);
    items.push({
      convId, convType: 'group',
      group: { id: g.id, name: g.name, avatar: g.avatar },
      unread: unreadOf(me, convId),
      lastMessage: last ? toMsgVO(last, me) : null,
      lastTime: last ? last.created_at : 0,
      pinned: st.pinned, muted: st.muted,
      lastReadTs: lastReadTsOf(me, convId),
    });
  }

  // 置顶优先，其次按最近消息时间
  items.sort((a, b) => (b.pinned - a.pinned) || (b.lastTime - a.lastTime));
  res.json({ conversations: items });
});

/** 修改会话设置（置顶 / 免打扰） */
router.patch('/:convId/settings', (req, res) => {
  const convId = req.params.convId;
  if (!canAccessConv(req.user.id, convId)) {
    return res.status(403).json({ error: '无权访问该会话' });
  }
  const pinned = req.body.pinned === true ? 1 : 0;
  const muted = req.body.muted === true ? 1 : 0;
  db.prepare(`
    INSERT INTO conv_settings (user_id, conv_id, pinned, muted) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, conv_id) DO UPDATE SET pinned = ?, muted = ?
  `).run(req.user.id, convId, pinned, muted, pinned, muted);
  res.json({ message: 'ok', pinned: !!pinned, muted: !!muted });
});

/** 历史消息（按服务器 id 倒序分页，返回时正序） */
router.get('/:convId/messages', (req, res) => {
  const convId = req.params.convId;
  if (!canAccessConv(req.user.id, convId)) {
    return res.status(403).json({ error: '无权访问该会话' });
  }
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const limit = Math.min(Number(req.query.limit) || config.historyPageSize, 100);
  const rows = db.prepare('SELECT * FROM messages WHERE conv_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
    .all(convId, before, limit);
  const messages = rows.map(m => toMsgVO(m, req.user.id)).reverse();
  res.json({ messages, hasMore: rows.length === limit });
});

/** 标记会话已读并通知对方已读回执 */
router.post('/:convId/read', (req, res) => {
  const convId = req.params.convId;
  if (!canAccessConv(req.user.id, convId)) {
    return res.status(403).json({ error: '无权访问该会话' });
  }
  const now = Date.now();
  db.prepare(`
    INSERT INTO unread_counts (user_id, conv_id, count, last_read_ts) VALUES (?, ?, 0, ?)
    ON CONFLICT(user_id, conv_id) DO UPDATE SET count = 0, last_read_ts = ?
  `).run(req.user.id, convId, now, now);
  if (convId.startsWith('u_')) {
    const other = convParticipants(convId).find(x => x !== req.user.id);
    const info = db.prepare(
      'UPDATE messages SET read_at = ?, delivered = 1 WHERE conv_id = ? AND receiver_id = ? AND read_at IS NULL'
    ).run(now, convId, req.user.id);
    if (other) state.sendToUser(other, { type: 'read', convId, ts: now, count: info.changes });
  }
  res.json({ message: 'ok' });
});

/** 全局搜索（跨所有会话，Telegram 式：会话 / 群组 / 用户 / 消息） */
router.get('/search/all', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ conversations: [], groups: [], users: [], messages: [] });
  const uid = req.user.id;

  // 1) 消息：当前用户可访问的全部会话
  const convIds = [];
  for (const f of friendList(uid)) convIds.push(singleConvId(uid, f.uid));
  for (const gid of groupIdsOf(uid)) convIds.push(groupConvId(gid));
  const messages = [];
  if (convIds.length) {
    const placeholders = convIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT * FROM messages WHERE conv_id IN (${placeholders}) ORDER BY id DESC LIMIT 300`
    ).all(...convIds);
    for (const m of rows) {
      if (m.kind !== 'text' && m.kind !== 'emoji') continue;
      if (m.revoked) continue;
      let content;
      try { content = decryptMessageContent(m.content_enc); } catch (_) { continue; }
      if ((content.text || '').includes(q)) {
        const vo = toMsgVO(m, uid);
        messages.push({
          ...vo,
          snip: previewOf(vo),
          convName: convNameOf(vo, uid),
        });
        if (messages.length >= 30) break;
      }
    }
  }

  // 2) 会话（单聊对端 / 群）
  const conversations = [];
  for (const f of friendList(uid)) {
    const u = getUserById(f.uid);
    if (!u) continue;
    const name = f.remark || u.nickname || '';
    if (name.includes(q)) {
      conversations.push({
        convId: singleConvId(uid, f.uid), convType: 'single', peer: safeUser(u),
        snip: name,
      });
    }
  }

  // 3) 群组
  const groups = [];
  for (const gid of groupIdsOf(uid)) {
    const g = db.prepare('SELECT id, name, avatar FROM groups WHERE id = ?').get(gid);
    if (g && g.name.includes(q)) {
      const memberCount = db.prepare('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?').get(gid).n;
      groups.push({ ...g, memberCount });
    }
  }

  // 4) 用户（按用户名/昵称模糊匹配，上限 20）
  const users = [];
  const userRows = db.prepare(
    `SELECT id, username, nickname, avatar, signature FROM users
     WHERE username LIKE ? OR nickname LIKE ? LIMIT 20`
  ).all('%' + q + '%', '%' + q + '%');
  for (const u of userRows) {
    if (u.id === uid) continue;
    users.push(safeUser(u));
  }

  res.json({ conversations, groups, users, messages });
});

function previewOf(m) {
  if (m.kind === 'image') return '[图片]';
  if (m.kind === 'voice') return '[语音]';
  if (m.kind === 'sticker') return '[表情]';
  if (m.kind === 'file') return '[文件]';
  return m.content?.text || '';
}

function convNameOf(m, uid) {
  if (m.convType === 'group') {
    const g = db.prepare('SELECT name FROM groups WHERE id = ?').get(m.groupId);
    return g ? g.name : '群聊';
  }
  // 单聊：从 convId（u_min_max）解析对端 id
  const parts = String(m.convId || '').split('_').map(Number);
  const peerId = parts.length === 3 && parts.every(Number.isFinite)
    ? parts.find(x => x !== uid) : null;
  if (!peerId) return '私聊';
  const f = db.prepare('SELECT nickname FROM users WHERE id = ?').get(peerId);
  return f ? f.nickname : '私聊';
}

/** 聊天记录搜索（服务端解密后检索 —— 此加密方案的核心能力之一） */
router.get('/:convId/search', (req, res) => {
  const convId = req.params.convId;
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  if (!canAccessConv(req.user.id, convId)) {
    return res.status(403).json({ error: '无权访问该会话' });
  }
  const rows = db.prepare('SELECT * FROM messages WHERE conv_id = ? ORDER BY id ASC').all(convId);
  const results = [];
  for (const m of rows) {
    if (m.kind !== 'text' && m.kind !== 'emoji') continue;
    let content;
    try { content = decryptMessageContent(m.content_enc); } catch (_) { continue; }
    const text = content.text || '';
    if (text.includes(q)) {
      results.push(toMsgVO(m, req.user.id));
      if (results.length >= 30) break;
    }
  }
  res.json({ results });
});

module.exports = router;
module.exports.toMsgVO = toMsgVO;
