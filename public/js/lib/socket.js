/** WebSocket 客户端：自动加密载荷、心跳、断线重连 */

import { importKey, encrypt, decrypt } from './crypto.js';

export class ChatSocket {
  constructor({ token, sessionId, sessionKey, refreshSession, onMessage, onState }) {
    Object.assign(this, { token, sessionId, sessionKey, refreshSession, onMessage, onState });
    this.manualClose = false;
    this.retries = 0;
    this.hbTimer = null;
    this.retryTimer = null;
    this.connecting = false;
    this.needsSession = false;
  }

  async connect() {
    if (this.manualClose || this.connecting || (this.ws && this.ws.readyState < 2)) return;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connecting = true;
    try {
      if (this.needsSession) {
        if (!this.refreshSession) return;
        const session = await this.refreshSession();
        if (this.manualClose) return;
        this.sessionId = session.sessionId;
        this.sessionKey = session.sessionKey;
        this.needsSession = false;
      }
      const key = await importKey(this.sessionKey);
      if (this.manualClose) return;
      this.key = key;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = this.ws = new WebSocket(
        `${proto}://${location.host}/ws?token=${encodeURIComponent(this.token)}&sid=${encodeURIComponent(this.sessionId)}`
      );
      ws.onopen = () => {
        if (this.manualClose || this.ws !== ws) { ws.close(); return; }
        this.retries = 0;
        this.stopHeartbeat();
        this.hbTimer = setInterval(() => this.send({ type: 'ping' }), 25000);
        this.onState?.('open');
      };
      ws.onclose = (e) => {
        if (this.ws !== ws) return;
        this.stopHeartbeat();
        if (this.manualClose) return;
        this.onState?.('close');
        if (e.code === 4001) return; // 无效登录凭证不盲目重连。
        if (e.code === 4002) this.needsSession = true;
        this.scheduleReconnect();
      };
      ws.onerror = () => { /* close 会兜底重连 */ };
      ws.onmessage = async (e) => {
        let obj;
        try {
          obj = JSON.parse(e.data);
          if (obj && typeof obj.d === 'string') obj = await decrypt(key, obj.d);
        } catch (_) { return; }
        if (!this.manualClose && this.ws === ws) this.onMessage?.(obj);
      };
    } catch (_) {
      if (!this.manualClose) {
        this.onState?.('close');
        this.scheduleReconnect();
      }
    } finally {
      this.connecting = false;
    }
  }

  scheduleReconnect() {
    if (this.manualClose || this.retryTimer !== null) return;
    const delay = Math.min(2000 * ++this.retries, 15000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  async send(obj) {
    const ws = this.ws, key = this.key, sid = this.sessionId;
    if (this.manualClose || !ws || ws.readyState !== 1) return false;
    try {
      const d = await encrypt(key, obj);
      // 加密是异步操作：期间可能断线或切换连接，不能误发到新连接。
      if (this.manualClose || this.ws !== ws || ws.readyState !== 1) return false;
      ws.send(JSON.stringify({ sid, d }));
      return true;
    } catch (_) { return false; }
  }

  stopHeartbeat() {
    if (this.hbTimer !== null) { clearInterval(this.hbTimer); this.hbTimer = null; }
  }

  close() {
    this.manualClose = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopHeartbeat();
    this.ws?.close();
  }
}
