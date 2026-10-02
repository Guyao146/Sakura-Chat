// 用可控的媒体设备/RTC/时钟模拟权限延迟与驱动异常，不依赖真实摄像头。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
const sources = await Promise.all(['call', 'voice'].map(name =>
  readFile(new URL('../public/js/lib/' + name + '.js', import.meta.url), 'utf8')));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fixture(t) {
  const env = { tracks: [], contexts: [], pcs: [], recorders: [], requests: [], timers: new Map(), now: 1000 };
  let seq = 0;
  const schedule = (fn, ms, interval = false) => {
    const id = ++seq; env.timers.set(id, { fn, ms, interval }); return id;
  };
  env.fire = ms => {
    for (const [id, timer] of [...env.timers]) {
      if (timer.ms !== ms || !env.timers.has(id)) continue;
      if (!timer.interval) env.timers.delete(id);
      timer.fn();
    }
  };
  env.stream = (video = false) => {
    const tracks = (video ? ['audio', 'video'] : ['audio']).map(kind => {
      const track = { kind, enabled: true, stopped: false, stop() { this.stopped = true; },
        getSettings: () => ({ facingMode: 'user' }) };
      env.tracks.push(track); return track;
    });
    return { getTracks: () => [...tracks], getAudioTracks: () => tracks.filter(t => t.kind === 'audio'),
      getVideoTracks: () => tracks.filter(t => t.kind === 'video'),
      addTrack: t => tracks.push(t), removeTrack: t => tracks.splice(tracks.indexOf(t), 1) };
  };
  class AudioContext {
    constructor() { this.closed = false; this.currentTime = 0; env.contexts.push(this); }
    close() { this.closed = true; return env.closeReject ? Promise.reject(new Error('close')) : Promise.resolve(); }
    node() { return { connect() { return this; }, disconnect() {} }; }
    createMediaStreamSource() { if (env.audioFail) throw new Error('audio'); return this.node(); }
    createAnalyser() { return { ...this.node(), frequencyBinCount: 128, getByteFrequencyData: b => b.fill(50) }; }
    createOscillator() {
      if (env.ringFail) throw new Error('ring');
      return { ...this.node(), frequency: {}, start() {}, stop() {} };
    }
    createGain() { return { ...this.node(), gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
  }
  class MediaRecorder {
    static isTypeSupported(mime) { return mime === 'audio/mp4'; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/mp4'; env.recorders.push(this); }
    start() { if (env.recordFail) throw new Error('record'); this.state = 'recording'; }
    finish() { this.ondataavailable?.({ data: new Blob(['voice']) }); this.onstop?.(); }
    stop() {
      this.state = 'inactive';
      if (!env.holdStop) queueMicrotask(() => this.finish());
    }
  }
  class RTCPeerConnection {
    constructor() { this.senders = []; this.ice = []; this.closed = false; env.pcs.push(this); }
    addTrack(track) {
      this.senders.push({ track, replaceTrack: async next => {
        if (env.replace) await env.replace.promise;
        this.senders.find(s => s.track === track).track = next;
      } });
    }
    getSenders() { return this.senders; }
    async createOffer() { return env.offer ? env.offer.promise : { type: 'offer', sdp: 'offer' }; }
    async createAnswer() { return env.answer ? env.answer.promise : { type: 'answer', sdp: 'answer' }; }
    async setLocalDescription(d) { if (env.localFail) throw new Error('SDP'); this.localDescription = d; }
    async setRemoteDescription(d) { if (env.remote) await env.remote.promise; this.remoteDescription = d; }
    async addIceCandidate(c) { assert.ok(this.remoteDescription); this.ice.push(c); }
    close() { this.closed = true; this.connectionState = 'closed'; this.onconnectionstatechange?.(); }
  }
  const context = vm.createContext({
    navigator: { mediaDevices: { getUserMedia: options => {
      env.requests.push(options);
      return env.media ? env.media(options) : Promise.resolve(env.stream(!!options.video));
    } } },
    window: { AudioContext }, MediaRecorder, RTCPeerConnection, Blob,
    crypto: { randomUUID }, performance: { now: () => env.now },
    setTimeout: (fn, ms) => schedule(fn, ms), setInterval: (fn, ms) => schedule(fn, ms, true),
    clearTimeout: id => env.timers.delete(id), clearInterval: id => env.timers.delete(id),
  });
  const [CallManager, VoiceRecorder] = sources.map((src, i) =>
    vm.runInContext(src.replace('export class ', 'class ') + '\n' + ['CallManager', 'VoiceRecorder'][i], context));
  env.sent = []; env.events = [];
  env.call = new CallManager({ socket: { send: e => env.sent.push(e) }, getMe: () => ({ id: 1 }) });
  env.call.onEvent = e => env.events.push(e);
  env.rec = new VoiceRecorder();
  env.incoming = () => env.call.onIncoming({ from: 2, callId: 'incoming', media: 'video', sdp: 'offer' });
  t.after(() => {
    assert.equal(env.timers.size, 0, '没有遗留定时器');
    assert.ok(env.tracks.every(t => t.stopped), '没有遗留媒体轨道');
    assert.ok(env.contexts.every(c => c.closed), '没有遗留 AudioContext');
    assert.ok(env.pcs.every(pc => pc.closed), '没有遗留 PeerConnection');
    assert.ok(env.recorders.every(mr => mr.state === 'inactive'), '没有遗留编码器');
  });
  return env;
}

for (const direction of ['outgoing', 'incoming']) {
  test(direction + '：权限等待期间挂断，迟到媒体流立即释放', async t => {
    const e = fixture(t), pending = deferred();
    e.media = () => pending.promise;
    if (direction === 'incoming') e.incoming();
    const task = direction === 'incoming' ? e.call.accept() : e.call.start(2, 'video');
    await e.call.accept();
    assert.equal(e.requests.length, 1);
    e.call.end();
    pending.resolve(e.stream(true)); await task;
    assert.equal(e.call.state, 'idle');
    assert.equal(e.pcs.length, 0);
    assert.ok(!e.sent.some(x => x.type === 'call_offer' || x.type === 'call_answer'));
  });
}

test('旧权限请求失败不能结束新通话', async t => {
  const e = fixture(t), old = deferred(); e.media = () => old.promise;
  const task = e.call.start(2, 'audio'); e.call.end();
  e.media = null; await e.call.start(3, 'video'); const pc = e.call.pc;
  old.reject(new Error('denied')); await task;
  assert.equal(e.call.pc, pc); assert.equal(pc.closed, false);
  e.call.end();
});

for (const stage of ['offer', 'answer']) {
  test(stage + '：挂断后迟到的 SDP 不得发送或重建定时器', async t => {
    const e = fixture(t); e[stage] = deferred();
    if (stage === 'answer') e.incoming();
    const task = stage === 'offer' ? e.call.start(2, 'video') : e.call.accept();
    await flush(); assert.ok(e.call.pc);
    e.call.end(); e[stage].resolve({ type: stage, sdp: 'late' }); await task;
    assert.ok(!e.sent.some(x => x.type === 'call_' + stage));
  });
}

test('SDP 异常和建连超时都释放资源', async t => {
  const e = fixture(t); e.localFail = true; await e.call.start(2, 'video');
  assert.equal(e.call.state, 'idle');
  e.localFail = false; await e.call.start(2, 'video');
  await e.call.onAnswer({ callId: e.call.callId, sdp: 'answer' });
  e.fire(45000); assert.equal(e.call.state, 'idle');
});

test('远端挂断已接通的通话，移除旧 PC 回调和所有媒体/计时资源', async t => {
  const e = fixture(t); await e.call.start(2, 'video'); const pc = e.call.pc;
  const lateState = pc.onconnectionstatechange, lateIce = pc.onicecandidate;
  const remote = e.stream(true); pc.ontrack({ streams: [remote] });
  pc.connectionState = 'connected'; lateState();
  e.call.onEnd({ callId: e.call.callId, from: 1, reason: 'answered' });
  assert.equal(e.call.state, 'connected');
  e.call.onEnd({ callId: e.call.callId, from: 2, reason: 'hangup' });
  assert.equal(e.call.state, 'idle'); assert.equal(pc.ontrack, null);
  const sent = e.sent.length; lateIce({ candidate: {} }); lateState();
  assert.equal(e.sent.length, sent); e.call.reset();
});

test('ICE/应答按通话隔离，候选仅在远端描述就绪后补发且队列有上限', async t => {
  const e = fixture(t); await e.call.start(2, 'audio'); const id = e.call.callId, pc = e.call.pc;
  await e.call.onIce({ callId: 'old', candidate: {} });
  await e.call.onAnswer({ callId: 'old', sdp: 'old' });
  assert.equal(pc.remoteDescription, undefined);
  assert.equal(e.call.iceQueue.length, 0);
  for (let i = 0; i < 300; i++) await e.call.onIce({ callId: id, candidate: { i } });
  assert.equal(e.call.iceQueue.length, 256); assert.equal(pc.ice.length, 0);
  await e.call.onAnswer({ callId: id, sdp: 'answer' });
  assert.equal(pc.ice.length, 256); assert.equal(e.call.iceQueue.length, 0);
  e.call.onIncoming({ callId: 'other', from: 3 });
  assert.equal(e.sent.at(-1).callId, 'other');
  e.call.end(); await e.call.onIce({ callId: id, candidate: {} });
  assert.equal(e.call.iceQueue.length, 0);
});

for (const stage of ['permission', 'replace', 'failure', 'success']) {
  test('摄像头切换 ' + stage + '：去重并回收未采用轨道', async t => {
    const e = fixture(t); await e.call.start(2, 'video');
    const old = e.call.localStream.getVideoTracks()[0]; old.enabled = false;
    const pending = deferred();
    if (stage === 'permission') e.media = () => pending.promise;
    else e.replace = pending;
    const task = e.call.switchCamera(); await flush();
    await e.call.switchCamera(); assert.equal(e.requests.length, 2);
    if (stage === 'permission') { e.call.end(); pending.resolve(e.stream(true)); }
    else if (stage === 'replace') {
      e.call.end(); assert.ok(e.tracks.every(t => t.stopped)); pending.resolve();
    } else if (stage === 'failure') pending.reject(new Error('replace'));
    else pending.resolve();
    await task;
    if (stage === 'success') {
      assert.equal(old.stopped, true);
      assert.equal(e.call.localStream.getVideoTracks()[0].enabled, false);
    }
    if (stage === 'failure') assert.equal(old.stopped, false);
    e.call.end();
  });
}

test('铃声初始化失败或重复启动都会关闭 AudioContext，close 拒绝不泄漏', async t => {
  const e = fixture(t); e.ringFail = true; e.closeReject = true;
  e.call.startRing(); assert.equal(e.call.ringCtx, null);
  e.ringFail = false; e.call.startRing(); e.call.startRing();
  assert.equal(e.contexts.filter(c => !c.closed).length, 1);
  e.call.stopRing(); await flush();
});

test('录音权限等待期间重复开始只请求一次，松手后迟到流不复活', async t => {
  const e = fixture(t), pending = deferred(); e.media = () => pending.promise;
  const start = e.rec.start();
  assert.equal(e.rec.starting, true);
  assert.equal(await e.rec.start(), false); assert.equal(e.requests.length, 1);
  await e.rec.stop(false); pending.resolve(e.stream());
  assert.equal(await start, false); assert.equal(e.rec.busy, false);
  assert.equal(e.recorders.length, 0);
});

for (const failure of ['audioFail', 'recordFail']) {
  test('录音初始化 ' + failure + '：部分创建的资源也被释放', async t => {
    const e = fixture(t); e[failure] = true;
    await assert.rejects(e.rec.start()); assert.equal(e.rec.busy, false);
    assert.equal(e.timers.size, 0);
  });
}

test('正常结束录音保留真实时长和编码类型，等待编码结束期间设备已释放', async t => {
  const e = fixture(t); await e.rec.start(); e.fire(60); e.now += 2345;
  const mr = e.recorders[0], session = e.rec.session;
  const task = e.rec.stop();
  assert.ok(e.tracks.every(t => t.stopped)); assert.ok(e.contexts.every(c => c.closed));
  assert.equal(await e.rec.stop(), null);
  const result = await task;
  assert.equal(result.duration, 2.345); assert.equal(result.blob.type, 'audio/mp4');
  assert.equal(await result.blob.text(), 'voice'); assert.equal(result.peaks.length, 30);
  assert.equal(e.rec.busy, false); assert.equal(mr.ondataavailable, null);
  assert.equal(session.chunks.length, 0); assert.equal(session.peaks.length, 0);
});

test('录音结束事件缺失时有界清理；等待结束期间仍可取消', async t => {
  const e = fixture(t); e.holdStop = true;
  await e.rec.start(); const task = e.rec.stop();
  assert.equal(await e.rec.start(), false);
  e.fire(1500); assert.equal(await task, null); assert.equal(e.rec.busy, false);
  await e.rec.start(); const second = e.rec.stop();
  await e.rec.stop(true); assert.equal(await second, null);
  assert.equal(e.rec.busy, false);
});

test('录音设备异常及达到时限不留下采集/采样任务', async t => {
  const e = fixture(t); let errors = 0;
  e.rec.onError = () => errors++;
  await e.rec.start(); e.recorders[0].onerror(); await flush();
  assert.equal(errors, 1); assert.equal(e.rec.busy, false);
  await e.rec.start(); e.fire(60000); await flush();
  assert.equal(e.rec.busy, false);
  let result;
  e.rec.onLimit = async () => { result = await e.rec.stop(); };
  await e.rec.start(); e.now += 60000; e.fire(60000); await flush();
  assert.equal(result.duration, 60); assert.equal(e.rec.busy, false);
});

test('旧录音结束事件不能清理下一次录音，连续 100 轮启停资源归零', async t => {
  const e = fixture(t); e.holdStop = true;
  await e.rec.start(); const old = e.recorders[0]; await e.rec.stop(true);
  await e.rec.start(); old.finish();
  assert.equal(e.rec.recording, true); await e.rec.stop(true);
  e.holdStop = false;
  for (let i = 0; i < 100; i++) {
    await e.call.start(2, 'audio'); e.call.end();
    await e.rec.start(); e.now += 1000; await e.rec.stop(i % 2 === 0);
    assert.equal(e.timers.size, 0);
    assert.ok(e.tracks.every(t => t.stopped));
    assert.ok(e.contexts.every(c => c.closed));
    assert.ok(e.pcs.every(pc => pc.closed));
  }
});
