'use strict';

const express = require('express');
const token = require('../token');
const { auth } = require('../middleware');
const { genId, genSessionKey, makeSalt, hashPasswordAsync, verifyPassword } = require('../crypto');
const { db, getUserByUsername, getUserById, safeUser } = require('../db');
const { ensureFriendWithSystem, isSystemUsername } = require('../system');
const state = require('../state');
const oauth = require('../oauth');

const router = express.Router();
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(err => {
  if (err.status === 429) res.status(429).json({ error: err.message });
  else next(err);
});

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
router.post('/register', asyncRoute(async (req, res) => {
  const { username, password, nickname } = req.body || {};
  if (!validUsername(username)) return res.status(400).json({ error: '用户名需为 3-20 位字母、数字或下划线' });
  if (!validPassword(password)) return res.status(400).json({ error: '密码长度需为 6-32 位' });
  const nick = (typeof nickname === 'string' && nickname.trim()) || username;
  if (getUserByUsername(username)) return res.status(409).json({ error: '该用户名已被注册' });

  const salt = makeSalt();
  const hash = await hashPasswordAsync(password, salt);
  // 异步计算期间同名注册可能先完成，插入前再次检查。
  if (getUserByUsername(username)) return res.status(409).json({ error: '该用户名已被注册' });
  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO users (username, nickname, password_hash, salt, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(username, nick, hash, salt, now, now);
  const user = safeUser(getUserById(info.lastInsertRowid));
  ensureFriendWithSystem(user.id);   // 自动成为「文件传输助手」好友
  res.json({ message: '注册成功', user });
}));

// 登录
router.post('/login', asyncRoute(async (req, res) => {
  const { username, password } = req.body || {};
  if (!validUsername(username) || !validPassword(password)) return res.status(400).json({ error: '请输入有效的用户名和密码' });
  if (isSystemUsername(username)) return res.status(403).json({ error: '该账号不可登录' });
  const u = getUserByUsername(username);
  if (!u || !await verifyPassword(password, u.salt, u.password_hash)) {
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
}));

// 刷新会话密钥（页面刷新后重新获取，避免长期保存密钥）
router.get('/session', auth, asyncRoute(async (req, res) => {
  const sess = issueSession(req.user.id);
  res.json(sess);
}));

// 当前登录者信息
router.get('/me', auth, (req, res) => {
  res.json({ user: req.user });
});

// 第三方登录（可选）：已配置的 OIDC 提供方清单，供登录页渲染按钮
router.get('/providers', (req, res) => {
  res.json({ providers: oauth.listProviders() });
});

// 第三方登录：发起授权（302 到身份提供方）。state 与 PKCE verifier 仅存服务端。
router.get('/oauth/:provider/start', asyncRoute(async (req, res) => {
  const provider = oauth.getProvider(req.params.provider);
  if (!provider) return res.status(404).json({ error: '未配置该登录方式' });
  const url = await oauth.startAuthorize(provider, oauth.requestBase(req));
  res.redirect(url);
}));

// 第三方登录：授权码回调 → 校验 state → 换令牌 → 查找/创建账号 → 签发一次性票据
router.get('/oauth/:provider/callback', asyncRoute(async (req, res) => {
  const provider = oauth.getProvider(req.params.provider);
  const fail = msg => res.redirect('/login?oauth=error&msg=' + encodeURIComponent(msg || '第三方登录失败'));
  if (!provider) return fail('未配置该登录方式');
  try {
    const identity = await oauth.finishAuthorize(provider, req.query);
    const u = oauth.resolveUser(identity);
    const sess = issueSession(u.id);
    const ticket = oauth.issueTicket({
      token: token.sign({ uid: u.id, username: u.username }),
      user: safeUser(u),
      sessionId: sess.sessionId,
      sessionKey: sess.sessionKey,
    });
    oauth.setTicketCookie(res, ticket);
    return res.redirect('/login?oauth=callback');
  } catch (err) {
    console.error('[oauth] 第三方登录回调失败：', err.message);
    return fail(err.message);
  }
}));

// 第三方登录：前端用票据 Cookie 换取本站 JWT + 会话密钥
router.post('/oauth/finish', asyncRoute(async (req, res) => {
  const payload = oauth.consumeTicket(oauth.readTicketCookie(req));
  if (!payload) return res.status(401).json({ error: '第三方登录票据不存在或已过期，请重新登录' });
  oauth.clearTicketCookie(res);
  res.json(payload);
}));

module.exports = router;
module.exports.issueSession = issueSession;
