/** 主应用：会话列表、聊天窗口、实时事件处理 */

import { $, $$, toast, openModal, closeModal, confirmModal, avatarHtml, formatTime, escapeHtml, fileToBase64, debounce, isImageFilename, renderMarkdown, humanSize } from './lib/util.js';
import { api, setToken } from './lib/api.js';
import { ChatSocket } from './lib/socket.js';
import { EMOJIS } from './lib/emoji.js';
import { VoiceRecorder } from './lib/voice.js';
import { CallManager } from './lib/call.js';

const state = {
  me: null,
  socket: null,
  conversations: [],          // [{ convId, convType, peer?, group?, unread, lastMessage, lastTime }]
  convMap: new Map(),         // convId -> conv
  activeConvId: null,
  messages: new Map(),        // convId -> [msg]
  msgMap: new Map(),          // msgId -> msg
  hasMore: new Map(),         // convId -> bool
  loadingMore: false,
  friends: [],
  pendingRequests: [],
  users: new Map(),           // userId -> user（昵称/头像缓存）
  typingTimer: null,
  call: null,
  recorder: null,
  replyDraft: null,            // 待发送的引用回复 { msgId, snip }
  forwardDraft: null,          // 待转发的消息
  statusTimer: null,
};

let lastConvIds = [];          // 上次渲染的会话 id 列表，用于「新增会话」出现动画
let ctxMenu = null;            // 当前打开的右键/长按菜单
let statusInited = false;      // 在线状态是否已初始化
const INPUT_H_KEY = 'sakura-input-height';   // 输入框基准高度（localStorage）
let inputBaseH = 40;           // 输入框基准高度：单行约 40px，可由用户拖拽调节

export async function initApp({ token, user, sessionId, sessionKey }) {
  state.me = user;
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  renderMyProfile();
  if (window.innerWidth <= 1020) document.body.classList.add('show-sidebar');
  bindGlobalEvents();
  bindChatEvents();
  ensureMyStatus();
  applySidebarWidth();
  bindSidebarResizer();
  applyInputHeight();
  bindInputResizer();

  state.socket = new ChatSocket({
    token, sessionId, sessionKey,
    onMessage: handleSocketMessage,
    onState: (s) => {
      if (s === 'close') {
        toast('连接已断开，正在重连...', 3000);
        state.call?.end('disconnected');   // WS 断开时主动结束通话
      }
    },
  });
  await state.socket.connect();
  state.call = new CallManager({ socket: state.socket, getMe: () => state.me });
  state.call.onEvent = handleCallEvent;

  await Promise.all([loadConversations(), loadFriends(), refreshRequestsBadge()]);
  cacheUser(user);
}

function logout() {
  state.socket?.close();
  localStorage.removeItem('sc_token');
  setToken(null);
  location.reload();
}

/* ---------------- 侧边栏宽度拖拽（持久化） ---------------- */
const SIDEBAR_W_KEY = 'sc_sidebar_width';
const SIDEBAR_MIN = 220, SIDEBAR_MAX = 480;

/** 启动时恢复上次的侧边栏宽度（仅桌面端生效） */
function applySidebarWidth() {
  const bar = document.querySelector('.sidebar');
  if (!bar) return;
  if (window.innerWidth <= 1020) {
    bar.style.width = '';                    // 移动端交给媒体查询控制
    return;
  }
  const w = Number(localStorage.getItem(SIDEBAR_W_KEY));
  if (w >= SIDEBAR_MIN && w <= SIDEBAR_MAX) {
    bar.style.width = w + 'px';
  }
}

// 窗口尺寸变化时：桌面↔移动端切换，纠正内联宽度并自动显隐侧边栏
window.addEventListener('resize', () => {
  const mobile = window.innerWidth <= 1020;
  const bar = document.querySelector('.sidebar');
  if (mobile) {
    if (bar) bar.style.width = '';
    document.body.classList.add('show-sidebar');   // 进入移动端宽度，自动显示会话列表
  } else {
    document.body.classList.remove('show-sidebar'); // 回到桌面端，恢复双栏
    applySidebarWidth();
  }
  applyInputHeight();   // 输入框基准高度按新视口重新 clamp，并按内容重算
});

function bindSidebarResizer() {
  const resizer = $('#sidebar-resizer');
  const bar = document.querySelector('.sidebar');
  if (!resizer || !bar) return;

  let startX = 0, startW = 0;
  const onMove = (e) => {
    const x = e.touches ? e.touches[0].clientX : e.clientX;
    const w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startW + (x - startX)));
    bar.style.width = w + 'px';
  };
  const onUp = () => {
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem(SIDEBAR_W_KEY, bar.style.width);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  const onDown = (e) => {
    if (window.innerWidth <= 1020) return;   // 移动端不拖拽
    e.preventDefault();
    startX = e.touches ? e.touches[0].clientX : e.clientX;
    startW = bar.getBoundingClientRect().width;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  resizer.addEventListener('pointerdown', onDown);
}

/* ---------------- 输入框高度：自适应 + 用户可拖拽 ---------------- */

/** 输入框高度上限：视口的 40%，并限制在 [120, 360]px，避免小屏下挤压消息列表 */
function inputMaxH() {
  return Math.max(120, Math.min(360, window.innerHeight * 0.4));
}

/** 读取用户保存的基准高度并按当前视口 clamp，随后按内容重算高度 */
function applyInputHeight() {
  const v = parseInt(localStorage.getItem(INPUT_H_KEY) || '', 10);
  if (Number.isFinite(v)) inputBaseH = Math.min(Math.max(v, 40), inputMaxH());
  const input = $('#msg-input');
  if (input) autoResize(input);
}

/** 输入框顶部把手：上下拖动改变基准高度，记忆到 localStorage */
function bindInputResizer() {
  const resizer = $('#input-resizer');
  const input = $('#msg-input');
  if (!resizer || !input) return;

  let startY = 0, startH = 0;
  const onMove = (e) => {
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    inputBaseH = Math.min(inputMaxH(), Math.max(40, startH + (y - startY)));
    autoResize(input);
  };
  const onUp = () => {
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem(INPUT_H_KEY, String(inputBaseH));
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  resizer.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return;           // 触屏不拖拽，避免与手势冲突
    if (window.innerWidth <= 1020) return;           // 与侧边栏一致：窄屏不拖拽
    e.preventDefault();
    startY = e.clientY;
    startH = inputBaseH;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

/* ---------------- 基础数据 ---------------- */

function convOf(convId) { return state.convMap.get(convId); }
function isConvActive(convId) { return state.activeConvId === convId; }

function cacheUser(u) {
  if (u && u.id) state.users.set(u.id, u);
}
function cacheUsers(ids) {
  for (const id of ids) {
    if (!id || state.users.has(id) || id === state.me.id) continue;
    api.getUser(id).then(({ user }) => cacheUser(user)).catch(() => {});
  }
}
function senderOf(msg) {
  if (msg.senderId === state.me.id) return state.me;
  return state.users.get(msg.senderId) || { nickname: '用户' + msg.senderId };
}

async function loadConversations() {
  const { conversations } = await api.conversations();
  state.conversations = conversations;
  state.convMap = new Map(conversations.map(c => [c.convId, c]));
  for (const c of conversations) if (c.convType === 'single') cacheUser(c.peer);
  renderConvList();
  updateTitleBadge();
}

async function loadFriends() {
  const { friends } = await api.friends();
  state.friends = friends;
  friends.forEach(cacheUser);
}

async function refreshRequestsBadge() {
  try {
    const { requests } = await api.requests();
    state.pendingRequests = requests;
    const badge = $('#requests-badge');
    badge.hidden = !requests.length;
    badge.textContent = requests.length > 99 ? '99+' : requests.length;
  } catch (_) {}
}

function updateTitleBadge() {
  const total = state.conversations.reduce((s, c) => s + (c.unread || 0), 0);
  document.title = total ? `(${total > 99 ? '99+' : total}) Sakura Chat` : 'Sakura Chat';
}

function renderMyProfile() {
  const me = state.me;
  $('#my-avatar').outerHTML = avatarHtml(me, '').replace('class="avatar', 'id="my-avatar" class="avatar');
  $('#my-nickname').textContent = me.nickname;
  $('#my-signature').textContent = me.signature || '@' + me.username;
}
/* ---------------- 会话列表渲染 ---------------- */

function renderConvList() {
  const q = ($('#conv-search').value || '').trim();
  let convs = state.conversations;
  if (q) {
    convs = convs.filter(c =>
      (c.convType === 'single' ? (c.peer.remark || c.peer.nickname) : c.group.name).includes(q)
    );
  }
  const list = $('#conv-list');
  if (!convs.length) {
    list.innerHTML = `<div class="no-data">${q ? '没有匹配的会话' : '暂无会话，点击 ➕ 添加好友'}</div>`;
    return;
  }
  // 仅对「新增」的会话播放出现动画，避免整列表重渲时闪烁；搜索结果不动画
  const ids = convs.map(c => c.convId);
  const newSet = q ? new Set() : new Set(ids.filter(id => !lastConvIds.includes(id)));
  lastConvIds = ids;
  list.innerHTML = convs.map(c => convItemHtml(c, newSet.has(c.convId))).join('');
}

function convItemHtml(c, anim) {
  const name = c.convType === 'single' ? (c.peer.remark || c.peer.nickname) : c.group.name;
  const avatarUser = c.convType === 'single' ? c.peer : { nickname: c.group.name, avatar: c.group.avatar };
  const last = c.lastMessage;
  return `<div class="conv-item ${isConvActive(c.convId) ? 'active' : ''} ${anim ? 'anim-in' : ''} ${c.pinned ? 'pinned' : ''}" data-convid="${c.convId}">
    <div class="conv-avatar-wrap" data-pat="${c.convType === 'single' ? c.peer.id : ''}">
      ${avatarHtml(avatarUser)}
      ${c.convType === 'single' && c.peer.online ? '<span class="online-dot"></span>' : ''}
    </div>
    ${c.muted ? '<span class="muted-ico" title="已开启免打扰">🔇</span>' : ''}
    <div class="conv-main">
      <div class="conv-top">
        <div class="conv-name">${c.pinned ? '<span class="pin-ico" title="置顶">📌</span> ' : ''}${escapeHtml(name)}</div>
        <div class="conv-time">${last ? formatTime(last.createdAt) : ''}</div>
      </div>
      <div class="conv-bottom">
        <div class="conv-last">${escapeHtml(last ? previewText(last) : '开始聊天吧')}</div>
        ${c.unread ? `<span class="conv-unread ${c.muted ? 'muted-badge' : ''}">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}
      </div>
    </div>
  </div>`;
}

function previewText(m) {
  if (m.revoked) return '撤回了一条消息';
  if (m.kind === 'system') return m.content.text || '';
  if (m.kind === 'image') return '[图片]';
  if (m.kind === 'voice') return m.content.text ? `[语音] ${m.content.text}` : '[语音]';
  if (m.kind === 'sticker') return '[表情]';
  if (m.kind === 'file') return `[文件] ${m.content.name || ''}`;
  const base = m.content.text || '';
  if (!base) return '';
  const extra = (m.forwardFrom ? '「转发」' : '') + (m.replyTo ? '「回复」' : '') + (m.ats?.length ? '「@」' : '');
  return extra + base;
}

/* ---------------- 聊天窗口渲染 ---------------- */

async function openConv(convId) {
  const conv = convOf(convId);
  if (!conv) return;
  // 切换会话前取消未完成的录音
  if (state.recorder?.recording) {
    await state.recorder.stop(true);
    $('#voice-recording').hidden = true;
  }
  state.activeConvId = convId;
  state.messages.delete(convId);
  $('#chat-empty').hidden = true;
  $('#chat-main').hidden = false;
  $('#search-panel').hidden = true;
  $('#emoji-panel').hidden = true;
  $('#msg-list').innerHTML =
    '<div class="skel-wrap">' +
    '<div class="skel-row"><div class="skel skel-avatar"></div><div class="skel skel-bubble"></div></div>' +
    '<div class="skel-row mine"><div class="skel skel-avatar"></div><div class="skel skel-bubble"></div></div>' +
    '<div class="skel-row"><div class="skel skel-avatar"></div><div class="skel skel-bubble"></div></div>' +
    '<div class="skel-row mine"><div class="skel skel-avatar"></div><div class="skel skel-bubble"></div></div>' +
    '</div>';
  renderConvList();
  document.body.classList.remove('show-sidebar');

  await renderChatHeader(conv);
  try {
    const data = await api.messages(convId);
    state.messages.set(convId, data.messages);
    state.hasMore.set(convId, data.hasMore);
  } catch (e) {
    state.messages.set(convId, []);
    toast('加载消息失败：' + e.message);
  }
  renderMessages(false);
  markActiveConvRead();
  $('#msg-input').focus();
}

async function renderChatHeader(conv) {
  if (conv.convType === 'single') {
    $('#chat-title').textContent = conv.peer.remark || conv.peer.nickname;
    updatePresenceSubtitle();
    cacheUser(conv.peer);
  } else {
    $('#btn-call-voice').hidden = true;
    $('#btn-call-video').hidden = true;
    $('#chat-title').textContent = conv.group.name;
    $('#chat-subtitle').textContent = '群聊';
    if (!conv.members) {
      try {
        const { group } = await api.group(conv.group.id);
        conv.groupDetail = group;
        conv.members = group.members;
        group.members.forEach(cacheUser);
      } catch (_) {}
    }
    $('#chat-subtitle').textContent = `群聊${conv.members ? ' · ' + conv.members.length + ' 人' : ''}`;
    return;
  }
  // 单聊：开放音视频通话（群聊暂不支持）
  $('#btn-call-voice').hidden = false;
  $('#btn-call-video').hidden = false;
}

/** 全局搜索（Telegram 式：跨会话搜消息/联系人/群） */
async function openGlobalSearch(q) {
  if (!q) return;
  openModal(`
    <div class="modal-header">全局搜索：${escapeHtml(q)}<button class="modal-close" data-act="close">✕</button></div>
    <div class="modal-body"><div class="search-all-loading">搜索中...</div></div>`);
  let res;
  try { res = await api.searchAll(q); } catch (e) { closeModal(); toast(e.message); return; }
  const { conversations = [], groups = [], users = [], messages = [] } = res;
  const mk = (label, html) => `<div class="sr-group"><div class="sr-title">${label}</div>${html}</div>`;
  const convRows = conversations.map(c => `<div class="user-row" data-open="${c.convId}">
      ${avatarHtml(c.convType === 'single' ? c.peer : { nickname: c.group.name, avatar: c.group.avatar })}
      <div class="info"><div class="name">${escapeHtml(c.convType === 'single' ? (c.peer.remark || c.peer.nickname) : c.group.name)}</div>
      <div class="sub">${escapeHtml(c.snip || '')}</div></div></div>`).join('');
  const groupRows = groups.map(g => `<div class="user-row" data-openg="${g.id}">
      ${avatarHtml({ nickname: g.name, avatar: g.avatar })}
      <div class="info"><div class="name">${escapeHtml(g.name)}</div><div class="sub">${g.memberCount} 人</div></div></div>`).join('');
  const userRows = users.map(u => `<div class="user-row" data-addu="${u.id}">
      ${avatarHtml(u)}<div class="info"><div class="name">${escapeHtml(u.nickname)}</div>
      <div class="sub">@${escapeHtml(u.username)}</div></div></div>`).join('');
  const msgRows = messages.map(mm => `<div class="user-row" data-openmsg="${mm.convId}">
      <div class="info"><div class="name">${escapeHtml(mm.snip)}</div>
      <div class="sub">${escapeHtml(mm.convName || '')} · ${formatTime(mm.createdAt)}</div></div></div>`).join('');
  const body = $('#modal-box .modal-body');
  if (!body) { closeModal(); return; }
  body.innerHTML = (mk('会话', convRows) + mk('群组', groupRows) + mk('用户', userRows) + mk('消息', msgRows))
    || '<div class="no-data">没有找到结果</div>';
  body.addEventListener('click', (e) => {
    if (e.target.dataset.act === 'close') { closeModal(); return; }
    const row = e.target.closest('.user-row');
    if (!row) return;
    closeModal();
    if (row.dataset.open || row.dataset.openmsg) openConv(row.dataset.open || row.dataset.openmsg);
    else if (row.dataset.openg) openGroupDetail(row.dataset.openg);
    else if (row.dataset.addu) openAddFriendModal(row.dataset.addu);
  });
}

/** 收藏夹弹窗（Telegram Saved Messages 式） */
async function openSavedModal() {
  openModal(`
    <div class="modal-header">我的收藏<button class="modal-close" data-act="close">✕</button></div>
    <div class="modal-body"><div class="sr-loading">加载中...</div></div>`);
  let res;
  try { res = await api.savedList(); } catch (e) { closeModal(); toast(e.message); return; }
  const items = res.saved || [];
  const body = $('#modal-box .modal-body');
  if (!body) { closeModal(); return; }
  if (!items.length) {
    body.innerHTML = '<div class="no-data">暂无收藏<br><span class="sub">在消息上点「收藏」即可保存</span></div>';
    return;
  }
  body.innerHTML = items.map(s => `<div class="user-row" data-saved="${s.id}">
    <div class="info"><div class="name">${escapeHtml(s.msg.snip || s.msg.content?.text || '[内容]')}</div>
    <div class="sub">${formatTime(s.msg.createdAt)} · ${s.msg.kind}</div></div>
    <button class="modal-btn ghost" data-del="${s.id}" style="margin-left:auto">删除</button></div>`).join('');
  body.addEventListener('click', async (e) => {
    if (e.target.dataset.act === 'close') { closeModal(); return; }
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      try { await api.unsaveMessage(Number(del.dataset.del)); del.closest('.user-row')?.remove(); toast('已删除'); }
      catch (err) { toast(err.message); }
      return;
    }
    closeModal();
  });
}

/* ---- 自定义在线状态（Discord 式）---- */
// '' 与 'online' 后端等价，只保留 '' 一项，避免出现两个"在线"
const STATUS_LABEL = { '': '在线', idle: '离开', dnd: '忙碌', invisible: '隐身' };

function ensureMyStatus() {
  if (statusInited) return;
  statusInited = true;
  api.myStatus().then(res => { state.me.status = res.status || ''; renderStatusDot(); }).catch(() => {});
  // 5 分钟无操作 / 失去焦点自动转「离开」
  const away = debounce(() => {
    if (document.visibilityState !== 'visible' || !document.hasFocus()) maybeGoIdle();
  }, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', away);
  window.addEventListener('blur', away);
}

function maybeGoIdle() {
  if (state.me.status === '') {
    api.setMyStatus('idle').then(() => { state.me.status = 'idle'; renderStatusDot(); }).catch(() => {});
  }
}

function renderStatusDot() {
  const dot = $('#status-dot');
  if (!dot) return;
  dot.className = 'status-dot ' + (state.me.status || 'online');
  dot.title = STATUS_LABEL[state.me.status || ''];
}

function openStatusPicker() {
  const tips = { '': '正常在线', dnd: '屏蔽通知提醒', invisible: '对他人显示为离线', idle: '无操作 5 分钟后自动' };
  openModal(`
    <div class="modal-header">设置在线状态<button class="modal-close" data-act="close">✕</button></div>
    <div class="modal-body">
      ${Object.entries(STATUS_LABEL).map(([k, v]) => `
        <div class="user-row" data-status="${k}" style="cursor:pointer">
          <span class="status-dot ${k || 'online'}"></span>
          <div class="info"><div class="name">${v}</div><div class="sub">${tips[k] || ''}</div></div>
        </div>`).join('')}
    </div>`);
  $('#modal-box').addEventListener('click', async (e) => {
    if (e.target.dataset.act === 'close') { closeModal(); return; }
    const row = e.target.closest('[data-status]');
    if (!row) return;
    const st = row.dataset.status;
    try { await api.setMyStatus(st); } catch (err) { toast(err.message); return; }
    state.me.status = st;
    renderStatusDot();
    closeModal();
    toast('状态已更新');
  });
}

function updatePresenceSubtitle() {
  const conv = convOf(state.activeConvId);
  if (!conv || conv.convType !== 'single') return;
  const p = conv.peer;
  if (p.online) {
    const st = p.status;
    $('#chat-subtitle').textContent = st === 'idle' ? '离开'
      : st === 'dnd' ? '忙碌'
      : st === 'invisible' ? '离线' : '在线';
  } else {
    const seen = p.lastSeen || 0;
    $('#chat-subtitle').textContent = seen && (Date.now() - seen < 3 * 24 * 3600 * 1000)
      ? '最近活跃：' + formatTime(seen) : '离线';
  }
}

/** 拍一拍：自己的头像抖动 */
function schedulePatShake() {
  const av = $('#my-avatar');
  if (!av) return;
  av.classList.remove('pat-shake');
  void av.offsetWidth;
  av.classList.add('pat-shake');
  setTimeout(() => av.classList.remove('pat-shake'), 700);
}

/** 拍一拍：发送 */
function sendPat(conv, toUid) {
  if (!conv) return;
  state.socket.send({ type: 'pat', convId: conv.convId, to: toUid || null });
}

function buildMsgNodes(msgs) {
  const conv = convOf(state.activeConvId);
  const lastReadTs = conv?.lastReadTs || 0;
  const out = [];
  let lastTs = 0;
  let unreadDividerPlaced = false;
  for (const m of msgs) {
    if (m.createdAt - lastTs > 5 * 60 * 1000) {
      out.push(`<div class="msg-time">${formatTime(m.createdAt)}</div>`);
    }
    // 未读分界线（Discord/Slack 式）：第一条晚于上次已读时间的消息前插入
    if (!unreadDividerPlaced && lastReadTs && m.createdAt > lastReadTs
        && m.senderId !== state.me.id && m.kind !== 'system') {
      unreadDividerPlaced = true;
      out.push('<div class="msg-unread-line"><span>以下是新消息</span></div>');
    }
    lastTs = m.createdAt;
    out.push(msgRowHtml(m));
  }
  return out.join('');
}

function msgRowHtml(m) {
  if (m.kind === 'system') {
    if (m.isPat) {
      // 拍一拍：被拍对象在自己这里触发头像抖动
      if (m.patTo && m.patTo === state.me.id) schedulePatShake();
      return `<div class="msg-system msg-pat">${escapeHtml(m.content.text || '')}</div>`;
    }
    return `<div class="msg-system">${escapeHtml(m.content.text || '')}</div>`;
  }
  if (m.revoked) {
    const who = m.senderId === state.me.id ? '你' : (senderOf(m)?.nickname || '对方');
    return `<div class="msg-system"><span class="msg-recall">${escapeHtml(who)}撤回了一条消息</span></div>`;
  }
  const mine = m.senderId === state.me.id;
  const sender = senderOf(m);
  const atsMe = Array.isArray(m.ats) && m.ats.includes(state.me.id);

  const inner = m.kind === 'image'
    ? `<div class="bubble image"><img src="${m.content.url}" alt="图片"></div>`
    : m.kind === 'sticker'
    ? `<div class="bubble sticker"><img src="${m.content.url}" alt="表情"></div>`
    : m.kind === 'voice'
    ? voiceBubbleHtml(m)
    : m.kind === 'file'
    ? fileBubbleHtml(m)
    : `<div class="bubble text markdown">${renderMarkdown(m.content.text || '')}</div>`;

  // 引用回复卡片
  const replyHtml = m.replyTo
    ? `<div class="msg-reply" data-goto="${escapeHtml(m.replyTo)}">
         <span class="msg-reply-snip">${escapeHtml(m.replySnip || '引用的消息')}</span>
       </div>` : '';
  // 转发来源标记
  const fwdHtml = m.forwardFrom
    ? `<div class="msg-fwd">转发自：${escapeHtml(m.forwardFrom)}</div>` : '';
  // @我 标记
  const atMeHtml = atsMe ? '<span class="msg-at-me">@我</span>' : '';
  // 表情反应
  const reactHtml = reactionsHtml(m);

  const editedHtml = m.edited ? '<span class="msg-edited">已编辑</span>' : '';
  const statusHtml = (mine && m.convType === 'single') ? statusLabelOf(m) : '';
  const actionsHtml = msgActionsHtml(m);
  const nicknameHtml = (!mine && m.convType === 'group')
    ? `<div class="msg-nickname">${escapeHtml(sender.displayName || sender.nickname || '')}</div>` : '';
  return `<div class="msg-row ${mine ? 'mine' : ''} ${atsMe ? 'at-me' : ''}" data-msgid="${escapeHtml(m.msgId)}">
    ${avatarHtml(sender, 'small')}
    <div class="msg-body">${nicknameHtml}${fwdHtml}${replyHtml}${inner}${atMeHtml}${reactHtml}${editedHtml}${statusHtml}${actionsHtml}</div>
  </div>`;
}

function msgActionsHtml(m) {
  const mine = m.senderId === state.me.id;
  const acts = ['reply', 'react', 'save', 'copy'];
  if (m.kind === 'text' || m.kind === 'file') acts.push('forward');
  if (mine && (m.kind === 'text')) acts.push('edit');
  if (mine) acts.push('recall');
  const label = { reply: '回复', react: '回应', save: '收藏', copy: '复制', forward: '转发', edit: '编辑', recall: '撤回' };
  return `<div class="msg-actions">${acts.map(a =>
    `<button data-act="${a}" data-msgid="${escapeHtml(m.msgId)}">${label[a]}</button>`).join('')}</div>`;
}

function reactionsHtml(m) {
  const map = m.reactions;
  if (!map || typeof map !== 'object' || !Object.keys(map).length) return '';
  const mine = state.me.id;
  const items = Object.entries(map).map(([emoji, uids]) => {
    const on = Array.isArray(uids) && uids.includes(mine);
    return `<button class="reaction-chip ${on ? 'on' : ''}" data-react="${escapeHtml(emoji)}" data-msgid="${escapeHtml(m.msgId)}" title="${escapeHtml(uids.map(u => state.users.get(u)?.nickname || '').join('、'))}">${escapeHtml(emoji)}<span>${uids.length}</span></button>`;
  }).join('');
  return `<div class="msg-reactions">${items}</div>`;
}

function fileBubbleHtml(m) {
  const name = escapeHtml(m.content.name || '文件');
  const size = humanSize(m.content.size);
  const url = escapeHtml(m.content.url || '');
  const isImg = isImageFilename(m.content.name);
  return `<div class="bubble file">
    <a class="file-card" href="${url}" target="_blank" rel="noopener" download>
      <span class="file-ico">${isImg ? '🖼️' : '📄'}</span>
      <span class="file-meta"><span class="file-name">${name}</span><span class="file-size">${size} · 点击下载</span></span>
    </a>
  </div>`;
}
function voiceBubbleHtml(m) {
  const dur = m.content.duration || 1;
  const peaks = Array.isArray(m.content.peaks) && m.content.peaks.length
    ? m.content.peaks
    : new Array(20).fill(0.3);
  const bars = peaks
    .map(p => `<i style="height:${Math.max(4, Math.round(p * 26))}px"></i>`).join('');
  return `<div class="bubble voice" data-voice-url="${m.content.url}" data-duration="${dur}">
    <span class="voice-play">▶</span>
    <span class="voice-bars">${bars}</span>
    <span class="voice-dur">${dur}"</span>
  </div>`;
}

/* ---------------- 语音播放（单例 Audio） ---------------- */

let voiceAudio = null;
let voiceBubble = null;

function toggleVoice(bubble) {
  if (voiceBubble === bubble) { stopVoice(); return; }
  stopVoice();
  const audio = new Audio(bubble.dataset.voiceUrl);
  voiceAudio = audio;
  voiceBubble = bubble;
  bubble.classList.add('playing');
  const bars = bubble.querySelectorAll('.voice-bars i');
  const dur = Number(bubble.dataset.duration) || 1;
  audio.addEventListener('timeupdate', () => {
    const total = audio.duration || Number(bubble.dataset.duration) || 1;
    const pos = Math.min(bars.length - 1, Math.floor((audio.currentTime / total) * bars.length));
    bars.forEach((b, i) => b.classList.toggle('on', i <= pos));
  });
  audio.addEventListener('ended', stopVoice);
  audio.addEventListener('error', () => { toast('语音播放失败'); stopVoice(); });
  audio.play().catch(() => { toast('语音播放失败'); stopVoice(); });
}

function stopVoice() {
  if (voiceAudio) { voiceAudio.pause(); voiceAudio = null; }
  if (voiceBubble) {
    voiceBubble.classList.remove('playing');
    voiceBubble.querySelectorAll('.voice-bars i').forEach(b => b.classList.remove('on'));
    voiceBubble = null;
  }
}

function statusLabelOf(m) {
  if (m.status === 'sending') return '<div class="msg-status sending">发送中</div>';
  if (m.status === 'failed') return '<div class="msg-status" style="color:#fa5151">发送失败</div>';
  if (m.status === 'read') return '<div class="msg-status">已读</div>';
  if (m.status === 'delivered') return '<div class="msg-status">已送达</div>';
  if (m.status === 'sent') return '<div class="msg-status">已发送</div>';
  return '';
}

function renderMessages(preservePos = false, animateLast = false) {
  const list = $('#msg-list');
  const msgs = state.messages.get(state.activeConvId) || [];
  const beforeH = list.scrollHeight;
  const beforeTop = list.scrollTop;
  list.innerHTML = buildMsgNodes(msgs);
  if (animateLast) {
    const last = list.lastElementChild;
    if (last && last.classList.contains('msg-row')) last.classList.add('msg-in');
  }
  if (preservePos) {
    list.scrollTop = list.scrollHeight - beforeH + beforeTop;
  } else {
    list.scrollTop = list.scrollHeight;
  }
}

function autoResize(el) {
  el.style.height = 'auto';
  const maxH = inputMaxH();
  // 高度 = 内容高度与用户基准高度取大，整体不超过视口上限
  const h = Math.min(Math.max(el.scrollHeight, inputBaseH), maxH);
  el.style.height = h + 'px';
  // 触及上限才允许滚动，否则始终完整显示内容
  el.style.overflowY = el.scrollHeight > maxH ? 'auto' : 'hidden';
}

async function markActiveConvRead() {
  const convId = state.activeConvId;
  const conv = convOf(convId);
  if (!conv || !conv.unread) return;
  conv.unread = 0;
  renderConvList();
  updateTitleBadge();
  try { await api.markRead(convId); } catch (_) {}
}

/** 把消息加入本地状态、更新会话预览与排序 */
function pushMessage(msg, isNew) {
  state.msgMap.set(msg.msgId, msg);
  const conv = convOf(msg.convId);
  if (conv && isNew) {
    conv.lastMessage = msg;
    conv.lastTime = msg.createdAt;
    state.conversations = state.conversations.filter(c => c.convId !== msg.convId);
    state.conversations.unshift(conv);
  }
  let list = state.messages.get(msg.convId);
  if (!list && isConvActive(msg.convId)) {
    list = [];
    state.messages.set(msg.convId, list);
  }
  if (list) list.push(msg);
}

/* ---------------- 事件绑定 ---------------- */

function bindGlobalEvents() {
  $('#btn-profile').onclick = openProfileModal;
  $('#btn-requests').onclick = openRequestsModal;
  $('#btn-add-friend').onclick = openAddFriendModal;
  $('#btn-create-group').onclick = openCreateGroupModal;
  $('#btn-logout').onclick = () => { logout(); };
  $('#btn-saved')?.addEventListener('click', openSavedModal);
  $('#btn-status')?.addEventListener('click', openStatusPicker);
  $('#conv-search').addEventListener('input', () => renderConvList());
  $('#conv-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') openGlobalSearch(e.target.value.trim());
  });
  $('#conv-list').addEventListener('click', (e) => {
    const item = e.target.closest('.conv-item');
    if (item) openConv(item.dataset.convid);
  });
  // 会话项右键菜单：置顶 / 免打扰 / 拍一拍
  $('#conv-list').addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.conv-item');
    if (!item) return;
    e.preventDefault();
    openConvContextMenu(e, item.dataset.convid);
  });
  // 双击头像拍一拍
  $('#conv-list').addEventListener('dblclick', (e) => {
    const wrap = e.target.closest('[data-pat]');
    if (!wrap || !wrap.dataset.pat) return;
    const item = e.target.closest('.conv-item');
    if (!item) return;
    sendPat(convOf(item.dataset.convid), Number(wrap.dataset.pat));
  });
  $('#modal-mask').addEventListener('click', (e) => {
    if (e.target.id !== 'modal-mask') return;
    // 来电弹窗：点遮罩视为拒绝
    if (e.target.classList.contains('call-incoming')) {
      state.call?.reject('user_canceled');
      return;
    }
    closeModal();
  });
  // 全局点击关闭上下文菜单
  document.addEventListener('click', closeContextMenu);
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.conv-item, .msg-row')) closeContextMenu();
  });
}

/** 会话右键菜单（微信式：置顶 / 免打扰） */
function openConvContextMenu(e, convId) {
  const conv = convOf(convId);
  if (!conv) return;
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.style.left = Math.min(e.clientX, innerWidth - 180) + 'px';
  menu.style.top = Math.min(e.clientY, innerHeight - 200) + 'px';
  menu.innerHTML = `
    <button data-act="pin">${conv.pinned ? '取消置顶' : '置顶会话'}</button>
    <button data-act="mute">${conv.muted ? '关闭免打扰' : '消息免打扰'}</button>
    ${conv.convType === 'single' ? `<button data-act="pat">拍一拍</button>` : ''}
  `;
  document.body.appendChild(menu);
  ctxMenu = menu;
  menu.addEventListener('click', async (ev) => {
    const act = ev.target.dataset?.act;
    closeContextMenu();
    if (!act) return;
    if (act === 'pin' || act === 'mute') {
      const next = act === 'pin' ? { pinned: !conv.pinned } : { muted: !conv.muted };
      try {
        await api.convSettings(convId, next);
        Object.assign(conv, next);
        renderConvList();
        toast(act === 'pin' ? (next.pinned ? '已置顶' : '已取消置顶') : (next.muted ? '已开启免打扰' : '已关闭免打扰'));
      } catch (err) { toast(err.message); }
    } else if (act === 'pat') {
      sendPat(conv, conv.peer.id);
    }
  });
}

function closeContextMenu() {
  if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; }
}

function bindChatEvents() {
  const input = $('#msg-input');
  let typingEndTimer = null;
  const sendTyping = debounce(async (typing) => {
    if (!state.activeConvId) return;
    await state.socket.send({ type: 'typing', convId: state.activeConvId, typing });
  }, 400);

  input.addEventListener('input', () => {
    autoResize(input);
    if (!state.activeConvId) return;
    sendTyping(true);
    clearTimeout(typingEndTimer);
    typingEndTimer = setTimeout(() => sendTyping(false), 2000);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });
  $('#btn-send').onclick = () => sendMessage();

  $('#btn-image').onclick = () => $('#file-image').click();
  $('#file-image').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) sendImage(file);
  });

  $('#btn-emoji').onclick = (e) => {
    e.stopPropagation();
    const panel = $('#emoji-panel');
    panel.hidden = !panel.hidden;
    $('#sticker-panel').hidden = true;
    if (!panel.hidden && !panel.dataset.built) {
      panel.innerHTML = EMOJIS.map(emo =>
        `<button type="button" data-emoji="${emo}">${emo}</button>`).join('');
      panel.dataset.built = '1';
    }
  };

  $('#btn-sticker').onclick = async (e) => {
    e.stopPropagation();
    const panel = $('#sticker-panel');
    $('#emoji-panel').hidden = true;
    if (panel.hidden) {
      panel.hidden = false;
      if (!panel.dataset.built) {
        panel.innerHTML = '<div class="no-data" style="grid-column:1/-1">加载中...</div>';
        try {
          const res = await fetch('/stickers/index.json');
          const list = await res.json();
          panel.innerHTML = list.map(s =>
            `<button type="button" data-sticker="${s.file}" title="${escapeHtml(s.label)}">
               <img src="/stickers/${s.file}" alt="${escapeHtml(s.label)}"></button>`).join('');
          panel.dataset.built = '1';
        } catch (_) {
          panel.innerHTML = '<div class="no-data" style="grid-column:1/-1">表情包加载失败</div>';
        }
      }
    } else {
      panel.hidden = true;
    }
  };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#emoji-panel') && !e.target.closest('#btn-emoji')) {
      $('#emoji-panel').hidden = true;
    }
    if (!e.target.closest('#sticker-panel') && !e.target.closest('#btn-sticker')) {
      $('#sticker-panel').hidden = true;
    }
  });
  $('#emoji-panel').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-emoji]');
    if (!btn) return;
    input.value += btn.dataset.emoji;
    input.focus();
    autoResize(input);
  });
  $('#sticker-panel').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-sticker]');
    if (!btn) return;
    sendSticker('/stickers/' + btn.dataset.sticker);
  });

  /* ---- 语音：按住说话 ---- */
  bindVoiceRecorder();

  /* ---- 音视频通话 ---- */
  $('#btn-call-voice').onclick = () => startCallFromConv('audio');
  $('#btn-call-video').onclick = () => startCallFromConv('video');
  $('#call-hangup').onclick = () => state.call?.end('hangup');
  $('#call-mute').onclick = () => {
    const on = state.call?.toggleMute();
    $('#call-mute').classList.toggle('off', !on);
  };
  $('#call-camera').onclick = () => {
    const on = state.call?.toggleCamera();
    $('#call-camera').classList.toggle('off', !on);
  };
  $('#call-switch').onclick = () => state.call?.switchCamera();

  $('#btn-back').onclick = () => document.body.classList.add('show-sidebar');
  $('#btn-info').onclick = openConvInfoModal;

  $('#msg-list').addEventListener('scroll', debounce(() => {
    const el = $('#msg-list');
    if (el.scrollTop < 60 && !state.loadingMore && state.hasMore.get(state.activeConvId)) {
      loadOlder();
    }
  }, 250));

  $('#msg-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (btn) { handleMsgAction(btn.dataset.act, btn.dataset.msgid); return; }
    const img = e.target.closest('.bubble.image img, .bubble.sticker img');
    if (img) window.open(img.src, '_blank');
    const vb = e.target.closest('.bubble.voice');
    if (vb) toggleVoice(vb);
  });

  $('#btn-search-history').onclick = () => {
    $('#search-panel').hidden = false;
    $('#history-search-input').value = '';
    $('#search-results').innerHTML = '<div class="search-empty">输入关键词后回车搜索</div>';
    $('#history-search-input').focus();
  };
  $('#btn-close-search').onclick = () => { $('#search-panel').hidden = true; };
  $('#history-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchHistory(e.target.value.trim());
  });

  /* ---- 文件发送：按钮 + Ctrl+V 粘贴 + 拖拽 ---- */
  $('#btn-file')?.addEventListener('click', () => $('#file-any').click());
  $('#file-any')?.addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) sendFile(f);
  });
  input.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items || [];
    for (const it of items) {
      const f = it.getAsFile?.();
      if (!f) continue;
      e.preventDefault();
      if (it.type.startsWith('image/')) sendImage(f);
      else sendFile(f);
      return;
    }
  });
  const msgList = $('#msg-list');
  ['dragenter', 'dragover'].forEach(t => msgList.addEventListener(t, (e) => {
    e.preventDefault();
    msgList.classList.add('dragging');
  }));
  ['dragleave', 'drop'].forEach(t => msgList.addEventListener(t, (e) => {
    e.preventDefault();
    msgList.classList.remove('dragging');
  }));
  msgList.addEventListener('drop', (e) => {
    const files = e.dataTransfer?.files;
    if (!files || !files.length) return;
    for (const f of files) {
      if (f.type.startsWith('image/')) sendImage(f);
      else sendFile(f);
    }
  });

  /* ---- 引用卡片点击：跳转到被引用消息 ---- */
  msgList.addEventListener('click', (e) => {
    const r = e.target.closest('.msg-reply');
    if (!r || !r.dataset.goto) return;
    const target = r.dataset.goto;
    const list = state.messages.get(state.activeConvId) || [];
    const idx = list.findIndex(x => x.msgId === target);
    if (idx < 0) { toast('该消息不在当前已加载范围'); return; }
    const nodes = msgList.querySelectorAll('.msg-row');
    const node = nodes[idx];
    if (node) {
      node.scrollIntoView({ block: 'center', behavior: 'smooth' });
      node.classList.remove('flash');
      void node.offsetWidth;
      node.classList.add('flash');
      setTimeout(() => node.classList.remove('flash'), 1600);
    }
  });

  /* ---- 表情反应 chip 点击 ---- */
  msgList.addEventListener('click', (e) => {
    const chip = e.target.closest('.reaction-chip');
    if (!chip) return;
    const m = state.msgMap.get(chip.dataset.msgid);
    if (!m) return;
    const emoji = chip.dataset.react;
    const on = !m.reactions?.[emoji]?.includes(state.me.id);
    state.socket.send({ type: 'react', msgId: m.msgId, emoji, on });
  });

  $('#reply-cancel')?.addEventListener('click', clearReplyDraft);
  $('#forward-cancel')?.addEventListener('click', clearForwardDraft);
}
/* ---------------- 实时事件 ---------------- */

function handleSocketMessage(obj) {
  if (!obj || typeof obj !== 'object') return;
  switch (obj.type) {
    case 'connected': break;
    case 'message': onIncomingMessage(obj.msg); break;
    case 'ack': onAck(obj); break;
    case 'status': onStatus(obj); break;
    case 'read': onRead(obj); break;
    case 'typing': onTyping(obj); break;
    case 'presence': onPresence(obj); break;
    case 'react': onReact(obj); break;
    case 'edit': onEditMessage(obj); break;
    case 'group_announcement': onGroupAnnouncement(obj); break;
    case 'recall': onRecall(obj); break;
    case 'friend_request': onFriendRequest(obj); break;
    case 'friend_accepted': onFriendAccepted(obj); break;
    case 'group_invited': onGroupInvited(obj); break;
    case 'group_left': onGroupEvent(obj); break;
    case 'group_event': onGroupEvent(obj); break;
    case 'group_dismissed': onGroupDismissed(obj); break;
    case 'call_offer': state.call?.onIncoming(obj); break;
    case 'call_answer': state.call?.onAnswer(obj); break;
    case 'call_ice': state.call?.onIce(obj); break;
    case 'call_reject': state.call?.onReject(obj); break;
    case 'call_busy': state.call?.onBusy(obj); break;
    case 'call_end': state.call?.onEnd(obj); break;
    case 'call_failed': state.call?.onFailed(obj); break;
    default: break;
  }
}

async function onIncomingMessage(msg) {
  const convId = msg.convId;
  if (!convOf(convId)) {
    await loadConversations();
    if (!convOf(convId)) return;
  }
  cacheUsers([msg.senderId]);
  const list = state.messages.get(convId);
  pushMessage(msg, true);
  if (list && isConvActive(convId)) renderMessages(false, true);

  if (isConvActive(convId)) {
    markActiveConvRead();          // 当前会话直接已读
  } else {
    const conv = convOf(convId);
    conv.unread = (conv.unread || 0) + 1;
  }
  renderConvList();
  updateTitleBadge();
}

function onAck(obj) {
  const m = state.msgMap.get(obj.msgId);
  if (!m) return;
  m.id = obj.serverId;
  m.status = obj.delivered ? 'delivered' : 'sent';
  if (isConvActive(m.convId)) renderMessages(false);
}

function onStatus(obj) {
  const m = state.msgMap.get(obj.msgId);
  if (!m || !obj.status) return;
  m.status = obj.status;
  if (isConvActive(m.convId)) renderMessages(false);
}

function onRead(obj) {
  const list = state.messages.get(obj.convId) || [];
  let changed = false;
  for (const m of list) {
    if (m.senderId === state.me.id && !m.revoked && m.status !== 'read') {
      m.status = 'read';
      changed = true;
    }
  }
  if (changed && isConvActive(obj.convId)) renderMessages(false);
}

function onTyping(obj) {
  if (!isConvActive(obj.convId)) return;
  if (obj.typing) {
    const who = obj.convId.startsWith('u_')
      ? '对方'
      : (state.users.get(obj.from)?.nickname || '群成员');
    $('#typing-hint').textContent = `${who} 正在输入...`;
    $('#typing-hint').hidden = false;
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => { $('#typing-hint').hidden = true; }, 3000);
  } else {
    $('#typing-hint').hidden = true;
  }
}

function onPresence(obj) {
  const conv = state.conversations.find(c => c.convType === 'single' && c.peer.id === obj.userId);
  if (!conv) return;
  conv.peer.online = !!obj.online;
  conv.peer.status = obj.status || (obj.online ? 'online' : 'offline');
  renderConvList();
  if (isConvActive(conv.convId)) updatePresenceSubtitle();
}

function onReact(obj) {
  const m = state.msgMap.get(obj.msgId);
  if (!m) return;
  m.reactions = obj.reactions || null;
  if (isConvActive(m.convId)) renderMessages(true);
}

function onEditMessage(obj) {
  const m = state.msgMap.get(obj.msgId);
  if (!m) return;
  if (m.content) m.content.text = obj.text;
  m.edited = 1;
  m.editedAt = obj.editedAt;
  const conv = convOf(m.convId);
  if (conv && conv.lastMessage?.msgId === m.msgId) conv.lastMessage = { ...m };
  if (isConvActive(m.convId)) renderMessages(true);
}

function onGroupAnnouncement(obj) {
  const conv = convOf('g_' + obj.groupId);
  if (conv) {
    conv.groupDetail ||= {};
    conv.groupDetail.announcement = obj.announcement;
  }
}

function onRecall(obj) {
  const m = state.msgMap.get(obj.msgId);
  if (!m) return;
  m.revoked = true;
  if (isConvActive(m.convId)) renderMessages(false);
}

async function onFriendRequest(obj) {
  await refreshRequestsBadge();
  toast(`${obj.request.from.nickname} 请求添加你为好友`);
}

async function onFriendAccepted(obj) {
  toast(`${obj.friend.nickname} 已通过你的好友请求`);
  await loadConversations();
  await loadFriends();
}

async function onGroupInvited(obj) {
  toast(`你被邀请加入群聊「${obj.groupName}」`);
  await loadConversations();
}

function onGroupEvent(obj) {
  if (obj.message) toast(obj.message.content?.text || '群成员发生变动');
  loadConversations().then(() => {
    const convId = 'g_' + obj.groupId;
    const conv = convOf(convId);
    if (conv && isConvActive(convId)) {
      conv.members = null;       // 触发重新拉取成员
      renderChatHeader(conv);
    }
  });
}

function onGroupDismissed(obj) {
  const convId = 'g_' + obj.groupId;
  toast(`群聊「${obj.groupName}」已解散`);
  state.conversations = state.conversations.filter(c => c.convId !== convId);
  state.messages.delete(convId);
  if (state.activeConvId === convId) {
    state.activeConvId = null;
    $('#chat-main').hidden = true;
    $('#chat-empty').hidden = false;
  }
  renderConvList();
  updateTitleBadge();
}
/* ---------------- 发送动作 ---------------- */

async function sendMessage() {
  const input = $('#msg-input');
  const text = input.value.trim();
  if (!text || !state.activeConvId) return;
  const conv = convOf(state.activeConvId);
  if (!conv) return;

  const msgId = 'c_' + crypto.randomUUID();
  // @提及：解析文本中的 @昵称
  const ats = parseAts(text, conv);
  const reply = state.replyDraft;
  const fwd = state.forwardDraft;
  const base = {
    id: null, msgId, convType: conv.convType, convId: conv.convId,
    senderId: state.me.id,
    to: conv.convType === 'single' ? conv.peer.id : null,
    groupId: conv.convType === 'group' ? conv.group.id : null,
    kind: 'text', content: { text }, createdAt: Date.now(), revoked: false, status: 'sending',
  };
  if (ats.length) base.ats = ats;
  if (reply) { base.replyTo = reply.msgId; base.replySnip = reply.snip; }
  if (fwd) base.forwardFrom = fwd;
  const msg = base;

  input.value = '';
  autoResize(input);
  clearReplyDraft();
  clearForwardDraft();
  pushMessage(msg, true);
  renderMessages(false, true);

  const out = { msgId, convType: msg.convType, to: msg.to, groupId: msg.groupId, kind: 'text', content: { text } };
  if (ats.length) out.ats = ats;
  if (reply) { out.replyTo = reply.msgId; out.replySnip = reply.snip; }
  if (fwd) out.forwardFrom = fwd;

  const ok = await state.socket.send({ type: 'chat', msg: out });
  if (!ok) {
    msg.status = 'failed';
    toast('发送失败：连接已断开，正在重连');
    renderMessages(false);
  }
}

/** 从文本中解析 @ 昵称（群聊内启用） */
function parseAts(text, conv) {
  if (conv.convType !== 'group' || !conv.members) return [];
  const ats = [];
  for (const m of conv.members) {
    const name = m.displayName || m.nickname;
    if (name && text.includes('@' + name)) ats.push(m.id);
  }
  return [...new Set(ats)];
}

function setReplyDraft(m) {
  const who = m.senderId === state.me.id ? '我' : (senderOf(m)?.displayName || senderOf(m)?.nickname || '对方');
  const snip = (who + '：' + (m.content?.text || previewText(m))).slice(0, 80);
  state.replyDraft = { msgId: m.msgId, snip };
  renderReplyBar();
  $('#msg-input').focus();
}
function clearReplyDraft() {
  state.replyDraft = null;
  renderReplyBar();
}
function renderReplyBar() {
  const bar = $('#reply-bar');
  if (!bar) return;
  const r = state.replyDraft;
  bar.hidden = !r;
  if (r) bar.querySelector('.reply-snip').textContent = r.snip;
}
function clearForwardDraft() {
  state.forwardDraft = null;
  const bar = $('#forward-bar');
  if (bar) bar.hidden = true;
}

async function sendImage(file) {
  if (!state.activeConvId) return;
  if (file.size > 10 * 1024 * 1024) { toast('图片不能超过 10MB'); return; }
  const conv = convOf(state.activeConvId);
  if (!conv) return;

  toast('图片上传中...', 1500);
  let url;
  try {
    const base64 = await fileToBase64(file);
    const res = await api.upload(base64, file.name);
    url = res.url;
  } catch (e) {
    toast('上传失败：' + e.message);
    return;
  }

  const msgId = 'c_' + crypto.randomUUID();
  const msg = {
    id: null, msgId, convType: conv.convType, convId: conv.convId,
    senderId: state.me.id,
    to: conv.convType === 'single' ? conv.peer.id : null,
    groupId: conv.convType === 'group' ? conv.group.id : null,
    kind: 'image', content: { url }, createdAt: Date.now(), revoked: false, status: 'sending',
  };
  pushMessage(msg, true);
  if (isConvActive(conv.convId)) renderMessages(false, true);

  const ok = await state.socket.send({
    type: 'chat',
    msg: { msgId, convType: msg.convType, to: msg.to, groupId: msg.groupId, kind: 'image', content: { url } },
  });
  if (!ok) { msg.status = 'failed'; toast('发送失败'); renderMessages(false); }
}

/** 发送任意文件（QQ/微信式：支持拖拽与选择） */
async function sendFile(file) {
  if (!state.activeConvId || !file) return;
  if (file.size > 50 * 1024 * 1024) { toast('文件不能超过 50MB'); return; }
  const conv = convOf(state.activeConvId);
  if (!conv) return;
  toast('文件上传中...', 2000);
  let url;
  try {
    const base64 = await fileToBase64(file);
    const res = await api.upload(base64, file.name);
    url = res.url;
  } catch (e) {
    toast('上传失败：' + e.message);
    return;
  }
  const msgId = 'c_' + crypto.randomUUID();
  const content = { url, name: file.name, size: file.size };
  const reply = state.replyDraft;
  const msg = {
    id: null, msgId, convType: conv.convType, convId: conv.convId, senderId: state.me.id,
    to: conv.convType === 'single' ? conv.peer.id : null,
    groupId: conv.convType === 'group' ? conv.group.id : null,
    kind: 'file', content, createdAt: Date.now(), revoked: false, status: 'sending',
  };
  if (reply) { msg.replyTo = reply.msgId; msg.replySnip = reply.snip; }
  clearReplyDraft();
  pushMessage(msg, true);
  if (isConvActive(conv.convId)) renderMessages(false, true);
  const out = { msgId, convType: msg.convType, to: msg.to, groupId: msg.groupId, kind: 'file', content };
  if (reply) { out.replyTo = reply.msgId; out.replySnip = reply.snip; }
  const ok = await state.socket.send({ type: 'chat', msg: out });
  if (!ok) { msg.status = 'failed'; toast('发送失败'); renderMessages(false); }
}

/* ---------------- 表情包 / 语音 ---------------- */

async function sendSticker(url) {
  if (!state.activeConvId) return;
  const conv = convOf(state.activeConvId);
  if (!conv) return;
  const msgId = 'c_' + crypto.randomUUID();
  const content = { url };
  const msg = {
    id: null, msgId, convType: conv.convType, convId: conv.convId, senderId: state.me.id,
    to: conv.convType === 'single' ? conv.peer.id : null,
    groupId: conv.convType === 'group' ? conv.group.id : null,
    kind: 'sticker', content, createdAt: Date.now(), revoked: false, status: 'sending',
  };
  $('#sticker-panel').hidden = true;
  pushMessage(msg, true);
  if (isConvActive(conv.convId)) renderMessages(false, true);
  const ok = await state.socket.send({
    type: 'chat',
    msg: { msgId, convType: msg.convType, to: msg.to, groupId: msg.groupId, kind: 'sticker', content },
  });
  if (!ok) { msg.status = 'failed'; toast('发送失败'); renderMessages(false); }
}

async function sendVoice(blob, duration, peaks) {
  if (!state.activeConvId) return;
  if (duration < 0.8) { toast('说话时间太短，未发送'); return; }
  const conv = convOf(state.activeConvId);
  if (!conv) return;
  const secs = Math.max(1, Math.round(duration));
  toast('语音上传中...', 1500);
  let url;
  try {
    const base64 = await blobToBase64(blob);
    const res = await api.upload(base64, `voice_${Date.now()}.${voiceExt(blob.type)}`);
    url = res.url;
  } catch (e) {
    toast('语音上传失败：' + e.message);
    return;
  }
  const msgId = 'c_' + crypto.randomUUID();
  const content = { url, duration: secs, peaks };
  const msg = {
    id: null, msgId, convType: conv.convType, convId: conv.convId, senderId: state.me.id,
    to: conv.convType === 'single' ? conv.peer.id : null,
    groupId: conv.convType === 'group' ? conv.group.id : null,
    kind: 'voice', content, createdAt: Date.now(), revoked: false, status: 'sending',
  };
  pushMessage(msg, true);
  if (isConvActive(conv.convId)) renderMessages(false, true);
  const ok = await state.socket.send({
    type: 'chat',
    msg: { msgId, convType: msg.convType, to: msg.to, groupId: msg.groupId, kind: 'voice', content },
  });
  if (!ok) { msg.status = 'failed'; toast('发送失败'); renderMessages(false); }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/** 按 MediaRecorder 实际编码推断扩展名（Safari 产出 mp4，Chrome/Firefox 产出 webm/ogg） */
function voiceExt(mimeType) {
  const t = (mimeType || '').toLowerCase();
  if (t.includes('mp4') || t.includes('aac')) return 'm4a';
  if (t.includes('ogg') || t.includes('opus')) return 'ogg';
  if (t.includes('wav')) return 'wav';
  return 'webm';
}

/** 按住说话：pointer 事件驱动，上滑取消 */
function bindVoiceRecorder() {
  const btn = $('#btn-voice');
  const rec = $('#voice-recording');
  const timeEl = $('#vr-time');
  const tipEl = $('#vr-tip');
  const recorder = new VoiceRecorder();
  state.recorder = recorder;
  let startY = 0;
  let cancelling = false;

  btn.addEventListener('pointerdown', async (e) => {
    if (state.call?.busy) { toast('通话中无法录音'); return; }
    e.preventDefault();
    startY = e.clientY;
    cancelling = false;
    rec.classList.remove('cancel');
    tipEl.textContent = '松开发送 · 上滑取消';
    try {
      await recorder.start();
      rec.hidden = false;
      recorder.onTick = (ms) => { timeEl.textContent = Math.round(ms / 1000) + '"'; };
    } catch (err) {
      toast('无法录音：' + (err.message || '麦克风不可用'));
    }
  });

  btn.addEventListener('pointermove', (e) => {
    if (!recorder.recording) return;
    cancelling = e.clientY < startY - 40;
    rec.classList.toggle('cancel', cancelling);
    tipEl.textContent = cancelling ? '松开手指，取消发送' : '松开发送 · 上滑取消';
  });

  const finish = async (cancel) => {
    if (!recorder.recording) return;
    rec.hidden = true;
    const result = await recorder.stop(cancel);
    if (cancel || !result) return;
    sendVoice(result.blob, result.duration, result.peaks);
  };
  btn.addEventListener('pointerup', () => finish(cancelling));
  btn.addEventListener('pointerleave', () => finish(true));   // 手指离开按钮 = 取消
  btn.addEventListener('pointercancel', () => finish(true));
}

/* ---------------- 通话 UI ---------------- */

function startCallFromConv(media) {
  const conv = convOf(state.activeConvId);
  if (!conv || conv.convType !== 'single') { toast('目前仅支持好友间 1 对 1 通话'); return; }
  if (!conv.peer.online) { toast('对方不在线'); return; }
  state.call?.start(conv.peer.id, media);
}

function handleCallEvent(evt) {
  switch (evt.kind) {
    case 'outgoing': showCallWindow(evt.media, evt.peerId, '正在呼叫...'); break;
    case 'connecting':
      showCallWindow(state.call?.media, state.call?.peerId, '正在建立连接...');
      break;
    case 'connected':
      $('#call-status').textContent = '通话中';
      $('#call-timer').hidden = false;
      $('#call-timer').textContent = '00:00';
      break;
    case 'iceState':
      if (evt.state === 'disconnected') $('#call-status').textContent = '网络不佳，尝试重连中...';
      else if (evt.state === 'failed') $('#call-status').textContent = '连接失败，请挂断重试';
      else if (evt.state === 'completed' && $('#call-status').textContent.includes('网络')) $('#call-status').textContent = '通话中';
      break;
    case 'tick': $('#call-timer').textContent = fmtCallDur(evt.secs); break;
    case 'remote-stream': $('#call-remote').srcObject = evt.stream; break;
    case 'local-stream': $('#call-local').srcObject = evt.stream; break;
    case 'incoming': showIncomingCall(evt); break;
    case 'busy': hideCallWindow(); toast('对方正忙，请稍后再试'); break;
    case 'rejected': hideCallWindow(); toast('对方已拒绝'); break;
    case 'ended':
      hideCallWindow();
      closeIncomingCall();
      if (evt.reason === 'no_answer') toast('对方无应答');
      else if (evt.reason === 'network_error') toast('网络异常，通话已结束');
      else if (evt.reason === 'timeout') toast('超时未接听');
      break;
    case 'error': hideCallWindow(); toast(evt.message || '通话出错'); break;
    case 'reset': hideCallWindow(); break;
    case 'log':
      // 只由主叫方记录流水，避免双方各记一条
      if (evt.role === 'caller') logCall(evt);
      break;
    default: break;
  }
}

function logCall(evt) {
  const conv = state.conversations.find((c) => c.convType === 'single' && c.peer.id === evt.peerId);
  if (!conv) return;
  const label = evt.media === 'video' ? '视频通话' : '语音通话';
  const text = evt.connected ? `${label} ${fmtCallDur(evt.durationSec)}` : `${label}未接听`;
  state.socket?.send({ type: 'call_log', to: evt.peerId, text });
}

function fmtCallDur(secs) {
  const m = String(Math.floor(secs / 60)).padStart(2, '0');
  const s = String(secs % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function showCallWindow(media, peerId, status) {
  const peer = state.users.get(peerId) || { nickname: '用户' + peerId };
  const win = $('#call-window');
  win.classList.toggle('audio', media === 'audio');
  $('#call-peer-name').textContent = peer.remark || peer.nickname;
  $('#call-status').textContent = status || '正在呼叫...';
  $('#call-timer').hidden = true;
  $('#call-camera').hidden = media !== 'video';
  $('#call-switch').hidden = media !== 'video';
  $('#call-avatar').outerHTML = avatarHtml(peer).replace('class="avatar', 'id="call-avatar" class="avatar');
  win.hidden = false;
}

function hideCallWindow() {
  const win = $('#call-window');
  if (win.hidden) return;
  win.hidden = true;
  $('#call-remote').srcObject = null;
  $('#call-local').srcObject = null;
  $('#call-timer').hidden = true;
  $('#call-mute').classList.remove('off');
  $('#call-camera').classList.remove('off');
}

function showIncomingCall(evt) {
  const peer = state.users.get(evt.peerId) || { nickname: '用户' + evt.peerId };
  $('#modal-mask').classList.add('call-incoming');
  openModal(`
    ${avatarHtml(peer)}
    <h3>${escapeHtml(peer.remark || peer.nickname)}</h3>
    <p>邀请你进行${evt.media === 'video' ? '视频' : '语音'}通话...</p>
    <div class="row">
      <button class="ci-btn deny" id="ci-deny" title="拒绝">📞</button>
      <button class="ci-btn accept" id="ci-accept" title="接听">🎤</button>
    </div>`);
  $('#ci-deny').onclick = () => state.call?.reject('user_canceled');
  $('#ci-accept').onclick = () => { closeIncomingCall(); state.call?.accept(); };
}

function closeIncomingCall() {
  const mask = $('#modal-mask');
  if (mask.classList.contains('call-incoming')) {
    mask.classList.remove('call-incoming');
    closeModal();
  }
}

function handleMsgAction(act, msgId) {
  const m = state.msgMap.get(msgId);
  if (!m) return;
  if (act === 'reply') {
    setReplyDraft(m);
  } else if (act === 'copy') {
    const text = m.content?.text || '';
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(() => {});
    toast('已复制');
  } else if (act === 'recall') {
    if (Date.now() - m.createdAt > 2 * 60 * 1000) {
      toast('发送超过 2 分钟的消息不能撤回');
      return;
    }
    state.socket.send({ type: 'recall', msgId });
  } else if (act === 'react') {
    openReactPicker(m);
  } else if (act === 'save') {
    saveMessageToFavorites(m);
  } else if (act === 'forward') {
    openForwardPicker(m);
  } else if (act === 'edit') {
    openEditModal(m);
  }
}

/** 表情回应选择器 */
function openReactPicker(m) {
  const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🎉'];
  const existed = Object.keys(m.reactions || {});
  const all = [...new Set([...QUICK, ...existed])].slice(0, 12);
  openModal(`
    <div class="modal-header">回应消息<button class="modal-close" data-act="close">✕</button></div>
    <div class="modal-body">
      <div class="react-picker">
        ${all.map(e => {
          const on = m.reactions?.[e]?.includes(state.me.id);
          return `<button class="react-pick ${on ? 'on' : ''}" data-emoji="${e}">${e}</button>`;
        }).join('')}
      </div>
    </div>`);
  $('#modal-box').addEventListener('click', (e) => {
    if (e.target.dataset.act === 'close') { closeModal(); return; }
    const btn = e.target.closest('.react-pick');
    if (!btn) return;
    const emoji = btn.dataset.emoji;
    const on = !m.reactions?.[emoji]?.includes(state.me.id);
    state.socket.send({ type: 'react', msgId: m.msgId, emoji, on });
    closeModal();
  });
}

/** 收藏到「我的收藏」 */
async function saveMessageToFavorites(m) {
  try {
    await api.saveMessage({
      msgId: m.msgId, convType: m.convType, kind: m.kind, content: m.content,
      senderId: m.senderId, createdAt: m.createdAt, snip: previewText(m),
    });
    toast('已收藏');
  } catch (e) { toast('收藏失败：' + e.message); }
}

/** 转发：选择目标会话 */
function openForwardPicker(m) {
  const convs = state.conversations;
  openModal(`
    <div class="modal-header">转发消息<button class="modal-close" data-act="close">✕</button></div>
    <div class="modal-body">
      <div style="font-size:12px;color:#999;margin-bottom:10px">转发内容：${escapeHtml(previewText(m)).slice(0, 60)}</div>
      <div style="max-height:300px;overflow-y:auto">
        ${convs.length ? convs.map(c => {
          const name = c.convType === 'single' ? (c.peer.remark || c.peer.nickname) : c.group.name;
          return `<div class="user-row" data-fwdconv="${c.convId}" style="cursor:pointer">
            ${avatarHtml(c.convType === 'single' ? c.peer : { nickname: c.group.name, avatar: c.group.avatar })}
            <div class="info"><div class="name">${escapeHtml(name)}</div>
            <div class="sub">${c.convType === 'single' ? '单聊' : '群聊'}</div></div>
          </div>`;
        }).join('') : '<div class="no-data">暂无会话</div>'}
      </div>
    </div>`);
  $('#modal-box').addEventListener('click', async (e) => {
    if (e.target.dataset.act === 'close') { closeModal(); return; }
    const row = e.target.closest('[data-fwdconv]');
    if (!row) return;
    const target = convOf(row.dataset.fwdconv);
    closeModal();
    if (!target) return;
    const who = m.senderId === state.me.id ? '我' : (senderOf(m)?.nickname || '对方');
    await forwardMessageTo(m, target, who);
  });
}

async function forwardMessageTo(m, target, fromWho) {
  const msgId = 'c_' + crypto.randomUUID();
  const content = { ...(m.content || {}) };
  const out = {
    msgId, convType: target.convType,
    to: target.convType === 'single' ? target.peer.id : null,
    groupId: target.convType === 'group' ? target.group.id : null,
    kind: m.kind === 'system' ? 'text' : m.kind, content,
    forwardFrom: fromWho,
  };
  const ok = await state.socket.send({ type: 'chat', msg: out });
  if (ok) toast('已转发');
  else toast('转发失败');
}

/** 编辑消息（限本人 24 小时内的文本） */
function openEditModal(m) {
  if (m.senderId !== state.me.id) { toast('只能编辑自己的消息'); return; }
  if (Date.now() - m.createdAt > 24 * 3600 * 1000) { toast('超过 24 小时的消息不能编辑'); return; }
  openModal(`
    <div class="modal-header">编辑消息<button class="modal-close" data-act="close">✕</button></div>
    <div class="modal-body">
      <textarea class="modal-input" id="edit-text" style="height:90px;padding-top:10px">${escapeHtml(m.content.text || '')}</textarea>
      <div class="modal-btn-row">
        <button class="modal-btn ghost" data-act="close">取消</button>
        <button class="modal-btn" id="btn-do-edit">保存</button>
      </div>
    </div>`);
  $('#modal-box').addEventListener('click', (e) => {
    if (e.target.dataset.act === 'close') closeModal();
  });
  $('#btn-do-edit').onclick = () => {
    const text = $('#edit-text').value.trim();
    if (!text) { toast('内容不能为空'); return; }
    state.socket.send({ type: 'edit', msgId: m.msgId, text });
    closeModal();
  };
}

async function loadOlder() {
  const convId = state.activeConvId;
  const list = state.messages.get(convId) || [];
  const first = list.find(m => m.id);
  if (!convId || !first) return;
  state.loadingMore = true;
  try {
    const data = await api.messages(convId, first.id);
    state.messages.set(convId, [...data.messages, ...list]);
    state.hasMore.set(convId, data.hasMore);
    renderMessages(true);
  } catch (e) {
    toast('加载更多失败：' + e.message);
  } finally {
    state.loadingMore = false;
  }
}

async function searchHistory(q) {
  const convId = state.activeConvId;
  if (!convId || !q) return;
  const box = $('#search-results');
  box.innerHTML = '<div class="search-empty">搜索中...</div>';
  try {
    const { results } = await api.searchHistory(convId, q);
    if (!results.length) {
      box.innerHTML = '<div class="search-empty">没有找到相关聊天记录</div>';
      return;
    }
    box.innerHTML = results.map(m => `
      <div class="search-result-item" data-msgid="${m.msgId}">
        <div>${escapeHtml(previewText(m))}</div>
        <div class="time">${escapeHtml(m.senderId === state.me.id ? '我' : (senderOf(m)?.nickname || ''))} · ${formatTime(m.createdAt)}</div>
      </div>`).join('');
  } catch (e) {
    box.innerHTML = `<div class="search-empty">搜索失败：${escapeHtml(e.message)}</div>`;
  }
}

$('#search-results').addEventListener('click', (e) => {
  const item = e.target.closest('.search-result-item');
  if (!item) return;
  $('#search-panel').hidden = true;
  const el = $(`#msg-list [data-msgid="${item.dataset.msgid}"]`);
  if (el) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.style.transition = 'background .4s';
    el.style.background = '#fdf3c8';
    setTimeout(() => { el.style.background = ''; }, 1600);
  } else {
    toast('该消息不在当前已加载范围内，可上拉加载更多历史');
  }
});
/* ---------------- 弹窗：个人资料 / 添加好友 ---------------- */

function openProfileModal() {
  const me = state.me;
  openModal(`
    <div class="modal-header">个人资料<button class="modal-close" data-act="close">✕</button></div>
    <div class="modal-body">
      <div style="display:flex;gap:14px;align-items:center;margin-bottom:16px">
        <div id="profile-avatar-preview">${avatarHtml(me, 'large')}</div>
        <button class="modal-btn ghost" id="btn-change-avatar" style="height:36px">更换头像</button>
        <input type="file" id="file-avatar" accept="image/*" hidden>
      </div>
      <input class="modal-input" id="profile-nickname" value="${escapeHtml(me.nickname)}" placeholder="昵称">
      <input class="modal-input" id="profile-signature" value="${escapeHtml(me.signature || '')}" placeholder="个性签名">
      <div class="modal-btn-row">
        <button class="modal-btn ghost" data-act="close">取消</button>
        <button class="modal-btn" id="btn-save-profile">保存</button>
      </div>
    </div>`);

  let newAvatar = null;
  $('#modal-box').addEventListener('click', (e) => {
    if (e.target.dataset.act === 'close') closeModal();
  });
  $('#btn-change-avatar').onclick = () => $('#file-avatar').click();
  $('#file-avatar').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast('头像不能超过 5MB'); return; }
    try {
      const base64 = await fileToBase64(file);
      const res = await api.upload(base64, file.name);
      newAvatar = res.url;
      $('#profile-avatar-preview').innerHTML = avatarHtml({ ...me, avatar: newAvatar }, 'large');
    } catch (err) { toast('头像上传失败'); }
  };
  $('#btn-save-profile').onclick = async () => {
    const nickname = $('#profile-nickname').value.trim();
    const signature = $('#profile-signature').value.trim();
    if (!nickname) { toast('昵称不能为空'); return; }
    try {
      const { user } = await api.updateProfile({ nickname, signature, avatar: newAvatar || undefined });
      state.me = user;
      cacheUser(user);
      renderMyProfile();
      closeModal();
      toast('资料已更新');
      await loadConversations();
    } catch (err) { toast(err.message); }
  };
}

function openAddFriendModal() {
  openModal(`
    <div class="modal-header">添加好友<button class="modal-close" data-act="close">✕</button></div>
    <div class="modal-body">
      <input class="modal-input" id="add-friend-q" placeholder="输入用户名或昵称，回车搜索">
      <div id="add-friend-results"><div class="no-data">搜索后显示结果</div></div>
    </div>`);

  $('#modal-box').addEventListener('click', (e) => {
    if (e.target.dataset.act === 'close') closeModal();
    const addBtn = e.target.closest('button[data-add]');
    if (addBtn) doAddFriend(Number(addBtn.dataset.add), addBtn);
  });

  $('#add-friend-q').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const q = e.target.value.trim();
    const box = $('#add-friend-results');
    if (!q) return;
    box.innerHTML = '<div class="no-data">搜索中...</div>';
    try {
      const { users } = await api.searchUsers(q);
      box.innerHTML = users.length ? users.map(u => `
        <div class="user-row">
          ${avatarHtml(u)}
          <div class="info">
            <div class="name">${escapeHtml(u.nickname)}
              <span style="color:#999;font-weight:400">@${escapeHtml(u.username)}</span></div>
            <div class="sub">${u.online ? '在线' : '离线'}</div>
          </div>
          <button class="modal-btn" data-add="${u.id}" style="height:32px;padding:0 12px;font-size:12px">添加</button>
        </div>`).join('') : '<div class="no-data">未找到该用户</div>';
    } catch (err) { box.innerHTML = `<div class="no-data">${escapeHtml(err.message)}</div>`; }
  });
}

async function doAddFriend(userId, btn) {
  btn.disabled = true;
  btn.textContent = '发送中...';
  try {
    const res = await api.addFriend({ userId });
    toast(res.message);
    if (res.accepted) {
      await loadConversations();
      await loadFriends();
      renderConvList();
    }
    closeModal();
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
    btn.textContent = '添加';
  }
}
/* ---------------- 弹窗：好友请求 / 发起群聊 ---------------- */

async function openRequestsModal() {
  openModal(`
    <div class="modal-header">好友请求<button class="modal-close" data-act="close">✕</button></div>
    <div class="modal-body"><div id="requests-list"><div class="no-data">加载中...</div></div></div>`);

  const render = async () => {
    try {
      const { requests } = await api.requests();
      $('#requests-list').innerHTML = requests.length ? requests.map(r => `
        <div class="user-row">
          ${avatarHtml(r)}
          <div class="info">
            <div class="name">${escapeHtml(r.nickname)}
              <span style="color:#999;font-weight:400">@${escapeHtml(r.username)}</span></div>
            <div class="sub">请求添加你为好友</div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="modal-btn" data-accept="${r.id}" style="height:32px;padding:0 12px;font-size:12px">接受</button>
            <button class="modal-btn ghost" data-reject="${r.id}" style="height:32px;padding:0 12px;font-size:12px">拒绝</button>
          </div>
        </div>`).join('') : '<div class="no-data">暂无待处理的好友请求</div>';
    } catch (err) { toast(err.message); }
  };

  $('#modal-box').addEventListener('click', async (e) => {
    if (e.target.dataset.act === 'close') closeModal();
    const acc = e.target.closest('button[data-accept]');
    const rej = e.target.closest('button[data-reject]');
    if (acc) {
      try {
        await api.acceptRequest(acc.dataset.accept);
        toast('已添加为好友');
        await loadConversations(); await loadFriends(); renderConvList();
      } catch (err) { toast(err.message); }
      render(); refreshRequestsBadge();
    } else if (rej) {
      try { await api.rejectRequest(rej.dataset.reject); toast('已拒绝'); }
      catch (err) { toast(err.message); }
      render(); refreshRequestsBadge();
    }
  });
  render();
}

function openCreateGroupModal() {
  const friends = state.friends;
  openModal(`
    <div class="modal-header">发起群聊<button class="modal-close" data-act="close">✕</button></div>
    <div class="modal-body">
      <input class="modal-input" id="group-name" placeholder="群聊名称（最多 30 字，可留空）">
      <div style="max-height:300px;overflow-y:auto">
        ${friends.length ? friends.map(f => `
          <div class="user-row">
            ${avatarHtml(f)}
            <div class="info">
              <div class="name">${escapeHtml(f.nickname)}</div>
              <div class="sub">@${escapeHtml(f.username)}</div>
            </div>
            <input type="checkbox" value="${f.id}">
          </div>`).join('') : '<div class="no-data">暂无好友，先去添加好友吧</div>'}
      </div>
      <div class="modal-btn-row">
        <button class="modal-btn ghost" data-act="close">取消</button>
        <button class="modal-btn" id="btn-create-group" ${friends.length ? '' : 'disabled'}>创建群聊</button>
      </div>
    </div>`);

  $('#modal-box').addEventListener('click', async (e) => {
    if (e.target.dataset.act === 'close') closeModal();
    if (e.target.id === 'btn-create-group') {
      const name = $('#group-name').value.trim();
      const memberIds = $$('#modal-box input[type=checkbox]:checked').map(c => Number(c.value));
      if (!memberIds.length) { toast('请至少选择一位好友'); return; }
      try {
        await api.createGroup({ name, memberIds });
        toast('群聊已创建');
        await loadConversations();
        closeModal();
      } catch (err) { toast(err.message); }
    }
  });
}
/* ---------------- 弹窗：会话信息（好友资料 / 群管理） ---------------- */

async function openConvInfoModal() {
  const conv = convOf(state.activeConvId);
  if (!conv) return;

  if (conv.convType === 'single') {
    const p = conv.peer;
    openModal(`
      <div class="modal-header">好友资料<button class="modal-close" data-act="close">✕</button></div>
      <div class="modal-body">
        <div style="display:flex;gap:14px;align-items:center;margin-bottom:16px">
          ${avatarHtml(p, 'large')}
          <div>
            <div style="font-size:16px;font-weight:600">${escapeHtml(p.remark || p.nickname)}</div>
            <div style="font-size:12px;color:#999">@${escapeHtml(p.username)} · ${p.online ? '在线' : '离线'}</div>
          </div>
        </div>
        <div style="font-size:13px;color:#666;margin-bottom:20px">个性签名：${escapeHtml(p.signature || '-')}</div>
        <div class="modal-btn-row" style="justify-content:flex-start">
          <button class="modal-btn danger" id="btn-delete-friend">删除好友</button>
        </div>
      </div>`);

    $('#modal-box').addEventListener('click', (e) => {
      if (e.target.dataset.act === 'close') closeModal();
    });
    $('#btn-delete-friend').onclick = async () => {
      const ok = await confirmModal('删除好友', `确定删除好友「${p.nickname}」吗？将不再接收对方消息。`, '删除');
      if (!ok) return;
      try {
        await api.deleteFriend(p.id);
        state.conversations = state.conversations.filter(c => c.convId !== conv.convId);
        state.messages.delete(conv.convId);
        state.activeConvId = null;
        $('#chat-main').hidden = true;
        $('#chat-empty').hidden = false;
        await loadFriends();
        renderConvList();
        updateTitleBadge();
        closeModal();
        toast('已删除好友');
      } catch (err) { toast(err.message); }
    };
    return;
  }

  // 群资料
  let g = conv.groupDetail;
  if (!g) {
    try {
      const res = await api.group(conv.group.id);
      g = res.group;
      conv.groupDetail = g;
      conv.members = g.members;
    } catch (err) { toast(err.message); return; }
  }
  const isOwner = g.ownerId === state.me.id;
  openModal(`
    <div class="modal-header">群聊信息<button class="modal-close" data-act="close">✕</button></div>
    <div class="modal-body">
      <div style="display:flex;gap:14px;align-items:center;margin-bottom:16px">
        ${avatarHtml({ nickname: g.name, avatar: g.avatar }, 'large')}
        <div>
          <div style="font-size:16px;font-weight:600">${escapeHtml(g.name)}</div>
          <div style="font-size:12px;color:#999">群主：${escapeHtml(g.members.find(m => m.id === g.ownerId)?.nickname || '-')} · ${g.members.length} 人</div>
        </div>
      </div>
      <div style="max-height:260px;overflow-y:auto;margin-bottom:16px">
        ${g.members.map(m => `
          <div class="user-row">
            ${avatarHtml(m)}
            <div class="info">
              <div class="name">${escapeHtml(m.nickname)}${m.id === g.ownerId ? ' <span style="color:#07c160;font-size:11px">群主</span>' : ''}</div>
              <div class="sub">@${escapeHtml(m.username)}</div>
            </div>
            ${isOwner && m.id !== state.me.id
              ? `<button class="modal-btn ghost" data-kick="${m.id}" style="height:30px;padding:0 10px;font-size:12px;color:#fa5151">移出</button>`
              : ''}
          </div>`).join('')}
      </div>
      <div class="modal-btn-row" style="justify-content:flex-start">
        ${isOwner
          ? `<button class="modal-btn danger" id="btn-dismiss-group">解散群聊</button>`
          : `<button class="modal-btn danger" id="btn-leave-group">退出群聊</button>`}
      </div>
    </div>`);

  $('#modal-box').addEventListener('click', async (e) => {
    if (e.target.dataset.act === 'close') closeModal();
    const kick = e.target.closest('button[data-kick]');
    if (kick) {
      const member = g.members.find(m => String(m.id) === kick.dataset.kick);
      const ok = await confirmModal('移出群聊', `确定将「${member?.nickname || '成员'}」移出群聊吗？`, '移出');
      if (!ok) return;
      try { await api.removeMember(g.id, kick.dataset.kick); toast('已移出'); closeModal(); }
      catch (err) { toast(err.message); }
      return;
    }
    if (e.target.id === 'btn-dismiss-group') {
      const ok = await confirmModal('解散群聊', '解散后所有成员将退出该群，确定解散吗？', '解散');
      if (!ok) return;
      try { await api.dismissGroup(g.id); toast('群已解散'); closeModal(); }
      catch (err) { toast(err.message); }
      return;
    }
    if (e.target.id === 'btn-leave-group') {
      const ok = await confirmModal('退出群聊', '确定退出该群聊吗？', '退出');
      if (!ok) return;
      try { await api.removeMember(g.id, state.me.id); toast('已退出群聊'); closeModal(); }
      catch (err) { toast(err.message); }
    }
  });
}
