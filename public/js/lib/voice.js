/** 语音消息录制：MediaRecorder 录音 + WebAudio 实时电平（用于波形） */

export class VoiceRecorder {
  constructor({ maxSec = 60 } = {}) {
    this.maxSec = maxSec;
    this.recording = false;
    this.onTick = null;
  }

  async start() {
    if (this.recording) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('浏览器不支持录音');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.stream = stream;
    const mime = pickMime();
    this.mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.peaks = [];
    this.mr.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.startTime = performance.now();

    // 采集频谱电平用于波形显示
    this.ac = new (window.AudioContext || window.webkitAudioContext)();
    const src = this.ac.createMediaStreamSource(stream);
    const analyser = this.ac.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    this.raf = setInterval(() => {
      analyser.getByteFrequencyData(buf);
      let sum = 0;
      for (let i = 4; i < buf.length; i++) sum += buf[i];
      const level = Math.min(1, (sum / (buf.length - 4)) / 110);
      this.peaks.push(level);
      this.onTick?.(this.durationMs(), level);
    }, 60);

    this.mr.start();
    this.recording = true;
    this.maxTimer = setTimeout(() => this.stop(false), this.maxSec * 1000);
  }

  durationMs() {
    return this.recording ? performance.now() - this.startTime : 0;
  }

  /** 结束录音；cancel=true 时丢弃 */
  async stop(cancel = false) {
    if (!this.recording) return null;
    clearTimeout(this.maxTimer);
    clearInterval(this.raf);
    this.recording = false;
    const dur = this.durationMs();
    await new Promise((resolve) => {
      this.mr.onstop = resolve;
      try { this.mr.stop(); } catch (_) { resolve(); }
    });
    this.cleanup();
    if (cancel) return null;
    const blob = new Blob(this.chunks, { type: this.mr?.mimeType || 'audio/webm' });
    if (!blob.size) return null;
    return { blob, duration: Math.round(dur) / 1000, peaks: downsample(this.peaks, 30) };
  }

  cleanup() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ac?.close().catch(() => {});
    this.stream = null;
    this.ac = null;
    this.mr = null;
  }
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
