'use strict';

const token = require('./token');
const { getUserById, safeUser } = require('./db');

/** 从 Header / query 中解析并校验 JWT，挂载 req.user */
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const m = /^Bearer (.+)$/.exec(h);
  const t = m ? m[1].trim() : (req.query.token || '');
  const payload = token.verify(t);
  if (!payload || !payload.uid) {
    return res.status(401).json({ error: '未登录或登录已过期，请重新登录' });
  }
  const user = getUserById(payload.uid);
  if (!user) return res.status(401).json({ error: '账号不存在' });
  req.user = safeUser(user);
  next();
}

module.exports = { auth };
