# syntax=docker/dockerfile:1
# N1 的 U 盘 I/O 慢，跨阶段复制整个 node_modules 极慢甚至停滞，故在同一阶段构建并运行。
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build \
  && npm prune --omit=dev \
  && npm cache clean --force

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/app/data/ffp.db

# 仅数据库目录需要写权限，避免在 N1 的 U 盘上递归 chown 全部依赖。
RUN mkdir -p /app/data && chown node:node /app/data
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
