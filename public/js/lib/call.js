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
    this.state = 'idle';   // idle | outgoing | incoming | connecting | connected
    this.pc = null;
    this.localStream = null;
    this.remoteStream = null;
    this.timer = null;
    this.noAnswerTimer = null;
    this.incomingTimer = null;
    this.connectedOnce = false;
    this.iceQueue = [];            // PC 创建前收到的 ICE 候选暂存
    this.generation = 0;           // 挂断后作废尚未完成的媒体/信令操作
  }

  get busy() { return this.state !== 'idle'; }

  /** 主叫发起 */
  async start(peerId, media) {
    if (this.busy) { this.onEvent?.({ kind: 'error', message: '正在通话中，请先挂断' }); return; }
    this.peerId = peerId;
    this.media = media;
    this.callId = 'call_' + crypto.randomUUID();
    this.state = 'outgoing';
    const generation = ++this.generation;
    this.role = 'caller';
    this.connectedOnce = false;
    this.iceQueue = [];
    this.onEvent?.({ kind: 'outgoing', media, peerId });
    this.noAnswerTimer = setTimeout(() => this.end('no_answer'), 45000);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: media === 'video' });
      if (generation !== this.generation) { stream.getTracks().forEach(t => t.stop()); return; }
      this.localStream = stream;
      this.onEvent?.({ kind: 'local-stream', stream });
      this.createPC();
      if (generation !== this.generation) return;
      const pc = this.pc;
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: media === 'video' });
      if (generation !== this.generation) return;
      await pc.setLocalDescription(offer);
      if (generation !== this.generation) return;
      this.send({ type: 'call_offer', to: peerId, media, sdp: offer.sdp });
    } catch (e) {
      if (generation !== this.generation) return;
      this.end('error');
      this.onEvent?.({ kind: 'error', message: '无法建立通话，请检查设备权限和网络' });
    }
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
    ++this.generation;
    this.role = 'callee';
    this.onEvent?.({ kind: 'incoming', media: evt.media, peerId: evt.from });
    this.startRing();
    this.incomingTimer = setTimeout(() => this.reject('timeout'), 45000);
  }

  /** 被叫接听 */
  async accept() {
    if (this.state !== 'incoming') return;
    const generation = this.generation;
    this.state = 'connecting';     // 同步上锁，重复点击不能启动第二次采集
    this.stopRing();
    clearTimeout(this.incomingTimer);
    this.incomingTimer = null;
    this.noAnswerTimer = setTimeout(() => this.end('timeout'), 45000);
    this.onEvent?.({ kind: 'connecting' });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: this.media === 'video' });
      if (generation !== this.generation) { stream.getTracks().forEach(t => t.stop()); return; }
      this.localStream = stream;
      this.onEvent?.({ kind: 'local-stream', stream });
      this.createPC();
      const pc = this.pc;
      await pc.setRemoteDescription({ type: 'offer', sdp: this.pendingSdp });
      if (generation !== this.generation) return;
      await this.flushIce(pc);
      if (generation !== this.generation) return;
      const answer = await pc.createAnswer();
      if (generation !== this.generation) return;
      await pc.setLocalDescription(answer);
      if (generation !== this.generation) return;
      this.send({ type: 'call_answer', to: this.peerId, sdp: answer.sdp });
      // 通知同账号其它标签页：来电已被接听（服务器中继时会排除本连接）
      this.send({ type: 'call_end', to: this.getMe().id, reason: 'answered' });
    } catch (e) {
      if (generation !== this.generation) return;
      this.end('media_error');
      this.onEvent?.({ kind: 'error', message: '无法建立通话，请检查设备权限和网络' });
    }
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
    if (this.state !== 'outgoing' || this.callId !== evt.callId || !this.pc) return;
    const pc = this.pc;
    this.state = 'connecting';
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp: evt.sdp });
      if (this.pc !== pc) return;
      await this.flushIce(pc);
    } catch (e) {
      if (this.pc === pc) this.end('error');
    }
  }

  async onIce(evt) {
    if (!this.busy || this.callId !== evt.callId || !evt.candidate) return;
    if (!this.pc?.remoteDescription) {
      if (this.iceQueue.length < 256) this.iceQueue.push(evt.candidate);
      return;
    }
    try { await this.pc.addIceCandidate(evt.candidate); } catch (_) {}
  }

  async flushIce(pc) {
    const queue = this.iceQueue;
    this.iceQueue = [];
    for (const candidate of queue) {
      if (this.pc !== pc) return;
      try { await pc.addIceCandidate(candidate); } catch (_) {}
    }
  }

  onReject(evt) { if (this.callId === evt.callId) this.end('rejected', false); }

  onBusy(evt) {
    if (this.callId !== evt.callId) return;
    this.end('busy', false);
    this.onEvent?.({ kind: 'busy' });
  }

  onEnd(evt) {
    if (this.callId !== evt.callId) return;
    // 同账号其它标签页的接听通知只取消尚未接听的来电，不能吞掉对端挂断。
    if (evt.reason === 'answered' && evt.from === this.getMe().id) {
      if (this.state === 'incoming') this.end('answered', false);
      return;
    }
    this.end(evt.reason || 'hangup', false);
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

  createPC() {
    const pc = this.pc = new RTCPeerConnection(ICE_SERVERS);
    pc.ontrack = (e) => {
      if (this.pc !== pc) { e.track?.stop(); return; }
      this.remoteStream = e.streams[0];
      this.onEvent?.({ kind: 'remote-stream', stream: e.streams[0] });
    };
    pc.onicecandidate = (e) => {
      if (this.pc === pc && e.candidate) this.send({ type: 'call_ice', to: this.peerId, candidate: e.candidate });
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      const s = pc.connectionState;
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
        this.end('network_error');
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (this.pc !== pc) return;
      const s = pc.iceConnectionState;
      if (s === 'disconnected' || s === 'failed' || s === 'completed') {
        this.onEvent?.({ kind: 'iceState', state: s });
      }
    };
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => this.pc.addTrack(t, this.localStream));
    }
    // ICE 必须等 remoteDescription 设置成功后再补发。
  }

  send(obj) {
    this.socket?.send({ callId: this.callId, ...obj });
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
    if (!this.pc || this.media !== 'video' || this.switchingCamera) return;
    const pc = this.pc, stream = this.localStream, generation = this.generation;
    const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
    const old = stream?.getVideoTracks()[0];
    if (!sender || !old) return;
    const next = old.getSettings().facingMode === 'user' ? 'environment' : 'user';
    this.switchingCamera = true;
    let newStream, adopted = false;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: next } });
      if (generation !== this.generation) return;
      this.pendingCameraStream = newStream; // replaceTrack 未完成时，reset 也能立即停掉轨道
      const newTrack = newStream.getVideoTracks()[0];
      if (!newTrack) throw new Error('摄像头没有视频轨道');
      newTrack.enabled = old.enabled;
      await sender.replaceTrack(newTrack);
      if (generation !== this.generation) return;
      stream.removeTrack(old);
      old.stop();
      stream.addTrack(newTrack);
      adopted = true;
      newStream.getTracks().filter(t => t !== newTrack).forEach(t => t.stop());
      this.onEvent?.({ kind: 'local-stream', stream });
    } catch (e) {
      if (generation === this.generation) this.onEvent?.({ kind: 'error', message: '无法切换摄像头' });
    } finally {
      if (!adopted) newStream?.getTracks().forEach(t => t.stop());
      if (generation === this.generation) {
        this.pendingCameraStream = null;
        this.switchingCamera = false;
      }
    }
  }

  reset() {
    ++this.generation;
    clearInterval(this.timer);
    clearTimeout(this.noAnswerTimer);
    clearTimeout(this.incomingTimer);
    this.timer = this.noAnswerTimer = this.incomingTimer = null;
    this.stopRing();
    const pc = this.pc;
    this.pc = null;                 // 先失效回调，close 不能再次进入 end/reset
    if (pc) {
      pc.ontrack = pc.onicecandidate = pc.onconnectionstatechange = pc.oniceconnectionstatechange = null;
      try { pc.close(); } catch (_) {}
    }
    for (const stream of [this.localStream, this.remoteStream, this.pendingCameraStream]) {
      stream?.getTracks().forEach(t => t.stop());
    }
    this.localStream = this.remoteStream = this.pendingCameraStream = null;
    this.switchingCamera = false;
    this.iceQueue = [];
    this.connectedOnce = false;
    this.connectedAt = null;
    this.state = 'idle';
    this.callId = this.peerId = this.pendingSdp = null;
    this.onEvent?.({ kind: 'reset' });
  }

  /* 来电铃声：WebAudio 合成（无外部音频文件） */
  startRing() {
    this.stopRing();
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
    } catch (_) { this.stopRing(); }
  }

  stopRing() {
    clearTimeout(this.ringTimer);
    this.ringTimer = null;
    const ctx = this.ringCtx;
    this.ringCtx = null;
    try { ctx?.close().catch(() => {}); } catch (_) {}
  }
}
