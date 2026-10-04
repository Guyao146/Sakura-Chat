# 🌸 Sakura Chat

一个安全，隐私，自主的网页聊天应用：账号密码登录、好友/群聊、实时消息、**加密传输 + 加密存储**。
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
| 输入 | **按账号/会话隔离的草稿（刷新可恢复、退出登录清除、仅存本标签页）**、粘贴/拖拽图片文件直接上传、右键菜单（复制/引用/拍一拍/撤回/编辑/收藏） |
| 状态 | **四态在线状态（在线/隐身/忙碌/离线，隐身对他人表现为离线）**、"对方正在输入…" 提示 |
| 会话管理 | **置顶**、**免打扰**、**全局搜索（好友/群/消息/收藏四分组）**、**消息收藏** |
| 聊天记录 | 服务端加密存储、分页加载、会话内聊天记录搜索 |
| 资料 | 修改昵称、个性签名、上传头像 |
| 界面 | Markdown 渲染、**移动端自适应（窄屏单栏切换）**、侧边栏可拖拽调宽（宽度记忆）、输入框默认单行随内容自适应（消息列表恒留 120px、绝不溢出）、顶部把手向上拖大/向下拖小（双击复位，高度记忆）、表情/贴纸/录音面板随输入框高度自动锚定 |

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
├── docker-compose.yml    # 一键部署（本地构建，数据/上传卷持久化）
├── docker-compose.ghcr.yml  # 一键部署（直拉 GHCR 发布镜像，无需源码）
├── .dockerignore
├── .github/
│   └── workflows/
│       ├── ci.yml               # push/PR：语法检查 + 单元测试 + E2E 62 项 + Docker 镜像冒烟
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
│   ├── oauth.js          # 第三方登录（OIDC 客户端：SakuraID / Authentik，授权码 + PKCE）
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
│       └── lib/          # crypto / api / socket / util / emoji / voice / call / resize / performance
├── test/
│   ├── e2e.js                  # 端到端集成测试（62 项断言）
│   ├── run-isolated.js         # 独立端口 + 临时数据库跑全套回归（npm run test:isolated）
│   ├── drafts.test.mjs         # 草稿存储单元测试（账号/会话隔离、刷新恢复、降级）
│   ├── media-lifecycle.test.mjs # 媒体资源回收单元测试（20 项，含 100 轮启停）
│   ├── client-performance.test.mjs # 前端性能边界单元测试（请求合并、消息缓存淘汰）
│   ├── server-performance.test.mjs # 服务端性能边界单元测试（分页/搜索/密钥/密码哈希/索引）
│   ├── oauth.test.mjs            # 第三方登录与账号绑定/解绑回归（内嵌 Mock OIDC IdP，12 项）
│   ├── browser-login.mjs       # 真实 Chrome 登录页回归（12 项：表单/OAuth 区块显隐/回调错误/资料徽章）
│   ├── browser-media.mjs       # 真实 Chrome 媒体回归（6 项：录音/取消/双端通话回收）
│   ├── browser-performance.mjs # 真实 Chrome 性能回归（11 项：3000 条历史增量渲染/搜索分页）
│   ├── browser-input-height.mjs # 真实 Chrome 鼠标事件的输入框布局回归（23 项）
│   ├── browser-chat.mjs        # 真实 Chrome 鼠标事件的会话回归（17 项：竞态/草稿/注入/历史操作）
│   └── browser-helper.mjs      # CDP 浏览器驱动封装
├── tools/
│   ├── gen-stickers.js           # 表情包资源生成
│   └── oauth-sakuraid-smoke.mjs  # 与真实 Sakura-Auth-Server 的 OIDC 全流程联调（同级目录不存在时自动跳过）
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

## 🪪 第三方登录（可选）

登录页支持三种方式，按需开启，**不配置时只显示本地登录**：

1. **本地账号**：始终可用（用户名 + 密码注册）。
2. **Sakura**：接入同目录的 Sakura-Auth-Server（SakuraID，标准 OIDC 服务）。
3. **Authentik**：接入任意 Authentik 实例（同样走标准 OIDC）。

Sakura-Chat 作为标准 OIDC 客户端，使用**授权码 + PKCE（S256）**流程：浏览器打开
`/api/auth/oauth/<提供方>/start` → 服务端生成 `state` 与 `code_verifier`（只存服务端）后跳转到 IdP →
用户在 IdP 完成登录/同意 → 回调 `/api/auth/oauth/<提供方>/callback` 由服务端校验 `state`、换取令牌、
拉取 `userinfo` → 签发一次性票据（HttpOnly Cookie）跳回前端 → 前端 `POST /api/auth/oauth/finish`
换取本站 JWT + 会话密钥。`state` 与票据均一次性有效，重放即拒绝。

### 配置

在 `.env`（或部署环境变量）中按提供方开启，`OAUTH_<ID>_ISSUER` + `OAUTH_<ID>_CLIENT_ID` 两项齐全即启用：

| 变量 | 说明 |
| --- | --- |
| `OAUTH_SAKURA_ISSUER` | SakuraID 地址，如 `https://sso.example.com` |
| `OAUTH_SAKURA_CLIENT_ID` | SakuraID 管理端新建应用得到的 client_id |
| `OAUTH_SAKURA_CLIENT_SECRET` | 留空 = 公开客户端（仅 PKCE，浏览器侧推荐）；填写 = 机密客户端（Basic 认证） |
| `OAUTH_SAKURA_NAME` | 登录页按钮显示名（默认 `Sakura`） |
| `OAUTH_AUTHENTIK_*` | 同上；Authentik 的 issuer 形如 `https://auth.example.com/application/o/sakura-chat` |
| `APP_BASE_URL` | 反向代理后本站对外地址，用于纠正回调地址（如 `https://chat.example.com`） |

**回调地址固定为** `https://<你的站点>/api/auth/oauth/<提供方>/callback`（提供方即 `sakura` / `authentik`），需在 IdP 侧登记。

### 在 IdP 侧登记应用

- **SakuraID**：管理后台「应用 → 新建应用」，`redirect_uri` 填上面的回调地址；可只勾选 `openid profile`，不填 client_secret 即公开客户端（PKCE）。
- **Authentik**：新建 Provider 类型选 *OAuth2/OpenID Provider*，Client type 选 *Public*（PKCE）或 *Confidential*，Redirect URI 填回调地址；随后在 Application 中绑定并记下 Client ID。

### 账号映射与安全说明

- 外部身份 `(provider, sub)` 与本地账号一一对应：**首次登录自动创建影子账号**（本地密码为随机串，无法用密码登录本站），再次登录复用同一账号。
- 影子账号用户名取自 `preferred_username`（规范化为本站 3-20 位规则），与已有用户名冲突时自动追加 `_2` / `_3` 后缀，**不与同名本地账号合并**——站方无法核实两个身份属于同一人。
- **已有本地账号可主动绑定第三方身份**：在「个人资料」弹窗点「绑定 Sakura」即走同一授权流程（`start?link=1`），回调后凭当前登录态完成绑定；绑定后用该第三方身份登录会直接复用此本地账号（本地密码仍然有效）。「解除绑定」随时可解，但**纯影子账号不可解绑**（否则账号将无法登录）。
- 第三方登录得到的 JWT 与本地登录完全等价，WebSocket、消息加密、文件传输助手等逻辑一致。
- 若 IdP 不可达或令牌校验失败，登录页会展示具体原因（`/login?oauth=error&msg=...`），不会把异常带给用户。
- **登录/注册限流**：密码登录同一 `IP+用户名` 连续失败 5 次将锁定 60 秒（期间即使密码正确也拒绝）；注册按 IP 限频每小时 10 次。锁定信息以 `429` 返回，前端登录页直接展示。限流按 IP 取自 `X-Forwarded-For` 首段，反代部署时请正确配置该头（见部署章节）。

---

## 🌐 REST API 概览

所有接口以 `/api` 开头，除 `auth` 外均需 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/register` | 注册 `{username, password, nickname}`；每 IP 每小时 10 次，超限 `429` |
| POST | `/api/auth/login` | 登录，返回 `token` + `sessionId` + `sessionKey`；同 IP+用户名失败 5 次锁 60 秒（`429`） |
| GET | `/api/auth/session` | 刷新会话密钥（页面刷新时调用，不长期保存密钥） |
| GET | `/api/auth/providers` | 已启用的第三方登录清单（匿名，登录页渲染按钮） |
| GET/POST | `/api/auth/oauth/<提供方>/start`、`/callback`、`finish` | 第三方登录：发起授权（`?link=1` 为绑定模式）/ 授权码回调（换一次性票据 HttpOnly Cookie）/ 前端换本站会话（绑定票据需登录态） |
| POST | `/api/auth/unlink` | 解除当前账号的第三方身份绑定（影子账号拒绝） |
| GET | `/api/auth/me` | 当前用户（含 `authProvider` 登录方式与 `shadow` 影子账号标记） |
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

> 也可使用 GitHub Actions：每次 push/PR 自动执行**语法检查 + 单元测试 + 62 项 E2E 回归 + Docker 镜像构建冒烟**，无需本地配置。

本地还可用 `npm run test:isolated`（草稿/媒体生命周期/性能边界/第三方登录单元测试 + 登录注册限流回归 + 上传安全回归 + E2E，独立端口 + 临时数据库，不污染正式数据）或 `npm run test:browser`（附加真实 Chrome 回归：登录页 12 项、输入框布局 23 项、会话交互 17 项、媒体资源回收 6 项、性能边界 11 项）。单元测试可单独运行 `node --test test/*.test.mjs`；媒体浏览器测试使用合成音源与本地 WebRTC，无需摄像头/麦克风硬件。

若同盘同级目录存在 [Sakura-Auth-Server](../Sakura-Auth-Server)（SakuraID），`test:isolated` 还会自动跑**真实联调**（`tools/oauth-sakuraid-smoke.mjs`）：播种临时 IdP 数据 → 启动真实 SakuraID 与接入它的 Sakura-Chat → 走完整授权码 + PKCE 流程并断言影子账号创建与复用（16 项）。目录不存在时自动跳过，CI 环境安全。

测试覆盖：注册登录、JWT、会话密钥、好友请求/同意、**加密 WS 收发**、ACK、已读回执、输入提示、撤回、群聊广播、**表情包与语音消息收发**、**通话信令中继（邀请/应答/ICE/拒绝/挂断、非好友拦截、离线回执、通话记录）**、**引用回复 / 表情反应 / 消息编辑 / 拍一拍（含"他人消息不可编辑"权限）**、**置顶 + 免打扰（支持单独修改互不覆盖）、全局搜索、收藏/取消收藏、隐身状态广播**、**会话边界与明文拒绝（无效会话密钥关闭连接、明文业务消息不入库、不能使用其它会话密钥绕过连接绑定、消息编号冲突检测）**、**好友拒绝后可重新申请**、服务端聊天记录搜索，**文件传输助手（注册默认好友、拒绝登录、不可搜索/添加/删除、消息自动送达+已读）**，以及**断言数据库中不存在明文聊天记录**（共 **62** 项）。

性能边界测试（`server-performance.test.mjs` / `client-performance.test.mjs` / `browser-performance.mjs`）覆盖：历史分页参数防绕过、有界分批搜索（批次间让出主线程、游标续查不漏不重、撤回消息排除、新搜索取代旧搜索）、会话密钥 TTL 与上限、scrypt 异步化与并发上限、慢连接背压终止、DOM 节点复用（ACK/已读/编辑/撤回只更新目标消息）、用户资料请求合并、消息缓存淘汰与删除会话时的索引回收。

---

## 📞 音视频通话说明

- 在单聊会话头部点击 📞（语音）或 📹（视频）发起通话；对方会收到振铃弹窗（WebAudio 合成铃声，无外部音频文件）。
- 通话窗口支持静音、开/关摄像头（视频通话）、切换前后摄像头、挂断，以及通话计时。
- **通话记录**：挂断后由主叫方写入一条系统消息（如「语音通话 02:15」「视频通话未接听」），双方都能在会话中回看。
- 弱网提示：ICE 连接抖动时通话窗口会显示「网络不佳，尝试重连中…」。
- 浏览器需允许麦克风/摄像头权限；`getUserMedia` 仅在 **HTTPS 或 localhost** 下可用。
- NAT 穿透依赖公共 STUN（默认使用 Google STUN 服务器，需能访问公网；同一局域网内主机候选可直接连通，无需 STUN）。若需在严格 NAT 下保证连通，需在 `public/js/lib/call.js` 的 `ICE_SERVERS` 中补充 TURN 服务器。
- 通话期间 WebSocket 断开会自动结束通话；呼叫或接听建连超过 45 秒自动挂断。
- **资源回收**：挂断、退出登录或离开页面时停止媒体轨道、关闭 WebRTC/音频上下文并清理计时任务；旧通话的异步结果不会重启采集。录音支持权限等待期间取消、初始化失败清理以及结束事件超时兜底。
- `getUserMedia` 的浏览器权限请求本身不可中止；取消后的请求如果随后取得媒体流，会立即停止其所有轨道。浏览器内部线程由浏览器管理，应用通过释放上述资源结束不再需要的媒体工作。

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
- 反代需正确设置 `X-Forwarded-For`（Nginx：`proxy_set_header X-Forwarded-For $remote_addr;`），登录/注册限流依赖该头识别客户端 IP；错误配置会导致同一代理后的用户共享限流配额，或被恶意请求伪造绕过单 IP 锁定

### 方式二：GHCR 镜像直拉（无需源码与构建环境）

镜像由 CI 在每次 push master / 打 tag 时发布到 **ghcr.io/guyao146/sakura-chat**（公开仓库，匿名可拉取）；发布流水线自带**匿名拉取 + 容器健康检查**冒烟，若包可见性被改回私有会自动失败：

```bash
# 1. 配置 JWT 密钥（.env，参考 .env.example）
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env

# 2. 拉取并启动（专用 compose 文件，与方式一仅镜像来源不同）
docker compose -f docker-compose.ghcr.yml up -d

# 3. 升级
docker compose -f docker-compose.ghcr.yml pull && docker compose -f docker-compose.ghcr.yml up -d
```

也可裸 `docker run`：`docker run -d --name sakura-chat -p 3000:3000 -v sakura-data:/app/server/data ghcr.io/guyao146/sakura-chat:latest`

### 方式三：Node.js 裸机 / pm2

```bash
npm ci --omit=dev
PORT=3000 JWT_SECRET=<随机值> node server/index.js
# 或 pm2 start server/index.js --name sakura-chat
```

### CI/CD（GitHub Actions）

| Workflow | 触发 | 作用 |
| --- | --- | --- |
| `ci.yml` | push / PR | 语法检查 → 单元测试 → E2E 62 项 → Docker 镜像构建冒烟 |
| `docker-publish.yml` | push master / tag `v*` | 构建镜像并推送到 **ghcr.io/guyao146/sakura-chat**（公开镜像，服务器直接拉取，见方式二） |

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

---

## 📄 许可证

本项目采用 **Sakura-License v1.2**（源码可用许可证，**非 OSI 开源许可证**）：源码可见、受覆盖的衍生作品须同许可共享、保留署名，**特定商用须事先取得版权人书面授权**（个人学习、教育、非营利活动与免费公开分享无需另行授权）。

- 完整许可正文见仓库根目录 [LICENSE](LICENSE)；采用范围、生效提交、排除项与第三方组件清单见 [NOTICE.md](NOTICE.md)。
- 正文为正式固定版本，逐字取自 [Sakura-EcoSystem-wiki](https://github.com/Guyao146/Sakura-EcoSystem-wiki/blob/359d2e9b7e4446c7980e723d93bc4cac89d36910/licenses/Sakura-License-1.2.md) 的提交 `359d2e9`（2026-10-04 发布；条文与采用时的审阅稿修订 3 逐字一致）。
- 运行依赖 `express` 与 `ws`（均为 MIT）保持各自原有许可，不因一同分发而改用 Sakura-License。
