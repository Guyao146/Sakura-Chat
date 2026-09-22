'use strict';

const express = require('express');
const { db, getUserById, safeUser } = require('../db');
const state = require('../state');
const svc = require('../services');

const router = express.Router();

// 搜索用户（按用户名或昵称，排除自己）
router.get('/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ users: [] });
  const like = '%' + q.replace(/[%_]/g, c => '\\' + c) + '%';
  const rows = db.prepare(`
    SELECT id, username, nickname, avatar, signature FROM users
    WHERE id != ? AND (username LIKE ? ESCAPE '\\' OR nickname LIKE ? ESCAPE '\\')
    ORDER BY id LIMIT 20
  `).all(req.user.id, like, like);
  const users = rows.map(r => ({
    ...safeUser(r),
    online: state.isOnline(r.id),
  }));
  res.json({ users });
});

// 用户公开资料
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: '无效的用户' });
  const u = getUserById(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  res.json({ user: { ...safeUser(u), online: state.isOnline(id) } });
});

/* ---- 在线状态（Discord/QQ 式：在线/离开/忙碌/隐身 + 自定义状态）---- */
const STATUSES = new Set(['', 'online', 'idle', 'dnd', 'invisible']);

/** 获取自己的状态 */
router.get('/me/status', (req, res) => {
  const u = getUserById(req.user.id);
  res.json({ status: u.status || '', lastSeen: u.last_seen || 0 });
});

/** 设置自己的状态（隐身时对他人表现为离线） */
router.put('/me/status', (req, res) => {
  const status = STATUSES.has(req.body.status) ? req.body.status : '';
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, req.user.id);
  // 实时通知好友/群友
  const visible = status === 'invisible' ? false : state.isOnline(req.user.id);
  svc.broadcastPresence(req.user.id, visible, status || (visible ? 'online' : 'offline'));
  res.json({ status });
});

// 修改个人资料
router.put('/profile', (req, res) => {
  const { nickname, signature, avatar } = req.body || {};
  const sets = [];
  const params = [];
  if (typeof nickname === 'string' && nickname.trim()) {
    if (nickname.length > 20) return res.status(400).json({ error: '昵称最多 20 个字符' });
    sets.push('nickname = ?'); params.push(nickname.trim());
  }
  if (typeof signature === 'string') {
    if (signature.length > 50) return res.status(400).json({ error: '个性签名最多 50 个字符' });
    sets.push('signature = ?'); params.push(signature);
  }
  if (typeof avatar === 'string' && avatar.startsWith('/uploads/')) {
    sets.push('avatar = ?'); params.push(avatar);
  }
  if (!sets.length) return res.status(400).json({ error: '没有可更新的字段' });
  params.push(req.user.id);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  res.json({ user: safeUser(getUserById(req.user.id)) });
});

module.exports = router;
