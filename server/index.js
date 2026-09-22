'use strict';

/**
 * 服务入口：HTTP(S) + WebSocket + 静态前端
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const config = require('./config');
const { auth } = require('./middleware');
const { attach } = require('./ws');

const app = express();
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true, limit: '12mb' }));

// 前端静态资源
app.use(express.static(path.join(config.root, 'public')));

// 业务 API
app.use('/api/auth', require('./api/auth'));
app.use('/api/users', auth, require('./api/users'));
app.use('/api/friends', auth, require('./api/friends'));
app.use('/api/groups', auth, require('./api/groups'));
app.use('/api/conversations', auth, require('./api/conversations'));
app.use('/api/stickers', auth, require('./api/stickers'));
app.use('/api/upload', auth, require('./api/upload'));

app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now(), tls: config.useTls }));

// SPA 兜底：非 /api 开头的请求统一返回 index.html
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(config.root, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[error]', err.message, '\n', err.stack);
  res.status(500).json({ error: '服务器内部错误' });
});

let server;
if (config.useTls) {
  server = https.createServer(
    { key: fs.readFileSync(config.sslKeyPath), cert: fs.readFileSync(config.sslCertPath) },
    app
  );
  console.log('[security] 已启用 HTTPS + WSS（传输层加密）');
} else {
  server = http.createServer(app);
  console.log('[warn] 未启用 TLS。聊天内容仍受应用层 AES-256-GCM 加密保护；生产环境请配置正式证书');
}

attach(server);

server.listen(config.port, () => {
  console.log(`\n  Sakura-Chat 已启动: http${config.useTls ? 's' : ''}://localhost:${config.port}\n`);
});
