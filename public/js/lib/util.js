/** 通用 DOM / 工具函数 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const AVATAR_COLORS = [
  '#07c160', '#5b8def', '#f5a623', '#fa5151', '#7c6cf0',
  '#00b578', '#ff8f4b', '#3d8bff', '#c47bff', '#4ba4ff',
];

export function avatarColor(seed) {
  let hash = 0;
  const s = String(seed || '?');
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/** 头像 HTML：有图片用图片，否则取昵称首字母 + 哈希底色 */
export function avatarHtml(user, cls = '') {
  const name = user?.nickname || user?.username || '?';
  if (user?.avatar) {
    return `<div class="avatar ${cls}" style="background-image:url('${user.avatar}');background-color:#eee"></div>`;
  }
  return `<div class="avatar ${cls}" style="background:${avatarColor(name)}">${escapeHtml(name[0].toUpperCase())}</div>`;
}

/** 微信风格时间显示 */
export function formatTime(ts) {
  const d = new Date(ts), now = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `${hh}:${mm}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hh}:${mm}`;
  if ((now - d) / 86400000 < 7) return `周${'日一二三四五六'[d.getDay()]} ${hh}:${mm}`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function toast(msg, ms = 2200) {
  const wrap = $('#toast-wrap');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, ms);
}

export function openModal(html) {
  // 用克隆节点替换旧容器：清空上一次弹窗遗留的事件监听，避免回调叠加触发
  const old = $('#modal-box');
  const fresh = old.cloneNode(false);
  fresh.id = 'modal-box';
  old.replaceWith(fresh);
  fresh.innerHTML = html;
  const mask = $('#modal-mask');
  mask.hidden = false;
  // 强制重排，每次打开都重播遮罩淡入动画
  mask.classList.remove('anim-fade');
  void mask.offsetWidth;
  mask.classList.add('anim-fade');
}

export function closeModal() {
  $('#modal-mask').hidden = true;
  $('#modal-box').innerHTML = '';
}

export function confirmModal(title, text, okLabel = '确定') {
  return new Promise((resolve) => {
    openModal(`
      <div class="modal-header">${escapeHtml(title)}<button class="modal-close" data-act="cancel">✕</button></div>
      <div class="modal-body">
        <p style="font-size:14px;color:#555;line-height:1.6">${escapeHtml(text)}</p>
        <div class="modal-btn-row">
          <button class="modal-btn ghost" data-act="cancel">取消</button>
          <button class="modal-btn danger" data-act="ok">${escapeHtml(okLabel)}</button>
        </div>
      </div>`);
    const box = $('#modal-box');
    box.addEventListener('click', (e) => {
      const act = e.target?.dataset?.act;
      if (act === 'ok') { closeModal(); resolve(true); }
      else if (act === 'cancel') { closeModal(); resolve(false); }
    });
  });
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function isImageFilename(name) {
  return /\.(png|jpg|jpeg|gif|webp|bmp|svg)$/i.test(name || '');
}

/* ---------------- Markdown 富文本（Discord 式，XSS 安全） ---------------- */
// 先转义全部 HTML，再做行内替换；代码块/引用块按行处理
export function renderMarkdown(text) {
  const src = String(text ?? '');
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // ```代码块```（支持语言标注高亮色）
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // 跳过结束的 ```
      out.push(`<div class="md-code"><div class="md-code-lang">${escapeHtml(lang || 'code')}</div><pre>${escapeHtml(buf.join('\n'))}</pre></div>`);
      continue;
    }
    // > 引用块（连续合并）
    if (/^&gt;\s?/.test(escapeHtml(line))) {
      const buf = [];
      while (i < lines.length && /^&gt;\s?/.test(escapeHtml(lines[i]))) {
        buf.push(escapeHtml(lines[i]).replace(/^&gt;\s?/, ''));
        i++;
      }
      out.push(`<div class="md-quote">${inlineMd(buf.join('<br>'))}</div>`);
      continue;
    }
    out.push(inlineMd(escapeHtml(line)));
    i++;
  }
  return out.join('<br>');
}

function inlineMd(safe) {
  let s = safe;
  // 行内代码 `xxx`
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code class="md-icode">${c}</code>`);
  // 粗体 **xxx**
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // 斜体 *xxx*
  s = s.replace(/(^|[^\*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  // 删除线 ~~xxx~~
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  // 链接 [文本](url)（仅 http/https，防 javascript:）
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // 裸链接
  s = s.replace(/(^|[\s(])((https?:\/\/)[^\s<)]+[^\s<).,!?;:'])/g,
    '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  return s;
}

/** 文件大小可读化 */
export function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
