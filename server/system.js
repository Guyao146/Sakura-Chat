'use strict';

/**
 * 系统账号：文件传输助手（微信式 File Transfer Assistant）
 *
 * 特性：
 * - 每个用户注册后自动与其互为好友（无需请求/同意）
 * - 不可登录、不可被搜索、不可删除、不可被添加/请求
 * - 发往它的消息自动标记「已送达 + 已读」并即时回执
 * - 头像使用内联 SVG（绿色文件夹），前端无需特殊处理
 */

const crypto = require('node:crypto');
const { db, getUserByUsername } = require('./db');
const { makeSalt, hashPassword } = require('./crypto');

const SYSTEM_USERNAME = 'filehelper';
const SYSTEM_NICKNAME = '文件传输助手';

// 头像：绿色圆角底 + 白色文件夹（URL 编码后可直接作 <img src>）
const SYSTEM_AVATAR = 'data:image/svg+xml,' + encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>" +
  "<rect width='100' height='100' rx='22' fill='#10bf6a'/>" +
  "<path d='M27 39h15l7 8h24a6 6 0 0 1 6 6v21a6 6 0 0 1-6 6H27a6 6 0 0 1-6-6V45a6 6 0 0 1 6-6z' fill='#fff'/>" +
  '</svg>'
);

/** 系统账号 uid（不存在返回 0） */
function getSystemId() {
  const u = getUserByUsername(SYSTEM_USERNAME);
  return u ? u.id : 0;
}

function isSystemId(id) {
  const sid = getSystemId();
  return sid > 0 && Number(id) === sid;
}

function isSystemUsername(username) {
  return username === SYSTEM_USERNAME;
}

/** 确保系统账号存在（幂等；老库升级时调用一次） */
function ensureSystemUser() {
  const exist = getUserByUsername(SYSTEM_USERNAME);
  if (exist) return exist.id;
  const salt = makeSalt();
  // 随机密码哈希：即使绕过登录接口的显式拒绝也无法通过校验
  const hash = hashPassword(crypto.randomBytes(32).toString('hex'), salt);
  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO users (username, nickname, password_hash, salt, avatar, signature, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(SYSTEM_USERNAME, SYSTEM_NICKNAME, hash, salt, SYSTEM_AVATAR, '你的随身文件传输助手', now, now);
  console.log('[system] 已创建系统账号：文件传输助手（filehelper, uid=' + info.lastInsertRowid + '）');
  return Number(info.lastInsertRowid);
}

/** 与系统账号建立双向好友（幂等；静默建立，不发系统消息打扰用户） */
function ensureFriendWithSystem(userId) {
  const sid = getSystemId();
  if (!sid || !userId || Number(userId) === sid) return;
  const now = Date.now();
  const upsert = db.prepare(`
    INSERT INTO friendships (user_id, friend_id, remark, status, created_at) VALUES (?, ?, '', 1, ?)
    ON CONFLICT(user_id, friend_id) DO UPDATE SET status = 1
  `);
  upsert.run(userId, sid, now);
  upsert.run(sid, userId, now);
}

/** 老库迁移：为所有尚未与系统账号互为好友的用户补上，返回处理用户数 */
function ensureAllUsersFriendSystem() {
  const ids = db.prepare('SELECT id FROM users WHERE username != ?').all(SYSTEM_USERNAME).map(r => r.id);
  for (const uid of ids) ensureFriendWithSystem(uid);
  return ids.length;
}

module.exports = {
  SYSTEM_USERNAME,
  SYSTEM_NICKNAME,
  getSystemId,
  isSystemId,
  isSystemUsername,
  ensureSystemUser,
  ensureFriendWithSystem,
  ensureAllUsersFriendSystem,
};
