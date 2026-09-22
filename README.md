# 🌸 Sakura Chat

一个仿微信的网页聊天应用：账号密码登录、好友/群聊、实时消息、**加密传输 + 加密存储**。
Node.js 全栈（后端 Express + WebSocket + SQLite，前端原生 ES Module 单页应用，无构建步骤、无 CDN 依赖）。

---

## ✨ 功能特性

对标微信聊天侧的核心能力：

| 模块 | 功能 |
| --- | --- |
| 账号 | 用户名/密码注册登录、JWT 鉴权、密码 scrypt 哈希存储 |
| 好友 | 用户名/昵称搜索、好友请求（发送/同意/拒绝）、好友列表、删除好友、**文件传输助手（内置系统账号，注册即自动互加好友，消息自动送达+已读，不可登录/搜索/删除）** |
| 单聊 | 实时收发、离线消息存储、**已发送 → 已送达 → 已读** 状态回执 |
| 群聊 | 建群（群主）、邀请成员、移出成员、退群、解散群、群成员列表、**群公告**、**群昵称**、**群主/管理员（管理员可发公告、移人）** |
| 消息 | 文字、Emoji 表情面板、**表情包（程序化生成的猫咪贴纸）**、图片消息（上传/预览）、**语音消息（按住说话、波形播放）**、系统消息 |
| 消息交互 | **2 分钟内撤回**、**引用回复（点击引用卡片跳转原文）**、**表情反应（点赞/爱心等角标）**、**消息编辑**、**拍一拍**、消息复制、未读角标、未读分界线、上下滚动加载历史 |
| 通话 | **1 对 1 语音 / 视频通话**（WebRTC，媒体 P2P 直连且 DTLS-SRTP 端到端加密，信令走加密 WS 通道） |
| 输入 | 粘贴/拖拽图片文件直接上传、右键菜单（复制/引用/拍一拍/撤回/编辑/收藏） |
| 状态 | **四态在线状态（在线/隐身/忙碌/离线，隐身对他人表现为离线）**、"对方正在输入…" 提示 |
| 会话管理 | **置顶**、**免打扰**、**全局搜索（好友/群/消息/收藏四分组）**、**消息收藏** |
| 聊天记录 | 服务端加密存储、分页加载、会话内聊天记录搜索 |
| 资料 | 修改昵称、个性签名、上传头像 |
| 界面 | Markdown 渲染、**移动端自适应（窄屏单栏切换）**、侧边栏可拖拽调宽（宽度记忆） |

---

## 🚀 快速开始

> 环境要求：Node.js ≥ 22（使用内置 `node:sqlite` 与 `node:crypto`，无需编译原生模块）

### 方式一：Node.js 直接启动

```bash
# 1. 安装依赖（仅 express 与 ws 两个包）
npm install

# 2. 启动服务（开发模式，改动自动重启）
npm run dev
# 或生产模式
npm start
```

浏览器打开 **http://localhost:3000** ，注册账号即可开始使用。开两个浏览器窗口（或无痕窗口）注册两个账号互加好友，即可体验完整流程。

### 方式二：Docker Compose（推荐生产环境）

```bash
# 一条命令构建并启动（首次约 1 分钟）
docker compose up -d --build

# 查看日志 / 停止
docker compose logs -f
docker compose down
```

- 浏览器打开 **http://localhost:3000**（可用 `HOST_PORT=8080 docker compose up -d` 换宿主机端口）
- **务必先设置 JWT 密钥**：在项目根目录创建 `.env`（参考 `.env.example`）写入 `JWT_SECRET=<openssl rand -hex 32 生成>`
- 数据持久化：主密钥 `key.json` 与 SQLite 数据库存放在 `sakura-data` 卷，上传文件在 `sakura-uploads` 卷——**重建容器不丢数据，但请定期备份卷**

两种方式首次启动都会自动在 `server/data/key.json` 生成**存储主密钥**，用于加密数据库中的聊天记录。

---

## 📁 目录结构

```
Sakura-Chat/
├── package.json
├── .env.example          # 配置示例（端口 / JWT 密钥 / TLS 证书）
├── Dockerfile            # 多阶段构建（node:24-alpine，非 root 运行，含健康检查）
├── docker-compose.yml    # 一键部署（数据/上传卷持久化）
├── .dockerignore
├── .github/
│   └── workflows/
│       ├── ci.yml               # push/PR：语法检查 + E2E 45 项 + Docker 镜像冒烟
│       └── docker-publish.yml   # push master：构建并推送镜像到 ghcr.io
├── server/
│   ├── index.js          # 入口：HTTP(S) + WebSocket + 静态托管前端
│   ├── config.js         # 配置加载、主密钥生成
│   ├── crypto.js         # AES-256-GCM 加解密、scrypt 密码哈希
│   ├── token.js          # 极简 JWT（HMAC-SHA256，零依赖）
│   ├── db.js             # SQLite 表结构与 DAO（含幂等迁移）
│   ├── state.js          # 在线连接、会话密钥、加密推送
│   ├── services.js       # 会话权限校验、好友/群关系、会话内广播
│   ├── system.js         # 系统账号「文件传输助手」：注册自动互加好友、拒绝登录/搜索/删除
│   ├── messaging.js      # 系统消息写入
│   ├── middleware.js     # 鉴权中间件
│   ├── ws.js             # WebSocket：收发/已读/输入/撤回/反应/编辑/拍一拍/心跳/重连
│   ├── keygen.js         # 重新生成主密钥与 JWT 密钥（npm run keygen）
│   └── api/              # REST 接口
│       ├── auth.js       # 注册 / 登录 / 会话密钥
│       ├── users.js      # 搜索 / 资料 / 在线状态
│       ├── friends.js    # 好友请求 / 列表
│       ├── groups.js     # 群增删改查 / 公告 / 管理员
│       ├── conversations.js  # 会话列表 / 历史 / 已读 / 搜索 / 置顶免打扰 / 收藏
│       ├── stickers.js   # 自定义表情包（加密存储）
│       └── upload.js     # 图片/文件/语音上传
├── tools/
│   └── gen-stickers.js   # 表情包生成器（npm run stickers）
├── public/               # 前端（直接由 Express 托管）
│   ├── index.html
│   ├── css/app.css
│   ├── stickers/         # 表情包资源（SVG + index.json 清单）
│   └── js/
│       ├── main.js       # 启动：登录态判定
│       ├── login.js      # 登录/注册视图
│       ├── app.js        # 主应用：会话列表/聊天窗口/实时事件/通话 UI
│       └── lib/          # crypto / api / socket / util / emoji / voice / call
└── test/e2e.js           # 端到端集成测试（45 项断言）
```
## 🔐 加密架构（三层）

本应用采用"传输层加密 + 服务端可解密存储"模型，这也是支持「聊天记录搜索」与「多端漫游」的前提：

```
浏览器                      服务端                      SQLite
   │  ┌─ TLS (HTTPS/WSS) ─────────┐                        │
   │  │                           │                        │
   ├──┤ 应用层 AES-256-GCM ───────┤→ 解密 → 业务处理        │
   │  │  (会话密钥，登录时下发)    │                        │
   │  └───────────────────────────┘   存储 AES-256-GCM ────┤→ content_enc
                                                             (主密钥 key.json)
```

1. **传输层加密**：启用 `SSL_KEY_PATH/SSL_CERT_PATH` 后自动切换为 HTTPS + WSS（见下文部署）。
2. **应用层加密（端到密文）**：登录成功或页面刷新时，服务端向**已认证**客户端下发一次性会话密钥（AES-256-GCM）。
   之后所有 WebSocket 业务载荷（聊天内容、撤回、输入状态等）都先用该密钥加密再发送。
   **即使开发期使用明文 HTTP/WS，聊天内容在链路上也全是密文**，且浏览器端使用 Web Crypto API 原生实现，与服务端格式完全互通。
3. **存储加密**：所有聊天记录以 AES-256-GCM 加密后写入 SQLite 的 `content_enc` 字段，主密钥保存在 `server/data/key.json`（已在 `.gitignore` 中）。
   数据库文件即使被拖走也无法读到明文。

> 安全边界说明：服务端持有主密钥，因此**可以**解密并存储消息（用于搜索/漫游）。这是与端到端加密（E2EE）的取舍：本方案换取了聊天记录搜索能力，代价是信任服务器。

---

## 🌐 REST API 概览

所有接口以 `/api` 开头，除 `auth` 外均需 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/register` | 注册 `{username, password, nickname}` |
| POST | `/api/auth/login` | 登录，返回 `token` + `sessionId` + `sessionKey` |
| GET | `/api/auth/session` | 刷新会话密钥（页面刷新时调用，不长期保存密钥） |
| GET | `/api/auth/me` | 当前用户 |
| GET | `/api/users/search?q=` | 搜索用户 |
| PUT | `/api/users/profile` | 修改资料（昵称/签名/头像） |
| GET/POST/DELETE | `/api/friends...` | 好友列表、请求、同意/拒绝、删除 |
| POST | `/api/groups` | 建群 `{name, memberIds}` |
| GET/POST/DELETE | `/api/groups/:id/...` | 群资料、邀请、移除、解散 |
| GET | `/api/conversations` | 会话列表（含未读数、最后消息） |
| GET | `/api/conversations/:id/messages?before=` | 历史消息分页 |
| POST | `/api/conversations/:id/read` | 标记已读并回执对方 |
| GET | `/api/conversations/:id/search?q=` | 聊天记录搜索（服务端解密后检索） |
| POST | `/api/upload` | Base64 图片/文件上传 |
| — | `ws(s)://host/ws?token=&sid=` | 加密实时通道 |

**WebSocket 协议**：客户端发送 `{sid, d: base64(IV+密文+Tag)}`，服务端解密后按 `type` 分发：
`chat / read / typing / recall / call_offer / call_answer / call_ice / call_reject / call_busy / call_end / call_log / ping`；
服务端推送 `message / ack / status / read / typing / presence / recall / friend_request / friend_accepted / group_invited / group_event / group_dismissed / call_* / call_failed`。

> 音视频通话的**信令**（协商/ICE/挂断）复用上述加密 WS 通道，而**媒体流**由两台浏览器 WebRTC P2P 直连，本身即受 DTLS-SRTP 加密保护——服务器既不转发媒体、也无法解密音视频内容。通话信令仅允许好友之间中继，呼叫离线用户会返回 `call_failed`。

---

## 🧪 测试

```bash
# 方式一：Node.js 直跑
npm start                                  # 先启动服务（另开终端）
HOST=http://127.0.0.1:3000 npm test        # 运行端到端测试

# 方式二：Docker 容器内跑（CI 同款，服务与测试同在容器网络）
docker build -t sakura-chat:test .
docker run -d --rm --name sakura-test -p 3300:3000 sakura-chat:test
HOST=http://127.0.0.1:3300 npm test
```

> 也可使用 GitHub Actions：每次 push/PR 自动执行**语法检查 + 45 项 E2E 回归 + Docker 镜像构建冒烟**，无需本地配置。

测试覆盖：注册登录、JWT、会话密钥、好友请求/同意、**加密 WS 收发**、ACK、已读回执、输入提示、撤回、群聊广播、**表情包与语音消息收发**、**通话信令中继（邀请/应答/ICE/拒绝/挂断、非好友拦截、离线回执、通话记录）**、**引用回复 / 表情反应 / 消息编辑 / 拍一拍（含"他人消息不可编辑"权限）**、**置顶 + 免打扰、全局搜索、收藏/取消收藏、隐身状态广播**、服务端聊天记录搜索，**文件传输助手（注册默认好友、拒绝登录、不可搜索/添加/删除、消息自动送达+已读）**，以及**断言数据库中不存在明文聊天记录**（共 **45** 项）。

---

## 📞 音视频通话说明

- 在单聊会话头部点击 📞（语音）或 📹（视频）发起通话；对方会收到振铃弹窗（WebAudio 合成铃声，无外部音频文件）。
- 通话窗口支持静音、开/关摄像头（视频通话）、切换前后摄像头、挂断，以及通话计时。
- **通话记录**：挂断后由主叫方写入一条系统消息（如「语音通话 02:15」「视频通话未接听」），双方都能在会话中回看。
- 弱网提示：ICE 连接抖动时通话窗口会显示「网络不佳，尝试重连中…」。
- 浏览器需允许麦克风/摄像头权限；`getUserMedia` 仅在 **HTTPS 或 localhost** 下可用。
- NAT 穿透依赖公共 STUN（默认使用 Google STUN 服务器，需能访问公网；同一局域网内主机候选可直接连通，无需 STUN）。若需在严格 NAT 下保证连通，需在 `public/js/lib/call.js` 的 `ICE_SERVERS` 中补充 TURN 服务器。
- 通话期间 WebSocket 断开会自动结束通话；超过 45 秒无人接听自动挂断。

---

## 📦 部署

### 方式一：Docker Compose（推荐）

```bash
# 1. 配置 JWT 密钥（.env，参考 .env.example）
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env

# 2. 构建并启动
docker compose up -d --build

# 3. 升级（拉代码后）
git pull && docker compose up -d --build
```

数据安全须知：
- `sakura-data` 卷保存 **主密钥 key.json + SQLite 数据库**，务必定期 `docker run --rm -v sakura-chat_sakura-data:/data -v $PWD:/backup alpine tar czf /backup/data.tgz -C /data .` 备份
- 反代（Nginx/Caddy）终结 TLS 时需放行 WebSocket Upgrade 头，并转发 `ws` 到容器 3000 端口

### 方式二：Node.js 裸机 / pm2

```bash
npm ci --omit=dev
PORT=3000 JWT_SECRET=<随机值> node server/index.js
# 或 pm2 start server/index.js --name sakura-chat
```

### CI/CD（GitHub Actions）

| Workflow | 触发 | 作用 |
| --- | --- | --- |
| `ci.yml` | push / PR | 语法检查 → E2E 45 项 → Docker 镜像构建冒烟 |
| `docker-publish.yml` | push master / tag `v*` | 构建镜像并推送到 **ghcr.io/guyao146/sakura-chat**（私有仓库即私有镜像） |

服务器直接拉取已发布镜像：

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u Guyao146 --password-stdin
docker pull ghcr.io/guyao146/sakura-chat:latest
# 然后用 docker-compose 的 image 字段替换为 ghcr.io 地址，或 docker run -v sakura-data:/app/server/data -p 3000:3000 ghcr.io/guyao146/sakura-chat:latest
```

### 其他生产建议

1. **启用 TLS**：把证书放到 `server/data/`，在 `.env` 中配置：
   ```env
   SSL_KEY_PATH=server/data/key.pem
   SSL_CERT_PATH=server/data/cert.pem
   ```
   自签证书可用 `openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes` 或 [mkcert](https://github.com/FiloSottile/mkcert) 生成；正式环境建议 Let's Encrypt / 反向代理（Nginx 终结 TLS 并转发 `ws`）。
2. **修改 JWT 密钥**：`.env` 中设置随机 `JWT_SECRET`，或执行 `npm run keygen`。
3. **备份主密钥**：`server/data/key.json` 丢失将导致历史聊天记录无法解密。
4. **数据库**：SQLite 单机足够中小规模使用；如需横向扩展，可平滑迁移至 Postgres/MySQL。
5. 上传目录 `public/uploads/` 需可写；建议挂载到对象存储或独立卷。

---

## ⚠️ 已知局限

- 聊天记录搜索为服务端解密后内存检索（适合中小消息量），超大规模需引入加密检索方案或明文索引。
- 同一账号多标签页登录会共存（各自独立会话密钥，互不影响），暂未做互踢。
- 图片与语音文件本身以文件形式存放于 uploads 目录，未做静态加密（消息正文中的链接仍加密存储）。
- 音视频通话仅支持**好友间 1 对 1**；群组多人通话需要 SFU 媒体服务器（如 mediasoup/LiveKit），暂未集成。
- 语音消息的波形为录音时采集的频谱峰值快照，并非精确音频波形。
