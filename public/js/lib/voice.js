/** 语音消息录制：MediaRecorder 录音 + WebAudio 实时电平（用于波形） */

export class VoiceRecorder {
  constructor({ maxSec = 60 } = {}) {
    this.maxSec = maxSec;
    this.session = null;
    this.finishing = null;
    this.onTick = null;
    this.onLimit = null;
    this.onError = null;
  }

  get recording() { return !!this.session?.recording; }
  get starting() { return !!this.session && !this.session.recording; }
  get busy() { return !!(this.session || this.finishing); }

  async start() {
    if (this.busy) return false;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('浏览器不支持录音');
    const session = this.session = { chunks: [], peaks: [], recording: false };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // getUserMedia 无法取消权限弹窗，返回后立即停止已作废请求取得的轨道。
      if (this.session !== session) { stream.getTracks().forEach(t => t.stop()); return false; }
      session.stream = stream;
      const mime = pickMime();
      const mr = session.mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      mr.ondataavailable = (e) => { if (e.data?.size) session.chunks.push(e.data); };
      mr.onerror = () => {
        if (this.session !== session) return;
        this.stop(true);
        this.onError?.(new Error('录音设备异常，录音已取消'));
      };
      const ac = session.ac = new (window.AudioContext || window.webkitAudioContext)();
      const src = session.src = ac.createMediaStreamSource(stream);
      const analyser = session.analyser = ac.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      mr.start();
      session.startTime = performance.now();
      session.recording = true;
      session.raf = setInterval(() => {
        analyser.getByteFrequencyData(buf);
        let sum = 0;
        for (let i = 4; i < buf.length; i++) sum += buf[i];
        const level = Math.min(1, (sum / (buf.length - 4)) / 110);
        session.peaks.push(level);
        this.onTick?.(this.durationMs(), level);
      }, 60);
      session.maxTimer = setTimeout(() => {
        if (this.session !== session) return;
        if (this.onLimit) this.onLimit(); else this.stop(true);
      }, this.maxSec * 1000);
      return true;
    } catch (e) {
      if (this.session !== session) return false;
      this.session = null;
      this.release(session);
      this.detach(session);
      throw e;
    }
  }

  durationMs() {
    return this.recording ? performance.now() - this.session.startTime : 0;
  }

  /** 结束录音；cancel=true 时丢弃 */
  stop(cancel = false) {
    if (this.finishing) {
      if (cancel) { this.finishing.cancelled = true; this.finishing.finish(); }
      // 只有首次 stop 的调用方取得结果，避免重复发送。
      return Promise.resolve(null);
    }
    const session = this.session;
    if (!session) return Promise.resolve(null);
    const dur = this.durationMs();
    this.session = null;
    if (cancel || !session.recording) {
      this.release(session);
      this.detach(session);
      return Promise.resolve(null);
    }
    const mime = session.mr.mimeType || 'audio/webm';
    this.finishing = session;
    const stopped = new Promise(resolve => {
      session.finish = resolve;
      session.mr.onstop = resolve;
      session.mr.onerror = () => { session.cancelled = true; resolve(); };
      // 异常驱动可能不派发 stop，不能永久持有录音缓冲与闭包。
      session.stopTimer = setTimeout(() => { session.cancelled = true; resolve(); }, 1500);
    });
    this.release(session);
    return stopped.then(() => {
      try {
        if (session.cancelled) return null;
        const blob = new Blob(session.chunks, { type: mime });
        return blob.size ? { blob, duration: Math.round(dur) / 1000, peaks: downsample(session.peaks, 30) } : null;
      } finally {
        this.detach(session);
        if (this.finishing === session) this.finishing = null;
      }
    });
  }

  release(session) {
    clearTimeout(session.maxTimer);
    clearInterval(session.raf);
    session.maxTimer = session.raf = null;
    try { if (session.mr?.state !== 'inactive') session.mr?.stop(); } catch (_) { session.finish?.(); }
    session.stream?.getTracks().forEach(t => t.stop());
    try { session.src?.disconnect(); session.analyser?.disconnect(); } catch (_) {}
    try { session.ac?.close().catch(() => {}); } catch (_) {}
    session.stream = session.ac = session.src = session.analyser = null;
  }

  detach(session) {
    clearTimeout(session.stopTimer);
    if (session.mr) session.mr.ondataavailable = session.mr.onstop = session.mr.onerror = null;
    session.mr = session.finish = null;
    session.chunks = [];
    session.peaks = [];
  }

  cleanup() { return this.stop(true); }
}

function pickMime() {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  for (const c of cands) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(c)) return c;
  }
  return '';
}

function downsample(arr, n) {
  if (!arr.length) return new Array(n).fill(0.15);
  const out = [];
  const step = arr.length / n;
  for (let i = 0; i < n; i++) {
    const a = arr.slice(Math.floor(i * step), Math.max(1, Math.floor((i + 1) * step)));
    out.push(Math.max(...a, 0.08));
  }
  return out;
}
