/**
 * 1:1 音视频通话（WebRTC）
 * - 信令走现有加密 WebSocket 通道（应用层 AES）
 * - 媒体 P2P 直连，由 WebRTC 的 DTLS-SRTP 端到端加密，服务器不转发媒体流
 * - 仅支持好友间 1:1 通话；群组通话需要 SFU，暂不支持
 */

const ICE_SERVERS = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
  iceTransportPolicy: 'all',
};

export class CallManager {
  constructor({ socket, getMe }) {
    this.socket = socket;
    this.getMe = getMe;
    this.onEvent = null;
    this.state = 'idle';   // idle | outgoing | incoming | connected
    this.pc = null;
    this.localStream = null;
    this.remoteStream = null;
    this.timer = null;
    this.noAnswerTimer = null;
    this.incomingTimer = null;
    this.connectedOnce = false;
    this.iceQueue = [];            // PC 创建前收到的 ICE 候选暂存
  }

  get busy() { return this.state !== 'idle'; }

  /** 主叫发起 */
  async start(peerId, media) {
    if (this.busy) { this.onEvent?.({ kind: 'error', message: '正在通话中，请先挂断' }); return; }
    this.peerId = peerId;
    this.media = media;
    this.callId = 'call_' + crypto.randomUUID();
    this.state = 'outgoing';
    this.role = 'caller';
    this.connectedOnce = false;
    this.iceQueue = [];
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: media === 'video' });
    } catch (e) {
      this.reset();
      this.onEvent?.({ kind: 'error', message: '无法访问麦克风/摄像头，请检查浏览器权限' });
      return;
    }
    this.onEvent?.({ kind: 'local-stream', stream: this.localStream });
    this.onEvent?.({ kind: 'outgoing', media, peerId });
    await this.createPC();
    const offer = await this.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: media === 'video' });
    await this.pc.setLocalDescription(offer);
    this.send({ type: 'call_offer', to: peerId, media, sdp: offer.sdp });
    this.noAnswerTimer = setTimeout(() => this.end('no_answer'), 45000);
  }

  /** 被叫收到来电 */
  onIncoming(evt) {
    if (this.state !== 'idle') {
      // 同一通来电重复投递（重连/多标签页回环），直接忽略
      if (this.callId === evt.callId) return;
      this.send({ type: 'call_busy', to: evt.from, callId: evt.callId });
      return;
    }
    this.peerId = evt.from;
    this.media = evt.media;
    this.callId = evt.callId;
    this.pendingSdp = evt.sdp;
    this.state = 'incoming';
    this.role = 'callee';
    this.onEvent?.({ kind: 'incoming', media: evt.media, peerId: evt.from });
    this.startRing();
    this.incomingTimer = setTimeout(() => this.reject('timeout'), 45000);
  }

  /** 被叫接听 */
  async accept() {
    if (this.state !== 'incoming') return;
    this.stopRing();
    clearTimeout(this.incomingTimer);
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: this.media === 'video' });
    } catch (e) {
      this.send({ type: 'call_reject', to: this.peerId, reason: 'media_error' });
      this.reset();
      this.onEvent?.({ kind: 'error', message: '无法访问麦克风/摄像头，通话已结束' });
      return;
    }
    this.onEvent?.({ kind: 'local-stream', stream: this.localStream });
    this.onEvent?.({ kind: 'connecting' });
    await this.createPC();
    await this.pc.setRemoteDescription({ type: 'offer', sdp: this.pendingSdp });
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.send({ type: 'call_answer', to: this.peerId, sdp: answer.sdp });
    // 通知同账号其它标签页：来电已被接听（服务器中继时会排除本连接）
    this.send({ type: 'call_end', to: this.getMe().id, reason: 'answered' });
  }

  /** 被叫拒绝 */
  reject(reason = 'rejected') {
    if (this.state !== 'incoming') return;
    this.stopRing();
    clearTimeout(this.incomingTimer);
    this.send({ type: 'call_reject', to: this.peerId, reason });
    this.reset();
    this.onEvent?.({ kind: 'ended', reason });
  }

  async onAnswer(evt) {
    if (this.state !== 'outgoing' || !this.pc) return;
    clearTimeout(this.noAnswerTimer);
    try {
      await this.pc.setRemoteDescription({ type: 'answer', sdp: evt.sdp });
    } catch (e) {
      this.end('error');
    }
  }

  async onIce(evt) {
    if (!evt.candidate) return;
    if (!this.pc) { this.iceQueue.push(evt.candidate); return; }   // PC 尚未创建，暂存
    try { await this.pc.addIceCandidate(evt.candidate); } catch (_) {}
  }

  onReject(evt) { if (this.callId === evt.callId) this.end('rejected', false); }

  onBusy(evt) {
    if (this.callId !== evt.callId) return;
    this.end('busy', false);
    this.onEvent?.({ kind: 'busy' });
  }

  onEnd(evt) {
    if (this.callId !== evt.callId) return;
    if (this.state === 'connected') return;   // 自己已接通的通话不受串扰
    this.reset();
    this.onEvent?.({ kind: 'ended', reason: evt.reason });
  }

  onFailed(evt) {
    if (this.callId !== evt.callId) return;
    this.reset();
    this.onEvent?.({ kind: 'ended', reason: evt.reason || 'failed' });
  }

  /** 挂断（主叫/被叫均可） */
  end(reason = 'hangup', notify = true) {
    if (this.state === 'idle') return;
    const info = {
      role: this.role || (this.state === 'incoming' ? 'callee' : 'caller'),
      peerId: this.peerId,
      media: this.media,
      connected: !!this.connectedOnce,
      durationSec: this.connectedOnce
        ? Math.max(1, Math.round((Date.now() - (this.connectedAt || Date.now())) / 1000))
        : 0,
    };
    if (notify) this.send({ type: 'call_end', to: this.peerId, reason });
    this.reset();
    this.connectedOnce = false;
    this.onEvent?.({ kind: 'ended', reason });
    this.onEvent?.({ kind: 'log', ...info });
  }

  async createPC() {
    this.pc = new RTCPeerConnection(ICE_SERVERS);
    this.pc.ontrack = (e) => {
      this.remoteStream = e.streams[0];
      this.onEvent?.({ kind: 'remote-stream', stream: e.streams[0] });
    };
    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.send({ type: 'call_ice', to: this.peerId, candidate: e.candidate });
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc?.connectionState;
      if (s === 'connected') {
        if (this.state !== 'connected') {
          this.state = 'connected';
          this.connectedOnce = true;
          clearTimeout(this.noAnswerTimer);
          this.connectedAt = Date.now();
          this.onEvent?.({ kind: 'connected' });
          this.timer = setInterval(() => {
            this.onEvent?.({ kind: 'tick', secs: Math.floor((Date.now() - this.connectedAt) / 1000) });
          }, 1000);
        }
      } else if (s === 'failed' || s === 'disconnected' || s === 'closed') {
        if (this.state === 'connected') this.end('network_error');
      }
    };
    this.pc.oniceconnectionstatechange = () => {
      const s = this.pc?.iceConnectionState;
      if (s === 'disconnected' || s === 'failed' || s === 'completed') {
        this.onEvent?.({ kind: 'iceState', state: s });
      }
    };
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => this.pc.addTrack(t, this.localStream));
    }
    // 补发暂存的 ICE 候选
    for (const c of this.iceQueue) { try { await this.pc.addIceCandidate(c); } catch (_) {} }
    this.iceQueue = [];
  }

  send(obj) {
    this.socket?.send({ ...obj, callId: this.callId });
  }

  toggleMute() {
    const track = this.localStream?.getAudioTracks()[0];
    if (track) track.enabled = !track.enabled;
    return track ? track.enabled : false;
  }

  toggleCamera() {
    const track = this.localStream?.getVideoTracks()[0];
    if (track) track.enabled = !track.enabled;
    return track ? track.enabled : false;
  }

  /** 视频通话切换前后摄像头（replaceTrack，无需重新协商） */
  async switchCamera() {
    if (!this.pc || this.media !== 'video') return;
    const sender = this.pc.getSenders().find((s) => s.track?.kind === 'video');
    if (!sender) return;
    const cur = this.localStream?.getVideoTracks()[0]?.getSettings().facingMode;
    const next = cur === 'user' ? 'environment' : 'user';
    let newStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: next } });
    } catch (e) {
      this.onEvent?.({ kind: 'error', message: '无法切换摄像头' });
      return;
    }
    const newTrack = newStream.getVideoTracks()[0];
    await sender.replaceTrack(newTrack);
    const old = this.localStream.getVideoTracks()[0];
    this.localStream.removeTrack(old);
    old.stop();
    this.localStream.addTrack(newTrack);
    this.onEvent?.({ kind: 'local-stream', stream: this.localStream });
  }

  reset() {
    clearInterval(this.timer);
    clearTimeout(this.noAnswerTimer);
    clearTimeout(this.incomingTimer);
    this.stopRing();
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    if (this.pc) { try { this.pc.close(); } catch (_) {} this.pc = null; }
    this.state = 'idle';
    this.callId = null;
    this.pendingSdp = null;
    this.onEvent?.({ kind: 'reset' });
  }

  /* 来电铃声：WebAudio 合成（无外部音频文件） */
  startRing() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ringCtx = new Ctx();
      const tone = (t, freq) => {
        const o = this.ringCtx.createOscillator();
        const g = this.ringCtx.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.001, t);
        g.gain.exponentialRampToValueAtTime(0.1, t + 0.05);
        g.gain.setValueAtTime(0.1, t + 0.4);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
        o.connect(g).connect(this.ringCtx.destination);
        o.start(t);
        o.stop(t + 0.65);
      };
      const loop = () => {
        if (!this.ringCtx) return;
        const t = this.ringCtx.currentTime;
        tone(t, 700);
        tone(t + 0.7, 700);
        this.ringTimer = setTimeout(loop, 2100);
      };
      loop();
    } catch (_) {}
  }

  stopRing() {
    clearTimeout(this.ringTimer);
    if (this.ringCtx) { try { this.ringCtx.close(); } catch (_) {} this.ringCtx = null; }
  }
}
