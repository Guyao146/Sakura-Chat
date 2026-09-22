'use strict';

/**
 * 加密工具集
 * - AES-256-GCM，IV(12B) + 密文 + Tag(16B)，Base64 编码
 * - 该格式与浏览器 Web Crypto API 的 AES-GCM 输出完全兼容（ciphertext||tag）
 */

const crypto = require('node:crypto');
const config = require('./config');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function encrypt(keyBuf, plaintext) {
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv(ALGO, keyBuf, iv);
  const enc = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, enc, tag]).toString('base64');
}

function decrypt(keyBuf, b64) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < IV_LEN + TAG_LEN) throw new Error('bad ciphertext length');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const enc = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const d = crypto.createDecipheriv(ALGO, keyBuf, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

/* ---------------- 存储加密（聊天记录落库） ---------------- */

function encryptMessageContent(obj) {
  return encrypt(config.dataKey, JSON.stringify(obj));
}

function decryptMessageContent(b64) {
  return JSON.parse(decrypt(config.dataKey, b64));
}

/* ---------------- 会话密钥（应用层传输加密） ---------------- */

function genSessionKey() {
  return crypto.randomBytes(32);
}

/* ---------------- 密码哈希（scrypt） ---------------- */

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64, SCRYPT_OPTS).toString('hex');
}

function verifyPassword(password, salt, expectedHash) {
  const actual = crypto.scryptSync(password, salt, 64, SCRYPT_OPTS);
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/* ---------------- 通用工具 ---------------- */

function genId(prefix) {
  return (prefix || 'id') + '_' + crypto.randomUUID();
}

module.exports = {
  encrypt, decrypt,
  encryptMessageContent, decryptMessageContent,
  genSessionKey,
  makeSalt, hashPassword, verifyPassword,
  genId,
};
