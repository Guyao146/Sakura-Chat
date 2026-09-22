'use strict';

const express = require('express');
const token = require('../token');
const { auth } = require('../middleware');
const { genId, genSessionKey, makeSalt, hashPassword, verifyPassword } = require('../crypto');
const { db, getUserByUsername, getUserById, safeUser } = require('../db');
const { ensureFriendWithSystem, isSystemUsername } = require('../system');
const state = require('../state');

const router = express.Router();

function validUsername(u) {
  return typeof u === 'string' && /^[a-zA-Z0-9_]{3,20}$/.test(u);
}
function validPassword(p) {
  return typeof p === 'string' && p.length >= 6 && p.length <= 32;
}

/** 颁发一个新会话密钥（应用层传输加密用），不落盘 */
function issueSession(userId) {
  const sid = genId('sess');
  const key = genSessionKey();
  state.bindSession(userId, sid, key);
  return { sessionId: sid, sessionKey: key.toString('base64') };
}

// 注册
router.post('/register', (req, res) => {
  const { username, password, nickname } = req.body || {};
  if (!validUsername(username)) return res.status(400).json({ error: '用户名需为 3-20 位字母、数字或下划线' });
  if (!validPassword(password)) return res.status(400).json({ error: '密码长度需为 6-32 位' });
  const nick = (typeof nickname === 'string' && nickname.trim()) || username;
  if (getUserByUsername(username)) return res.status(409).json({ error: '该用户名已被注册' });

  const salt = makeSalt();
  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO users (username, nickname, password_hash, salt, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(username, nick, hashPassword(password, salt), salt, now, now);
  const user = safeUser(getUserById(info.lastInsertRowid));
  ensureFriendWithSystem(user.id);   // 自动成为「文件传输助手」好友
  res.json({ message: '注册成功', user });
});

// 登录
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
  if (isSystemUsername(username)) return res.status(403).json({ error: '该账号不可登录' });
  const u = getUserByUsername(username);
  if (!u || !verifyPassword(password, u.salt, u.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), u.id);
  const t = token.sign({ uid: u.id, username: u.username });
  const sess = issueSession(u.id);
  res.json({
    token: t,
    user: safeUser(u),
    sessionId: sess.sessionId,
    sessionKey: sess.sessionKey,
  });
});

// 刷新会话密钥（页面刷新后重新获取，避免长期保存密钥）
router.get('/session', auth, (req, res) => {
  const sess = issueSession(req.user.id);
  res.json(sess);
});

// 当前登录者信息
router.get('/me', auth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
module.exports.issueSession = issueSession;
