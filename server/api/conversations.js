'use strict';

const express = require('express');
const { db, singleConvId, groupConvId, safeUser, getUserById } = require('../db');
const { canAccessConv, convParticipants, friendList, groupIdsOf } = require('../services');
const { decryptMessageContent } = require('../crypto');
const state = require('../state');
const config = require('../config');
const { isSystemUsername } = require('../system');
const { positiveInteger, searchHistory } = require('../history-search');

const router = express.Router();

/** 数据库行 -> 前端消息对象（解密内容） */
function toMsgVO(m, viewerId, content = decryptMessageContent(m.content_enc)) {
  const vo = {
    id: m.id, msgId: m.msg_id, convType: m.conv_type, convId: m.conv_id,
    senderId: m.sender_id, groupId: m.group_id, kind: m.kind,
    content,
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

/** 会话列表（最近聊天排序，含未读数与最后一条消息） */
router.get('/', (req, res) => {
  const me = req.user.id;
  const items = [];

  const friends = friendList(me);
  const users = new Map(db.prepare('SELECT * FROM users WHERE id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(friends.map(f => f.uid))).map(u => [u.id, u]));
  for (const f of friends) {
    const u = users.get(f.uid);
    if (!u) continue;
    items.push({ convId: singleConvId(me, f.uid), convType: 'single',
      peer: { ...safeUser(u), remark: f.remark, online: state.isOnline(f.uid) } });
  }

  const groups = db.prepare(`
    SELECT g.id, g.name, g.avatar FROM group_members m JOIN groups g ON g.id = m.group_id
    WHERE m.user_id = ?
  `).all(me);
  for (const g of groups) {
    items.push({ convId: groupConvId(g.id), convType: 'group', group: g });
  }
  // 一次批量读取元数据；最新消息由 (conv_id,id) 索引定位，不扫描消息历史。
  const metadata = new Map(db.prepare(`
    SELECT c.value AS cid, m.*, u.count AS unread, u.last_read_ts, s.pinned, s.muted
    FROM json_each(?) c
    LEFT JOIN messages m ON m.id = (SELECT id FROM messages WHERE conv_id = c.value ORDER BY id DESC LIMIT 1)
    LEFT JOIN unread_counts u ON u.user_id = ? AND u.conv_id = c.value
    LEFT JOIN conv_settings s ON s.user_id = ? AND s.conv_id = c.value
  `).all(JSON.stringify(items.map(c => c.convId)), me, me).map(r => [r.cid, r]));
  for (const item of items) {
    const r = metadata.get(item.convId);
    Object.assign(item, { unread: r.unread || 0, lastReadTs: r.last_read_ts || 0,
      pinned: !!r.pinned, muted: !!r.muted,
      lastMessage: r.id ? toMsgVO(r, me) : null, lastTime: r.created_at || 0 });
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
  const current = settingsOf(req.user.id, convId);
  const body = req.body || {};
  if (['pinned', 'muted'].some(k => k in body && typeof body[k] !== 'boolean')) {
    return res.status(400).json({ error: '会话设置必须是布尔值' });
  }
  const pinned = Number(body.pinned ?? current.pinned);
  const muted = Number(body.muted ?? current.muted);
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
  const before = positiveInteger(req.query.before, Number.MAX_SAFE_INTEGER);
  const limit = positiveInteger(req.query.limit, config.historyPageSize, 100);
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
    if (u.id === uid || isSystemUsername(u.username)) continue;
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
  const parts = String(m.convId || '').split('_').slice(1).map(Number);
  const peerId = parts.length === 2 && parts.every(Number.isFinite)
    ? parts.find(x => x !== uid) : null;
  if (!peerId) return '私聊';
  const f = db.prepare('SELECT nickname FROM users WHERE id = ?').get(peerId);
  return f ? f.nickname : '私聊';
}

/** 有界分批搜索，nextBefore 用于继续检索更早记录。 */
router.get('/:convId/search', async (req, res, next) => {
  const convId = req.params.convId;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) return res.json({ results: [], nextBefore: null });
  if (q.length > 200) return res.status(400).json({ error: '搜索关键词最多 200 字' });
  if (!canAccessConv(req.user.id, convId)) {
    return res.status(403).json({ error: '无权访问该会话' });
  }
  try {
    const page = await searchHistory({ userId: req.user.id, convId, q, before: req.query.before,
      cancelled: () => res.destroyed });
    if (!page || res.destroyed) return;
    // 批次间成员关系或消息可能变动，返回前重验权限与撤回状态。
    if (!canAccessConv(req.user.id, convId)) return res.status(403).json({ error: '无权访问该会话' });
    const current = db.prepare('SELECT * FROM messages WHERE id = ? AND revoked = 0');
    const results = [];
    for (const { row } of page.matches) {
      const m = current.get(row.id);
      if (!m) continue;
      const content = decryptMessageContent(m.content_enc);
      if (typeof content.text === 'string' && content.text.includes(q)) results.push(toMsgVO(m, req.user.id, content));
    }
    res.json({ results, nextBefore: page.nextBefore });
  } catch (err) {
    if (res.destroyed) return;
    if (err.status === 429) return res.status(429).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
module.exports.toMsgVO = toMsgVO;
