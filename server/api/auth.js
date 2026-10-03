'use strict';

const express = require('express');
const token = require('../token');
const { auth } = require('../middleware');
const { genId, genSessionKey, makeSalt, hashPasswordAsync, verifyPassword } = require('../crypto');
const { db, getUserByUsername, getUserById, safeUser } = require('../db');
const { ensureFriendWithSystem, isSystemUsername } = require('../system');
const state = require('../state');
const oauth = require('../oauth');
const { loginLimiter, registerLimiter, clientIp, loginKey } = require('../rate-limit');

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

// 注册（每 IP 限频，防批量刷号）
router.post('/register', asyncRoute(async (req, res) => {
  const { username, password, nickname } = req.body || {};
  const rk = clientIp(req);
  if (registerLimiter.tooMany(rk)) {
    return res.status(429).json({ error: '注册过于频繁，请稍后再试' });
  }
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
  registerLimiter.hit(rk);   // 成功注册计入配额
  res.json({ message: '注册成功', user });
}));

// 登录（失败 5 次锁 60 秒，计数按 ip+用户名隔离）
router.post('/login', asyncRoute(async (req, res) => {
  const { username, password } = req.body || {};
  if (!validUsername(username) || !validPassword(password)) return res.status(400).json({ error: '请输入有效的用户名和密码' });
  const lk = loginKey(req, username);
  if (loginLimiter.tooMany(lk)) {
    return res.status(429).json({ error: '登录失败次数过多，请 1 分钟后再试' });
  }
  if (isSystemUsername(username)) return res.status(403).json({ error: '该账号不可登录' });
  const u = getUserByUsername(username);
  if (!u || !await verifyPassword(password, u.salt, u.password_hash)) {
    loginLimiter.hit(lk);
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  loginLimiter.clear(lk);   // 成功即清零，不累积历史失败
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

/** 从 Authorization 头手动解析已登录用户（finish 路由按票据模式按需鉴权，不强制全部请求登录） */
function bearerUser(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const payload = token.verify(m[1].trim());
  if (!payload || !payload.uid) return null;
  return getUserById(payload.uid);
}

// 第三方登录（可选）：已配置的 OIDC 提供方清单，供登录页渲染按钮
router.get('/providers', (req, res) => {
  res.json({ providers: oauth.listProviders() });
});

// 第三方登录：发起授权（302 到身份提供方）。state 与 PKCE verifier 仅存服务端。
//   ?link=1 为「绑定已有账号」模式：无需在跳转时鉴权，绑定动作在 finish 时凭票据+登录态完成
router.get('/oauth/:provider/start', asyncRoute(async (req, res) => {
  const provider = oauth.getProvider(req.params.provider);
  if (!provider) return res.status(404).json({ error: '未配置该登录方式' });
  const url = await oauth.startAuthorize(provider, oauth.requestBase(req), {
    mode: req.query.link === '1' ? 'link' : 'login',
  });
  res.redirect(url);
}));

// 第三方登录：授权码回调 → 校验 state → 换令牌
//   登录模式：查找/创建账号 → 签发一次性票据 → 302 回 /login?oauth=callback
//   绑定模式：签发携带外部身份的一次性票据 → 302 回 /?oauth=link（由已登录的前端消费）
router.get('/oauth/:provider/callback', asyncRoute(async (req, res) => {
  const provider = oauth.getProvider(req.params.provider);
  const fail = msg => res.redirect('/login?oauth=error&msg=' + encodeURIComponent(msg || '第三方登录失败'));
  if (!provider) return fail('未配置该登录方式');
  try {
    const { identity, mode } = await oauth.finishAuthorize(provider, req.query);
    if (mode === 'link') {
      const ticket = oauth.issueTicket({ mode: 'link', identity });
      oauth.setTicketCookie(res, ticket);
      return res.redirect('/?oauth=link');
    }
    const u = await oauth.resolveUser(identity);
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

// 第三方登录/绑定：前端用票据 Cookie 完成流程
//   登录票据：换取本站 JWT + 会话密钥
//   绑定票据（mode=link）：要求有效的登录态，把外部身份绑定到当前账号
router.post('/oauth/finish', asyncRoute(async (req, res) => {
  const payload = oauth.consumeTicket(oauth.readTicketCookie(req));
  if (!payload) return res.status(401).json({ error: '第三方登录票据不存在或已过期，请重新登录' });
  oauth.clearTicketCookie(res);
  if (payload.mode === 'link') {
    const user = bearerUser(req);
    if (!user) return res.status(401).json({ error: '登录已过期，请重新登录后再绑定' });
    const result = oauth.linkIdentity(user.id, payload.identity);
    if (result.error) return res.status(409).json({ error: result.error });
    return res.json({ ok: true, user: safeUser(result.user) });
  }
  res.json(payload);
}));

// 解除当前账号的第三方身份绑定（影子账号禁止解绑，见 unlinkProvider）
router.post('/unlink', auth, asyncRoute(async (req, res) => {
  const result = oauth.unlinkProvider(req.user.id);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true, user: safeUser(result.user) });
}));

module.exports = router;
module.exports.issueSession = issueSession;
