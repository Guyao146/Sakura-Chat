'use strict';

/**
 * 内存状态层：在线连接、会话密钥、消息广播
 */

const { SessionStore } = require('./sessions');
const { encrypt } = require('./crypto');
const { db } = require('./db');

// userId -> Set<WebSocket>
const onlineSockets = new Map();
// userId -> Map(sessionId -> { key, expires, sockets })
const sessions = new SessionStore();
const sessionKeys = sessions.users;

const state = {
  onlineSockets,
  sessionKeys,

  bindSession(userId, sessionId, keyBuf) { sessions.bind(userId, sessionId, keyBuf); },
  unbindSession(userId, sessionId) { sessions.delete(userId, sessionId); },
  getKey(userId, sessionId) { return sessions.get(userId, sessionId); },
  pruneSessions() { sessions.prune(); },

  addSocket(ws) {
    sessions.connect(ws);
    const userId = ws.userId;
    if (!onlineSockets.has(userId)) onlineSockets.set(userId, new Set());
    onlineSockets.get(userId).add(ws);
  },

  removeSocket(ws) {
    sessions.disconnect(ws);
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
  sendSocket(ws, obj) {
    if (ws.readyState !== 1) return;
    // 慢连接不无限缓存密文，交由重连和历史接口恢复。
    if (ws.bufferedAmount > 1024 * 1024) { ws.terminate(); return; }
    const key = state.getKey(ws.userId, ws.sessionId);
    if (!key) { ws.close(4002, 'invalid_session'); return; }
    try { ws.send(JSON.stringify({ sid: ws.sessionId, d: encrypt(key, JSON.stringify(obj)) })); }
    catch (_) { /* 单连接失败不影响广播 */ }
  },

  sendToUser(userId, obj, excludeWs) {
    for (const ws of state.socketsOf(userId)) {
      if (ws !== excludeWs) state.sendSocket(ws, obj);
    }
  },
};

module.exports = state;
