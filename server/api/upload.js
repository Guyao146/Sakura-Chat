'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');

const router = express.Router();

const EXT_WHITELIST = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'txt',
  'mp3', 'mp4', 'mov',
  // 语音消息（MediaRecorder 常见编码）
  'webm', 'ogg', 'm4a', 'aac', 'wav', 'opus', 'flac',
]);

/** Base64 图片/文件上传，落盘到 public/uploads（静态目录可直接访问） */
router.post('/', (req, res) => {
  const { data, filename } = req.body || {};
  if (typeof data !== 'string' || !data.startsWith('data:')) {
    return res.status(400).json({ error: '仅支持 data:base64 格式' });
  }
  const m = /^data:([\w/.+-]+);base64,(.*)$/s.exec(data);
  if (!m) return res.status(400).json({ error: 'base64 内容格式错误' });
  const mime = m[1];
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > config.uploadMaxBytes) {
    return res.status(400).json({ error: '文件为空或超过 10MB 上限' });
  }
  const extRaw = path.extname(filename || mime.split('/')[1] || 'png') || '.png';
  const ext = extRaw.replace('.', '').toLowerCase();
  if (!EXT_WHITELIST.has(ext)) {
    return res.status(400).json({ error: '不支持的文件类型：' + ext });
  }
  const name = crypto.randomUUID() + '.' + ext;
  fs.writeFileSync(path.join(config.uploadsDir, name), buf);
  res.json({ url: '/uploads/' + name, size: buf.length });
});

module.exports = router;
