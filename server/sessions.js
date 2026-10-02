'use strict';

const SESSION_TTL = 2 * 60 * 1000; // 未连接/断线密钥：两分钟重连宽限期
const SESSION_LIMIT = 64;
class SessionStore {
  constructor(clock = Date.now) { this.users = new Map(); this.clock = clock; }
  prune() {
    for (const [uid, sessions] of this.users) {
      for (const [sid, s] of sessions) if (!s.sockets.size && s.expires <= this.clock()) sessions.delete(sid);
      if (!sessions.size) this.users.delete(uid);
    }
  }
  bind(uid, sid, key) {
    let sessions = this.users.get(uid);
    if (!sessions) this.users.set(uid, sessions = new Map());
    if (!sessions.has(sid) && sessions.size >= SESSION_LIMIT) {
      const idle = [...sessions].find(([, s]) => !s.sockets.size);
      if (idle) sessions.delete(idle[0]);
      else { const err = new Error('已达到同时在线会话上限'); err.status = 429; throw err; }
    }
    sessions.set(sid, { key, expires: this.clock() + SESSION_TTL, sockets: new Set() });
  }
  get(uid, sid) {
    const sessions = this.users.get(uid), s = sessions?.get(sid);
    if (!s) return null;
    if (!s.sockets.size && s.expires <= this.clock()) { this.delete(uid, sid); return null; }
    return s.key;
  }
  delete(uid, sid) {
    const sessions = this.users.get(uid);
    sessions?.delete(sid);
    if (!sessions?.size) this.users.delete(uid);
  }
  connect(ws) { this.users.get(ws.userId)?.get(ws.sessionId)?.sockets.add(ws); }
  disconnect(ws) {
    const s = this.users.get(ws.userId)?.get(ws.sessionId);
    if (s?.sockets.delete(ws) && !s.sockets.size) s.expires = this.clock() + SESSION_TTL;
  }
}
module.exports = { SessionStore, SESSION_TTL, SESSION_LIMIT };
