'use strict';

// 有界搜索：每批最多 50 行，每请求最多扫描 1000 行/1MiB 密文；批次间让出主线程。
const { setImmediate: yieldTurn } = require('node:timers/promises');
const { db } = require('./db');
const { decryptMessageContent } = require('./crypto');
const BATCH = 50, MAX_RESULTS = 30, MAX_ROWS = 1000, MAX_BYTES = 1024 * 1024;
const active = new Map();

function positiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

async function searchHistory({ userId, convId, q, before, cancelled = () => false }) {
  // 新搜索直接取代同一用户的旧搜索：旧任务在下一批次边界返回 null。
  const previous = active.get(userId);
  if (previous) previous.cancelled = true;
  const job = { cancelled: false };
  active.set(userId, job);
  try {
    let cursor = positiveInteger(before, Number.MAX_SAFE_INTEGER);
    let scanned = 0, bytes = 0;
    const matches = [];
    const stmt = db.prepare('SELECT * FROM messages WHERE conv_id = ? AND id < ? ORDER BY id DESC LIMIT 50');
    while (scanned < MAX_ROWS && bytes < MAX_BYTES && matches.length < MAX_RESULTS) {
      await yieldTurn();
      if (job.cancelled || cancelled()) return null;
      const rows = stmt.all(convId, cursor);
      if (!rows.length) return { matches, nextBefore: null };
      for (const m of rows) {
        cursor = m.id;
        scanned++;
        bytes += m.content_enc.length;
        if (!m.revoked && (m.kind === 'text' || m.kind === 'emoji')) {
          try {
            const content = decryptMessageContent(m.content_enc);
            if (typeof content.text === 'string' && content.text.includes(q)) matches.push({ row: m, content });
          } catch (_) { /* 旧的损坏记录不阻断搜索 */ }
        }
        if (scanned >= MAX_ROWS || bytes >= MAX_BYTES || matches.length >= MAX_RESULTS) break;
      }
      // 游标落在最后一条已扫描记录上：续查覆盖断点之后更旧的记录，不跳过也不重复。
      if (cursor === rows[rows.length - 1].id && rows.length < BATCH) return { matches, nextBefore: null };
    }
    const more = db.prepare('SELECT 1 FROM messages WHERE conv_id = ? AND id < ? LIMIT 1').get(convId, cursor);
    return { matches, nextBefore: more ? cursor : null };
  } finally {
    if (active.get(userId) === job) active.delete(userId);
  }
}

module.exports = { positiveInteger, searchHistory };
