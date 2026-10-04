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
const system = require('./system');

// 系统账号：文件传输助手（默认与所有用户互为好友，含老库迁移补建）
system.ensureSystemUser();
system.ensureAllUsersFriendSystem();

const { auth } = require('./middleware');
const { attach } = require('./ws');

const app = express();
app.set('trust proxy', config.trustProxy);
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true, limit: '12mb' }));

// 安全头：禁止内容类型嗅探（上传的文本文件不应被浏览器当成 HTML 执行）
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// 按静态服务器最终解析的文件路径设置安全头，避免 URL 编码/路径规范化绕过。
// SVG 顶层导航可能同源执行脚本；附件下载不影响 <img> 加载。
app.use(express.static(path.join(config.root, 'public'), {
  setHeaders(res, filePath) {
    if (path.extname(filePath).toLowerCase() === '.svg' &&
      path.relative(config.uploadsDir, filePath).split(path.sep)[0] !== '..') {
      res.setHeader('Content-Disposition', 'attachment');
    }
  },
}));

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
  console.log('[warn] 未启用本机 TLS。生产环境必须使用 HTTPS 反向代理或正式证书；应用层加密不能保护明文 HTTP 下发的密码、令牌和会话密钥');
}

attach(server);

server.listen(config.port, () => {
  console.log(`\n  Sakura-Chat 已启动: http${config.useTls ? 's' : ''}://localhost:${config.port}\n`);
});
