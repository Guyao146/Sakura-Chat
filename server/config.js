'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

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

// 测试可指向临时目录，不污染正在使用的数据库与主密钥。
const DATA_DIR = process.env.SAKURA_DATA_DIR
  ? path.resolve(process.env.SAKURA_DATA_DIR) : path.join(ROOT, 'server', 'data');
const UPLOADS_DIR = path.join(ROOT, 'public', 'uploads');

const DEFAULT_OAUTH_PROVIDER_NAMES = { sakura: 'Sakura', authentik: 'Authentik' };

/**
 * 解析第三方登录提供方（标准 OAuth2/OIDC）。
 *
 * 约定：OAUTH_<ID>_ISSUER + OAUTH_<ID>_CLIENT_ID 定义一个提供方，二者缺一即忽略。
 * ID 只允许 [a-z0-9-]（同时作为 URL 路由段），如 OAUTH_SAKURA_* / OAUTH_AUTHENTIK_*。
 * CLIENT_SECRET 留空时视为公开客户端，强制走 PKCE（浏览器侧 SPA 的推荐做法）。
 */
function parseOAuthProviders() {
  const ids = new Set();
  for (const key of Object.keys(process.env)) {
    const m = /^OAUTH_([A-Z0-9][A-Z0-9]{0,30})_ISSUER$/.exec(key);
    if (m) ids.add(m[1]);
  }
  const providers = [];
  for (const idRaw of [...ids].sort()) {
    const prefix = 'OAUTH_' + idRaw + '_';
    const issuer = (process.env[prefix + 'ISSUER'] || '').trim().replace(/\/+$/, '');
    const clientId = (process.env[prefix + 'CLIENT_ID'] || '').trim();
    const id = idRaw.toLowerCase();
    if (!issuer || !clientId) continue;                 // 配置不完整：该提供方隐藏
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) continue;
    if (!/^https?:\/\/[\w.:%-]+(:\d+)?(\/\S*)?$/i.test(issuer)) continue;
    let scopes = (process.env[prefix + 'SCOPES'] || 'openid profile').trim();
    if (!scopes.split(/\s+/).includes('openid')) scopes = 'openid ' + scopes;
    const name = (process.env[prefix + 'NAME'] || '').trim() || DEFAULT_OAUTH_PROVIDER_NAMES[id] || idRaw;
    providers.push({
      id, name, issuer, clientId,
      clientSecret: (process.env[prefix + 'CLIENT_SECRET'] || '').trim(),
      scopes,
    });
  }
  return providers;
}

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  // 默认不信任转发头；只允许实际反向代理的地址/CIDR，禁止笼统信任所有来源。
  trustProxy: (process.env.TRUST_PROXY || '').split(',').map(s => s.trim()).filter(Boolean),
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
  oauthProviders: parseOAuthProviders(),
  // 反向代理后，浏览器地址与本机 Host 不一致时，以此覆盖回调地址的协议与主机名
  oauthRedirectBase: (process.env.APP_BASE_URL || '').trim().replace(/\/+$/, ''),
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
