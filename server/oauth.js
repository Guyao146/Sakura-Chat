'use strict';

/**
 * 第三方登录（OAuth2 / OIDC 客户端）
 *
 * Sakura-Chat 作为标准 OIDC 接入方，可对接 SakuraID（Sakura-Auth-Server）与
 * Authentik 等任意标准 Provider。授权码 + PKCE 流程：
 *
 *   浏览器 GET  /api/auth/oauth/:provider/start
 *     → 生成 state 与 code_verifier（仅保存在服务端），302 到 IdP 的 /authorize
 *   IdP 登录/同意后 GET /api/auth/oauth/:provider/callback?code&state
 *     → 校验 state（一次性）→ PKCE verifier 换 access_token → 拉 userinfo
 *     → 按 (provider, sub) 查找/创建本地账号 → 签发一次性票据（HttpOnly Cookie）
 *     → 302 回 /login?oauth=callback
 *   浏览器 POST /api/auth/oauth/finish（携带票据 Cookie）→ 换取本站 JWT + 会话密钥
 *
 * state 与 verifier 全程不落盘、不经过浏览器，票据单次有效；未配置 OAUTH_* 时
 * 提供方列表为空，登录页只显示本地登录。
 */

const crypto = require('node:crypto');
const config = require('./config');
const { db, getUserByUsername, getUserById } = require('./db');
const { ensureFriendWithSystem, isSystemUsername } = require('./system');
const { makeSalt, hashPassword } = require('./crypto');

const STATE_TTL_MS = 10 * 60 * 1000;     // 发起授权后允许的回调间隔
const TICKET_TTL_MS = 2 * 60 * 1000;     // 回调后换票窗口
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10 * 1000;
const MAX_PENDING = 512;                 // 未完成授权上限，防止内存堆积
const TICKET_COOKIE = 'sc_oauth_ticket';

const pending = new Map();        // state -> { providerId, codeVerifier, redirectUri, expires }
const tickets = new Map();        // ticketId -> { payload, expires }
const discoveryCache = new Map(); // providerId -> { doc, expires }

const base64url = buf => buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const rand = n => base64url(crypto.randomBytes(n));

/** 清理过期条目并限制表大小 */
function prune(map) {
  const now = Date.now();
  for (const [k, v] of map) if (v.expires <= now) map.delete(k);
  if (map.size <= MAX_PENDING) return;
  const sorted = [...map.entries()].sort((a, b) => a[1].expires - b[1].expires);
  for (let i = 0; i < map.size - MAX_PENDING; i++) map.delete(sorted[i][0]);
}

function listProviders() {
  return config.oauthProviders.map(p => ({ id: p.id, name: p.name }));
}

function getProvider(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) return null;
  return config.oauthProviders.find(p => p.id === id) || null;
}

/** 回调地址的协议+主机：优先 APP_BASE_URL，其次信任反向代理头与 Host */
function requestBase(req) {
  if (config.oauthRedirectBase) return config.oauthRedirectBase;
  const fwd = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const proto = fwd === 'https' || fwd === 'http' ? fwd : (req.secure ? 'https' : 'http');
  return proto + '://' + (req.headers.host || 'localhost');
}

/** 拉取并缓存 IdP 发现文档 */
async function discover(provider) {
  const cached = discoveryCache.get(provider.id);
  if (cached && cached.expires > Date.now()) return cached.doc;
  const url = provider.issuer + '/.well-known/openid-configuration';
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error('身份提供方发现接口不可用（' + res.status + '）');
  const doc = await res.json();
  if (!doc || typeof doc.authorization_endpoint !== 'string' ||
    typeof doc.token_endpoint !== 'string' || typeof doc.userinfo_endpoint !== 'string') {
    throw new Error('身份提供方的发现文档缺少必要的端点');
  }
  discoveryCache.set(provider.id, { doc, expires: Date.now() + DISCOVERY_TTL_MS });
  return doc;
}

function callbackPath(providerId) {
  return '/api/auth/oauth/' + providerId + '/callback';
}

/** 生成授权 URL，state/verifier 存服务端（一次性） */
async function startAuthorize(provider, redirectBase) {
  const doc = await discover(provider);
  const state = rand(32);
  const codeVerifier = rand(48);
  const redirectUri = redirectBase + callbackPath(provider.id);
  prune(pending);
  pending.set(state, {
    providerId: provider.id,
    codeVerifier,
    redirectUri,
    expires: Date.now() + STATE_TTL_MS,
  });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: provider.clientId,
    redirect_uri: redirectUri,
    scope: provider.scopes,
    state,
    code_challenge: base64url(crypto.createHash('sha256').update(codeVerifier).digest()),
    code_challenge_method: 'S256',
  });
  return doc.authorization_endpoint + '?' + params.toString();
}

/** 用授权码换 access_token（PKCE verifier 由 state 取回） */
async function exchangeCode(provider, doc, { code, redirectUri, codeVerifier }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  if (provider.clientSecret) {
    headers.Authorization = 'Basic ' + Buffer.from(provider.clientId + ':' + provider.clientSecret).toString('base64');
  } else {
    body.set('client_id', provider.clientId);   // 公开客户端：无密钥，依赖 PKCE
  }
  const res = await fetch(doc.token_endpoint, {
    method: 'POST', headers, body: body.toString(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { /* 非法响应体 */ }
  if (!res.ok || !data || !data.access_token) {
    const desc = (data && (data.error_description || data.error)) || ('HTTP ' + res.status);
    throw new Error('身份提供方拒绝换取令牌：' + desc);
  }
  return String(data.access_token);
}

/** 用 access_token 拉用户信息，归一化为外部身份 */
async function fetchUserinfo(provider, doc, accessToken) {
  const res = await fetch(doc.userinfo_endpoint, {
    headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 401) throw new Error('身份提供方拒绝了访问令牌');
  if (!res.ok) throw new Error('拉取用户信息失败（HTTP ' + res.status + '）');
  const claims = await res.json();
  if (!claims || typeof claims.sub !== 'string' || !claims.sub) {
    throw new Error('身份提供方未返回有效的用户标识（sub）');
  }
  return {
    providerId: provider.id,
    sub: claims.sub,
    username: typeof claims.preferred_username === 'string' ? claims.preferred_username :
      (typeof claims.name === 'string' ? claims.name : ''),
    nickname: typeof claims.name === 'string' ? claims.name : '',
  };
}

/** 校验 state 并完成令牌交换，返回归一化的外部身份 */
async function finishAuthorize(provider, { code, state }) {
  if (typeof code !== 'string' || !code) throw new Error('缺少授权码');
  if (typeof state !== 'string' || !state) throw new Error('缺少 state 参数');
  prune(pending);
  const entry = pending.get(state);
  if (!entry) throw new Error('登录会话已过期或已使用，请重新发起登录');
  pending.delete(state);   // state 一次性，防重放
  if (entry.providerId !== provider.id) throw new Error('state 与登录方式不匹配');
  const doc = await discover(provider);
  const accessToken = await exchangeCode(provider, doc, {
    code, redirectUri: entry.redirectUri, codeVerifier: entry.codeVerifier,
  });
  return fetchUserinfo(provider, doc, accessToken);
}

/** 把外部用户名规范化成本站用户名（3-20 位字母数字下划线），冲突时追加后缀 */
function pickUsername(raw) {
  let base = String(raw || '').trim().slice(0, 18).replace(/[^a-zA-Z0-9_]/g, '_');
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(base)) base = 'sso_' + crypto.randomBytes(4).toString('hex');
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? base : base.slice(0, 16) + '_' + (i + 1);
    if (candidate.length > 20) continue;
    if (getUserByUsername(candidate) || isSystemUsername(candidate)) continue;
    return candidate;
  }
  return 'sso_' + crypto.randomBytes(5).toString('hex');
}

/**
 * 外部身份 → 本地账号。首次登录自动创建「影子账号」（本地密码为随机串，无法
 * 用密码登录本站），之后按 (provider, sub) 复用同一账号。不与同名本地账号自动
 * 合并——站方无法核实两个身份属于同一人，合并需用户主动完成。
 */
function resolveUser(identity) {
  let u = db.prepare('SELECT * FROM users WHERE auth_provider = ? AND auth_sub = ?')
    .get(identity.providerId, identity.sub);
  if (!u) {
    const username = pickUsername(identity.username);
    const nickname = (identity.nickname && identity.nickname.trim()) || username;
    const salt = makeSalt();
    const hash = hashPassword(crypto.randomBytes(32).toString('hex'), salt);
    const now = Date.now();
    const info = db.prepare(
      'INSERT INTO users (username, nickname, password_hash, salt, created_at, last_seen, auth_provider, auth_sub)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(username, nickname, hash, salt, now, now, identity.providerId, identity.sub);
    u = getUserById(Number(info.lastInsertRowid));
    ensureFriendWithSystem(u.id);   // 与本地注册一致：自动成为「文件传输助手」好友
  }
  db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), u.id);
  return u;
}

/* ------------------- 票据（回调 → /oauth/finish 之间的握手） ------------------- */

function issueTicket(payload) {
  prune(tickets);
  const id = rand(32);
  tickets.set(id, { payload, expires: Date.now() + TICKET_TTL_MS });
  return id;
}

function consumeTicket(id) {
  if (typeof id !== 'string' || !id) return null;
  prune(tickets);
  const entry = tickets.get(id);
  if (!entry) return null;
  tickets.delete(id);   // 单次有效
  return entry.payload;
}

function setTicketCookie(res, ticket) {
  const parts = [
    TICKET_COOKIE + '=' + ticket, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    'Max-Age=' + Math.floor(TICKET_TTL_MS / 1000),
  ];
  if (config.useTls) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearTicketCookie(res) {
  res.setHeader('Set-Cookie', TICKET_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

function readTicketCookie(req) {
  const m = new RegExp('(?:^|;\\s*)' + TICKET_COOKIE + '=([^;]*)').exec(req.headers.cookie || '');
  return m ? m[1] : null;
}

module.exports = {
  listProviders,
  getProvider,
  requestBase,
  startAuthorize,
  finishAuthorize,
  resolveUser,
  issueTicket,
  consumeTicket,
  setTicketCookie,
  clearTicketCookie,
  readTicketCookie,
};
