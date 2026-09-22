'use strict';

/**
 * 内存状态层：在线连接、会话密钥、消息广播
 */

const { WebSocketServer } = require('ws');
const { encrypt } = require('./crypto');
const { db, getUserById } = require('./db');

// userId -> Set<WebSocket>
const onlineSockets = new Map();
// userId -> Map(sessionId -> keyBuffer)
const sessionKeys = new Map();

const state = {
  onlineSockets,
  sessionKeys,

  bindSession(userId, sessionId, keyBuf) {
    if (!sessionKeys.has(userId)) sessionKeys.set(userId, new Map());
    sessionKeys.get(userId).set(sessionId, keyBuf);
  },

  unbindSession(userId, sessionId) {
    const m = sessionKeys.get(userId);
    if (m) { m.delete(sessionId); if (!m.size) sessionKeys.delete(userId); }
  },

  getKey(userId, sessionId) {
    return sessionKeys.get(userId)?.get(sessionId) || null;
  },

  addSocket(ws) {
    const userId = ws.userId;
    if (!onlineSockets.has(userId)) onlineSockets.set(userId, new Set());
    onlineSockets.get(userId).add(ws);
  },

  removeSocket(ws) {
    const userId = ws.userId;
    const set = onlineSockets.get(userId);
    if (set) {
      set.delete(ws);
      if (!set.size) {
        onlineSockets.delete(userId);
        db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), userId);
      }
    }
  },

  isOnline(userId) {
    return onlineSockets.has(userId);
  },

  socketsOf(userId) {
    return onlineSockets.get(userId) ? [...onlineSockets.get(userId)] : [];
  },

  /** 给某个用户的所有在线连接加密推送；excludeWs 用于排除发送方本连接 */
  sendToUser(userId, obj, excludeWs) {
    for (const ws of state.socketsOf(userId)) {
      if (excludeWs && ws === excludeWs) continue;
      const key = state.getKey(userId, ws.sessionId);
      try {
        const data = key ? { sid: ws.sessionId, d: encrypt(key, JSON.stringify(obj)) } : obj;
        if (ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(data));
      } catch (_) { /* 忽略单连接失败 */ }
    }
  },
};

module.exports = state;
