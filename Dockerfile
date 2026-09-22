# syntax=docker/dockerfile:1

# ---------- 阶段一：安装生产依赖 ----------
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------- 阶段二：运行镜像 ----------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# 仅复制依赖与源码；node:sqlite 为 Node 内置模块，无需编译原生扩展
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 数据/上传目录预先创建并授权给内置的 node 用户（容器以非 root 运行）
RUN mkdir -p server/data public/uploads && chown -R node:node server/data public/uploads

USER node

EXPOSE 3000

# 健康检查：直接用 Node 内置 fetch 打 /api/health，无需安装 curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# server/data：主密钥 key.json + SQLite 数据库（持久化，务必定期备份）
# public/uploads：图片/语音文件
VOLUME ["/app/server/data", "/app/public/uploads"]

CMD ["node", "server/index.js"]
