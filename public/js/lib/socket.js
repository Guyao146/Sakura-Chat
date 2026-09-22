/** WebSocket 客户端：自动加密载荷、心跳、断线重连 */

import { importKey, encrypt, decrypt } from './crypto.js';

export class ChatSocket {
  constructor({ token, sessionId, sessionKey, onMessage, onState }) {
    this.token = token;
    this.sessionId = sessionId;
    this.sessionKey = sessionKey;
    this.onMessage = onMessage;
    this.onState = onState;
    this.manualClose = false;
    this.retries = 0;
    this.hbTimer = null;
  }

  async connect() {
    this.key = await importKey(this.sessionKey);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(
      `${proto}://${location.host}/ws?token=${encodeURIComponent(this.token)}&sid=${encodeURIComponent(this.sessionId)}`
    );

    this.ws.onopen = () => {
      this.retries = 0;
      this.onState?.('open');
      this.stopHeartbeat();
      this.hbTimer = setInterval(() => this.send({ type: 'ping' }), 25000);
    };

    this.ws.onclose = () => {
      this.stopHeartbeat();
      this.onState?.('close');
      if (this.manualClose) return;
      this.retries++;
      const delay = Math.min(2000 * this.retries, 15000);
      setTimeout(() => this.connect(), delay);
    };

    this.ws.onerror = () => { /* close 会兜底重连 */ };

    this.ws.onmessage = async (e) => {
      let obj;
      try { obj = JSON.parse(e.data); } catch (_) { return; }
      if (obj && typeof obj.d === 'string') {
        if (!this.key) return;
        try { obj = await decrypt(this.key, obj.d); } catch (_) { return; }
      }
      this.onMessage?.(obj);
    };
  }

  async send(obj) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    const d = await encrypt(this.key, obj);
    this.ws.send(JSON.stringify({ sid: this.sessionId, d }));
    return true;
  }

  stopHeartbeat() {
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
  }

  close() {
    this.manualClose = true;
    this.stopHeartbeat();
    this.ws?.close();
  }
}
