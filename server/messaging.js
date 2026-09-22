'use strict';

/**
 * 消息写入辅助（系统消息等）
 */

const { db } = require('./db');
const { encryptMessageContent, genId } = require('./crypto');

function insertSystemMessage(convType, convId, text) {
  const ts = Date.now();
  const info = db.prepare(`
    INSERT INTO messages (msg_id, conv_type, conv_id, sender_id, receiver_id, group_id, kind, content_enc, created_at, delivered)
    VALUES (?, ?, ?, 0, NULL, NULL, 'system', ?, ?, 1)
  `).run(genId('m'), convType, convId, encryptMessageContent({ text }), ts);
  return { id: Number(info.lastInsertRowid), createdAt: ts };
}

module.exports = { insertSystemMessage };
