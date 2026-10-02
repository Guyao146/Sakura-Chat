/** 按稳定 key 复用 DOM；未变更条目不解析 HTML、不替换媒体元素。 */
export class KeyedList {
  constructor(root) { this.root = root; this.items = new Map(); }
  clear() { this.items.clear(); this.root.replaceChildren(); }
  render(entries) {
    if (this.root.firstChild && ![...this.items.values()].some(item => item.node.parentNode === this.root)) this.clear();
    const keep = new Set(entries.map(([key]) => key));
    for (const [key, item] of this.items) {
      if (!keep.has(key)) { item.node.remove(); this.items.delete(key); }
    }
    let cursor = this.root.firstChild;
    const added = [];
    for (const [key, html] of entries) {
      let item = this.items.get(key);
      if (!item || item.html !== html) {
        const template = document.createElement('template');
        template.innerHTML = html;
        const node = template.content.firstElementChild;
        if (item?.node.parentNode === this.root) {
          if (cursor === item.node) cursor = node;
          item.node.replaceWith(node);
        } else added.push(node);
        item = { node, html };
        this.items.set(key, item);
      }
      if (item.node !== cursor) this.root.insertBefore(item.node, cursor);
      cursor = item.node.nextSibling;
    }
    return added;
  }
}

/** 同一用户的并发查询共享 Promise；失败后可重试，不遗留进行中条目。 */
export function singleFlight(fn) {
  const pending = new Map();
  return key => {
    if (!pending.has(key)) {
      const promise = Promise.resolve().then(() => fn(key)).finally(() => pending.delete(key));
      pending.set(key, promise);
    }
    return pending.get(key);
  };
}

/** 当前阅读会话保留历史；非活跃会话仅保留最近 100 条和未确认发送。 */
export function pruneMessageCache(state, maxConversations = 20, maxMessages = 100) {
  for (const [id, list] of state.messages) {
    if (id === state.activeConvId) continue;
    const keep = list.filter((m, i) => i >= list.length - maxMessages || m.status === 'sending');
    if (keep.length !== list.length) {
      const ids = new Set(keep.map(m => m.msgId));
      for (const m of list) if (!ids.has(m.msgId)) state.msgMap.delete(m.msgId);
      state.messages.set(id, keep);
      state.hasMore.set(id, true);
    }
  }
  for (const [id, list] of state.messages) {
    if (state.messages.size <= maxConversations) break;
    if (id !== state.activeConvId && !list.some(m => m.status === 'sending')) dropMessageCache(state, id);
  }
}

export function dropMessageCache(state, convId) {
  for (const m of state.messages.get(convId) || []) state.msgMap.delete(m.msgId);
  state.messages.delete(convId);
  state.hasMore.delete(convId);
}
