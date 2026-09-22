'use strict';

/**
 * 极简 JWT（HMAC-SHA256，无外部依赖）
 * 格式：base64url(payload).base64url(signature)
 */

const crypto = require('node:crypto');
const config = require('./config');

function b64url(input) {
  const buf = Buffer.from(typeof input === 'string' ? input : JSON.stringify(input));
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

function sign(payload, expiresInSec) {
  const now = Math.floor(Date.now() / 1000);
  const data = { ...payload, iat: now, exp: now + (expiresInSec || config.jwtExpiresSec) };
  const body = b64url(data);
  const sig = hmac(body);
  return body + '.' + sig;
}

function hmac(body) {
  return crypto.createHmac('sha256', config.jwtSecret)
    .update(body)
    .digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function verify(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = hmac(body);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(body));
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

module.exports = { sign, verify };
