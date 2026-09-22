'use strict';

/**
 * 自定义表情包（QQ 式）：用户上传任意图片作为自己的表情
 * 我的收藏（Telegram Saved Messages）：服务端留存任意消息
 */

const express = require('express');
const { db } = require('../db');
const { encryptMessageContent, decryptMessageContent } = require('../crypto');

const router = express.Router();

/* ---- 我的收藏（须置于 /:id 之前，避免被动态参数抢先匹配）---- */

// 收藏列表
router.get('/saved', (req, res) => {
  const rows = db.prepare('SELECT id, msg_json, created_at FROM saved_messages WHERE user_id = ? ORDER BY id DESC')
    .all(req.user.id);
  const items = rows.map(r => {
    try {
      // decryptMessageContent 内部已 JSON.parse，直接得到对象
      return { id: r.id, msg: decryptMessageContent(r.msg_json), savedAt: r.created_at };
    } catch (_) {
      console.error('[saved] decrypt fail id=' + r.id, _.message);
      return null;
    }
  }).filter(Boolean);
  res.json({ saved: items });
});

// 收藏一条消息（前端传入完整 msg 对象）
router.post('/saved', (req, res) => {
  const msg = req.body.msg;
  if (!msg || typeof msg !== 'object') return res.status(400).json({ error: '无效的消息' });
  const json = JSON.stringify(msg);
  if (Buffer.byteLength(json) > 64 * 1024) return res.status(400).json({ error: '消息过大' });
  const info = db.prepare('INSERT INTO saved_messages (user_id, msg_json, created_at) VALUES (?, ?, ?)')
    .run(req.user.id, encryptMessageContent(msg), Date.now());
  res.json({ id: Number(info.lastInsertRowid), savedAt: Date.now() });
});

// 取消收藏
router.delete('/saved/:id', (req, res) => {
  db.prepare('DELETE FROM saved_messages WHERE id = ? AND user_id = ?')
    .run(Number(req.params.id), req.user.id);
  res.json({ message: 'ok' });
});

/* ---- 自定义表情包 ---- */

// 我的自定义表情列表
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT id, url, created_at FROM user_stickers WHERE user_id = ? ORDER BY id DESC')
    .all(req.user.id);
  res.json({ stickers: rows });
});

// 添加自定义表情（url 来自 /api/upload）
router.post('/', (req, res) => {
  const url = String(req.body.url || '');
  if (!url.startsWith('/uploads/')) return res.status(400).json({ error: '无效的表情地址' });
  const row = db.prepare('SELECT id FROM user_stickers WHERE user_id = ? AND url = ?').get(req.user.id, url);
  if (row) return res.status(409).json({ error: '表情已存在' });
  const info = db.prepare('INSERT INTO user_stickers (user_id, url, created_at) VALUES (?, ?, ?)')
    .run(req.user.id, url, Date.now());
  res.json({ id: Number(info.lastInsertRowid), url });
});

// 删除自定义表情
router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM user_stickers WHERE id = ? AND user_id = ?')
    .run(Number(req.params.id), req.user.id);
  res.json({ message: 'ok' });
});

module.exports = router;
