'use strict';

/**
 * 重新生成存储主密钥与 JWT 密钥（慎用：旧聊天记录将无法解密）
 * 用法: npm run keygen
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = path.join(__dirname, 'data');
const KEY_PATH = path.join(DATA_DIR, 'key.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

if (fs.existsSync(KEY_PATH)) {
  console.log('检测到已有主密钥，已备份为 key.json.bak');
  fs.copyFileSync(KEY_PATH, KEY_PATH + '.bak');
}

const dataKey = crypto.randomBytes(32);
fs.writeFileSync(KEY_PATH, JSON.stringify({
  dataKey: dataKey.toString('base64'),
  createdAt: new Date().toISOString(),
  note: 'DO NOT LOSE OR SHARE',
}, null, 2));

const envPath = path.join(__dirname, '..', '.env');
let env = '';
if (fs.existsSync(envPath)) env = fs.readFileSync(envPath, 'utf8');
const jwtSecret = crypto.randomBytes(48).toString('base64');
if (/^JWT_SECRET=.*/m.test(env)) {
  env = env.replace(/^JWT_SECRET=.*/m, `JWT_SECRET=${jwtSecret}`);
} else {
  env += `\nJWT_SECRET=${jwtSecret}\n`;
}
fs.writeFileSync(envPath, env);

console.log('✓ 已生成新的存储主密钥：', KEY_PATH);
console.log('✓ 已写入新的 JWT_SECRET 到：', envPath);
