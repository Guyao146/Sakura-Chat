/** 标签页内草稿：按账号/会话隔离，刷新可恢复；存储不可用时退回内存。 */
export class DraftStore {
  constructor(userId, storage) {
    this.prefix = `sc_draft_v1:${userId}:`;
    this.memory = new Map();
    this.storage = storage;
  }

  get(convId) {
    if (this.memory.has(convId)) return this.memory.get(convId);
    let draft = null;
    try {
      const value = JSON.parse(this.storage?.getItem(this.prefix + convId) || 'null');
      if (value && typeof value.text === 'string') {
        const reply = value.reply;
        draft = { text: value.text, reply: reply && typeof reply.msgId === 'string' && typeof reply.snip === 'string'
          ? { msgId: reply.msgId, snip: reply.snip } : null };
      }
    } catch (_) { /* 损坏/禁用的存储不影响输入 */ }
    this.memory.set(convId, draft);
    return draft;
  }

  set(convId, text, reply) {
    if (!convId) return;
    const draft = text || reply ? { text, reply: reply ? { ...reply } : null } : null;
    this.memory.set(convId, draft);
    try {
      if (draft) this.storage?.setItem(this.prefix + convId, JSON.stringify(draft));
      else this.storage?.removeItem(this.prefix + convId);
    } catch (_) { /* 配额不足时仍保留内存草稿 */ }
  }

  clear() {
    this.memory.clear();
    try {
      const keys = [];
      for (let i = 0; i < this.storage?.length; i++) {
        const key = this.storage.key(i);
        if (key?.startsWith(this.prefix)) keys.push(key);
      }
      keys.forEach(key => this.storage.removeItem(key));
    } catch (_) {}
  }
}
