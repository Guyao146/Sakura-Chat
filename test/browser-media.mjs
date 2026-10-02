// 真实 Chrome MediaRecorder/WebAudio/WebRTC；音源由 WebAudio 生成，无需硬件/权限或公网 STUN。
import assert from 'node:assert/strict';
import { launchBrowser } from './browser-helper.mjs';
const host = process.env.HOST || 'http://127.0.0.1:3130';
const browser = await launchBrowser();
const { send, evaluate, wait } = browser;
let passed = 0;
const check = (name, ok) => { assert.ok(ok, name); console.log('  [PASS] ' + name); passed++; };
try {
  await send('Page.navigate', { url: host });
  await wait(`location.origin === ${JSON.stringify(host)} && document.readyState === 'complete'`);
  await evaluate(`(async () => {
    const { VoiceRecorder } = await import('/js/lib/voice.js');
    const { CallManager } = await import('/js/lib/call.js');
    const streams = [], sources = [], contexts = [], peers = [];
    const NativeAudioContext = window.AudioContext, NativePC = window.RTCPeerConnection;
    window.AudioContext = class extends NativeAudioContext {
      constructor(...args) { super(...args); contexts.push(this); }
    };
    window.RTCPeerConnection = class extends NativePC {
      constructor() { super({ iceServers: [] }); peers.push(this); }
    };
    const makeStream = () => {
      const source = new NativeAudioContext(); sources.push(source);
      const dest = source.createMediaStreamDestination();
      const oscillator = source.createOscillator();
      oscillator.connect(dest); oscillator.start();
      streams.push(dest.stream); return dest.stream;
    };
    navigator.mediaDevices.getUserMedia = async () => makeStream();
    window.__media = { VoiceRecorder, CallManager, streams, sources, contexts, peers, makeStream,
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
  })()`);
  const recording = await evaluate(`(async () => {
    const m = window.__media, rec = new m.VoiceRecorder(); m.rec = rec;
    await rec.start(); await m.sleep(1200); const result = await rec.stop();
    await m.sleep(50);
    return { duration: result?.duration, size: result?.blob.size, type: result?.blob.type,
      idle: !rec.busy, stopped: m.streams.every(s => s.getTracks().every(t => t.readyState === 'ended')),
      closed: m.contexts.every(c => c.state === 'closed') };
  })()`);
  check('真实录音有内容、时长和编码类型', recording.size > 0 && recording.duration >= 1 && recording.type.startsWith('audio/'));
  check('正常录音结束释放轨道和 AudioContext', recording.idle && recording.stopped && recording.closed);
  check('取消后迟到的真实音频轨道立即停止', await evaluate(`(async () => {
    const m = window.__media; let resolve;
    navigator.mediaDevices.getUserMedia = () => new Promise(r => resolve = r);
    const task = m.rec.start(); await m.rec.stop(true);
    const stream = m.makeStream(); resolve(stream);
    const started = await task;
    navigator.mediaDevices.getUserMedia = async () => m.makeStream();
    return !started && !m.rec.busy && stream.getTracks().every(t => t.readyState === 'ended');
  })()`));
  await evaluate(`(() => {
    const m = window.__media;
    const deliver = (target, from, evt) => {
      if (evt.to === from) return;
      const method = { call_offer: 'onIncoming', call_answer: 'onAnswer', call_ice: 'onIce', call_end: 'onEnd' }[evt.type];
      if (method) target[method]({ ...evt, from });
      if (evt.type === 'call_offer') target.accept();
    };
    m.a = new m.CallManager({ getMe: () => ({ id: 1 }), socket: { send: evt => queueMicrotask(() => deliver(m.b, 1, evt)) } });
    m.b = new m.CallManager({ getMe: () => ({ id: 2 }), socket: { send: evt => queueMicrotask(() => deliver(m.a, 2, evt)) } });
    m.a.start(2, 'audio');
  })()`);
  await wait(`window.__media.a.state === 'connected' && window.__media.b.state === 'connected'`, 15000);
  check('真实 WebRTC 双端建连正常', true);
  await evaluate(`window.__media.a.end()`);
  await wait(`window.__media.b.state === 'idle'`);
  check('一端挂断后双端 PeerConnection 与媒体轨道全部结束', await evaluate(`(() => {
    const m = window.__media;
    return m.peers.every(pc => pc.connectionState === 'closed') &&
      m.streams.every(s => s.getTracks().every(t => t.readyState === 'ended')) &&
      !m.a.localStream && !m.b.localStream && !m.a.remoteStream && !m.b.remoteStream &&
      m.a.timer === null && m.b.timer === null && m.a.noAnswerTimer === null && m.b.noAnswerTimer === null;
  })()`));
  check('媒体回收无未捕获异常', browser.errors.length === 0);
  console.log('浏览器媒体回归: ' + passed + ' 通过');
} finally {
  try {
    await evaluate(`(async () => {
      const m = window.__media;
      if (!m) return;
      m.a?.end(); m.b?.end(); await m.rec?.stop(true);
      m.streams.forEach(s => s.getTracks().forEach(t => t.stop()));
      await Promise.all(m.sources.map(c => c.close()));
    })()`);
  } finally { await browser.close(); }
}
