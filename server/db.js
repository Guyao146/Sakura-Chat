'use strict';

/**
 * 数据库层：SQLite（Node 内置 node:sqlite），表结构 + 常用 DAO
 */

const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    UNIQUE NOT NULL,
  nickname      TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  salt          TEXT    NOT NULL,
  avatar        TEXT,
  signature     TEXT    NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL DEFAULT 0
);

-- 好友关系（双向各一行）
CREATE TABLE IF NOT EXISTS friendships (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  friend_id  INTEGER NOT NULL,
  remark     TEXT    NOT NULL DEFAULT '',
  status     INTEGER NOT NULL DEFAULT 0,   -- 0 待处理 1 已是好友 2 已拒绝
  created_at INTEGER NOT NULL,
  handled_at INTEGER,
  UNIQUE(user_id, friend_id)
);

CREATE TABLE IF NOT EXISTS groups (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  owner_id     INTEGER NOT NULL,
  avatar       TEXT,
  announcement TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id  INTEGER NOT NULL,
  user_id   INTEGER NOT NULL,
  role      INTEGER NOT NULL DEFAULT 0,    -- 0 成员 1 管理员 2 群主
  joined_at INTEGER NOT NULL,
  PRIMARY KEY(group_id, user_id)
);

-- 聊天消息（内容字段加密存储）
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  msg_id      TEXT    UNIQUE NOT NULL,     -- 客户端生成的 UUID，用于去重与 ACK
  conv_type   TEXT    NOT NULL,            -- single | group
  conv_id     TEXT    NOT NULL,            -- u_1_2 | g_3
  sender_id   INTEGER NOT NULL,
  receiver_id INTEGER,                     -- single 时为接收者
  group_id    INTEGER,                     -- group 时为群 id
  kind        TEXT    NOT NULL,            -- text image emoji file system
  content_enc TEXT    NOT NULL,            -- AES-256-GCM 加密的 JSON 内容
  created_at  INTEGER NOT NULL,
  delivered   INTEGER NOT NULL DEFAULT 0,  -- 单聊：是否已送达对端
  read_at     INTEGER,                     -- 单聊：已读时间戳
  revoked     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id, id DESC);

-- 未读消息计数
CREATE TABLE IF NOT EXISTS unread_counts (
  user_id INTEGER NOT NULL,
  conv_id TEXT    NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  last_read_ts INTEGER NOT NULL DEFAULT 0,  -- 最近一次已读时间戳（用于未读分界线）
  PRIMARY KEY(user_id, conv_id)
);

-- 会话级设置：置顶 / 免打扰
CREATE TABLE IF NOT EXISTS conv_settings (
  user_id INTEGER NOT NULL,
  conv_id TEXT    NOT NULL,
  pinned  INTEGER NOT NULL DEFAULT 0,
  muted   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, conv_id)
);

-- 用户自定义表情包（QQ 式表情商城：上传任意图片当表情）
CREATE TABLE IF NOT EXISTS user_stickers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  url        TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

-- 我的收藏（Telegram Saved Messages）
CREATE TABLE IF NOT EXISTS saved_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  msg_json   TEXT    NOT NULL,   -- 完整消息对象的密文 JSON
  created_at INTEGER NOT NULL
);
`);

/* ------------------- 增量迁移：为已有表追加新列（SQLite 的 ADD COLUMN 幂等包装） ------------------- */
function ensureColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some(c => c.name === col)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

// 消息扩展：引用回复 / 表情反应 / 已编辑 / 转发来源 / @提及
ensureColumn('messages', 'reply_to',    'TEXT');                    // 被引用消息的 msg_id
ensureColumn('messages', 'reply_snip',  'TEXT');                    // 引用快照（发送者昵称 + 摘要，渲染用）
ensureColumn('messages', 'reactions',   'TEXT');                    // JSON: {"👍":[uid,...]}
// ttl / expire_at：阅后即焚功能已下线，列保留以兼容历史库（不再写入）
ensureColumn('messages', 'ttl',         'INTEGER');
ensureColumn('messages', 'expire_at',   'INTEGER');
ensureColumn('messages', 'edited',      'INTEGER NOT NULL DEFAULT 0');
ensureColumn('messages', 'edited_at',   'INTEGER');
ensureColumn('messages', 'forward_from','TEXT');                    // 转发来源描述："爱丽丝"
ensureColumn('messages', 'ats',         'TEXT');                    // JSON: [被@的 uid]
// 用户扩展：自定义在线状态（Discord 式）
ensureColumn('users', 'status', 'TEXT NOT NULL DEFAULT \'\'');
// 群扩展：群公告已有 announcement 字段；群昵称（群内显示名）
ensureColumn('group_members', 'display_name', 'TEXT NOT NULL DEFAULT \'\'');
ensureColumn('unread_counts', 'last_read_ts', 'INTEGER NOT NULL DEFAULT 0');


/* ------------------- 通用小工具 ------------------- */

function now() { return Date.now(); }

function getUserById(id) {
  return db.prepare('SELECT id, username, nickname, avatar, signature, created_at, last_seen FROM users WHERE id = ?').get(id);
}

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

/** 单聊会话 id：两个用户 id 有序拼接，保证双方一致 */
function singleConvId(a, b) {
  const x = Number(a), y = Number(b);
  return 'u_' + Math.min(x, y) + '_' + Math.max(x, y);
}

function groupConvId(groupId) {
  return 'g_' + Number(groupId);
}

/** 安全的用户对象（剔除敏感字段） */
function safeUser(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, nickname: u.nickname,
    avatar: u.avatar || '', signature: u.signature || '',
    createdAt: u.created_at, lastSeen: u.last_seen || 0,
  };
}

module.exports = {
  db,
  now,
  getUserById,
  getUserByUsername,
  singleConvId,
  groupConvId,
  safeUser,
  ensureColumn,
};
