'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'server', 'data');
const UPLOADS_DIR = path.join(ROOT, 'public', 'uploads');

// 最小化 .env 加载（不引入额外依赖）
function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  }
}
loadEnv();

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  jwtSecret: process.env.JWT_SECRET || 'sakura-chat-dev-secret-please-change',
  jwtExpiresSec: 7 * 24 * 3600,
  root: ROOT,
  dataDir: DATA_DIR,
  uploadsDir: UPLOADS_DIR,
  dbPath: path.join(DATA_DIR, 'sakura-chat.db'),
  keyPath: path.join(DATA_DIR, 'key.json'),
  sslKeyPath: process.env.SSL_KEY_PATH || '',
  sslCertPath: process.env.SSL_CERT_PATH || '',
  recallWindowMs: 2 * 60 * 1000,       // 撤回时间窗：2 分钟
  maxMessageBytes: 16 * 1024,          // 单条消息明文上限
  uploadMaxBytes: 10 * 1024 * 1024,    // 图片/文件上传上限：10MB
  historyPageSize: 30,
};

function ensureDirs() {
  for (const d of [DATA_DIR, UPLOADS_DIR]) fs.mkdirSync(d, { recursive: true });
}

/**
 * 加载/生成"存储主密钥"：用于加密数据库中的聊天记录（AES-256-GCM）。
 * 密钥仅以此文件形式落盘，不与代码一起提交；丢失将无法解密历史消息。
 */
function loadDataKey() {
  ensureDirs();
  if (fs.existsSync(config.keyPath)) {
    try {
      const obj = JSON.parse(fs.readFileSync(config.keyPath, 'utf8'));
      if (obj && obj.dataKey) return Buffer.from(obj.dataKey, 'base64');
    } catch (_) { /* 损坏则重建 */ }
  }
  const dataKey = require('node:crypto').randomBytes(32);
  fs.writeFileSync(
    config.keyPath,
    JSON.stringify({ dataKey: dataKey.toString('base64'), createdAt: new Date().toISOString(), note: 'DO NOT LOSE OR SHARE' }, null, 2)
  );
  console.log('[security] 生成新的存储主密钥：', config.keyPath);
  return dataKey;
}

ensureDirs();
config.dataKey = loadDataKey();
config.useTls = !!(config.sslKeyPath && config.sslCertPath &&
  fs.existsSync(config.sslKeyPath) && fs.existsSync(config.sslCertPath));

module.exports = config;
