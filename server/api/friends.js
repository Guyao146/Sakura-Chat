'use strict';

const express = require('express');
const { db, singleConvId, safeUser, getUserById } = require('../db');
const { friendList } = require('../services');
const { isSystemId } = require('../system');
const state = require('../state');
const { insertSystemMessage } = require('../messaging');

const router = express.Router();

// 好友列表
router.get('/', (req, res) => {
  const rows = friendList(req.user.id);
  const friends = rows.map(r => {
    const u = getUserById(r.uid);
    return { ...safeUser(u), remark: r.remark, online: state.isOnline(r.uid) };
  });
  res.json({ friends });
});

// 收到的好友请求（待处理）
router.get('/requests', (req, res) => {
  const rows = db.prepare(`
    SELECT f.id, f.created_at, f.remark, u.id AS uid, u.username, u.nickname, u.avatar
    FROM friendships f JOIN users u ON u.id = f.user_id
    WHERE f.friend_id = ? AND f.status = 0
    ORDER BY f.created_at DESC
  `).all(req.user.id);
  res.json({ requests: rows });
});

// 发送好友请求
router.post('/request', (req, res) => {
  const toId = Number(req.body.userId);
  const remark = typeof req.body.remark === 'string' ? req.body.remark.slice(0, 30) : '';
  if (!toId || toId === req.user.id) return res.status(400).json({ error: '无效的用户' });
  if (isSystemId(toId)) return res.status(409).json({ error: '文件传输助手已是你的好友，直接开始聊天即可' });
  if (!getUserById(toId)) return res.status(404).json({ error: '用户不存在' });

  // 已经是好友
  const exist = db.prepare(`
    SELECT 1 FROM friendships
    WHERE ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)) AND status = 1
  `).get(req.user.id, toId, toId, req.user.id);
  if (exist) return res.status(409).json({ error: '你们已经是好友了' });

  const now = Date.now();
  // 若对方已向我发送过请求，则直接通过（双向奔赴）
  const reverse = db.prepare('SELECT id FROM friendships WHERE user_id = ? AND friend_id = ? AND status = 0')
    .get(toId, req.user.id);
  if (reverse) {
    acceptFriendship(req.user.id, toId, reverse.id, now);
    return res.json({ message: '已添加为好友', accepted: true, friend: safeUser(getUserById(toId)) });
  }

  // 我此前发过的待处理请求：更新备注与时间
  const mine = db.prepare('SELECT id FROM friendships WHERE user_id = ? AND friend_id = ? AND status = 0')
    .get(req.user.id, toId);
  if (mine) {
    db.prepare('UPDATE friendships SET remark = ?, created_at = ? WHERE id = ?').run(remark, now, mine.id);
  } else {
    db.prepare('INSERT INTO friendships (user_id, friend_id, remark, status, created_at) VALUES (?, ?, ?, 0, ?)')
      .run(req.user.id, toId, remark, now);
  }

  // 实时推送给对方
  const me = getUserById(req.user.id);
  state.sendToUser(toId, {
    type: 'friend_request',
    request: { id: mine ? mine.id : null, from: safeUser(me), remark, createdAt: now },
  });
  res.json({ message: '请求已发送' });
});

// 同意好友请求
router.post('/requests/:id/accept', (req, res) => {
  const reqId = Number(req.params.id);
  const row = db.prepare('SELECT * FROM friendships WHERE id = ? AND friend_id = ? AND status = 0')
    .get(reqId, req.user.id);
  if (!row) return res.status(404).json({ error: '请求不存在或已处理' });
  acceptFriendship(req.user.id, row.user_id, reqId, Date.now());
  res.json({ message: '已添加为好友', friend: safeUser(getUserById(row.user_id)) });
});

// 拒绝好友请求
router.post('/requests/:id/reject', (req, res) => {
  const reqId = Number(req.params.id);
  db.prepare('UPDATE friendships SET status = 2, handled_at = ? WHERE id = ? AND friend_id = ? AND status = 0')
    .run(Date.now(), reqId, req.user.id);
  res.json({ message: '已拒绝' });
});

// 删除好友
router.delete('/:id', (req, res) => {
  const fid = Number(req.params.id);
  if (!fid) return res.status(400).json({ error: '无效的用户' });
  if (isSystemId(fid)) return res.status(400).json({ error: '文件传输助手不可删除' });
  db.prepare(`
    DELETE FROM friendships
    WHERE ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)) AND status = 1
  `).run(req.user.id, fid, fid, req.user.id);
  db.prepare('DELETE FROM unread_counts WHERE user_id = ? AND conv_id = ?')
    .run(req.user.id, singleConvId(req.user.id, fid));
  res.json({ message: '已删除好友' });
});

/** 建立双向好友关系并通知对方 */
function acceptFriendship(meId, otherId, reqId, now) {
  db.prepare('UPDATE friendships SET status = 1, handled_at = ? WHERE id = ?').run(now, reqId);
  db.prepare(`
    INSERT INTO friendships (user_id, friend_id, remark, status, created_at) VALUES (?, ?, '', 1, ?)
    ON CONFLICT(user_id, friend_id) DO UPDATE SET status = 1, handled_at = ?
  `).run(meId, otherId, now, now);

  const convId = singleConvId(meId, otherId);
  insertSystemMessage('single', convId, '你们已成为好友，可以开始聊天了');

  const me = getUserById(meId);
  state.sendToUser(otherId, { type: 'friend_accepted', friend: safeUser(me), convId });
}

module.exports = router;
