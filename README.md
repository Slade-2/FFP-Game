# 打花 / 打朋友 H5

四人实时纸牌对战。前端为 Vue 3 + Vite，后端为 Node.js + TypeScript + Socket.IO，数据持久化使用 SQLite。

## 本地运行

要求 Node.js 22 或更高版本。

```bash
npm install
npm run dev
```

- H5 开发地址：`http://localhost:5173`
- 测试端地址：`http://localhost:5173/test`
- 服务端：`http://localhost:3000`

同一局域网内测试时，浏览器访问执行 `npm run dev` 的电脑 IP，不要使用 `localhost`。

### 使用管理脚本

首次运行前先安装依赖：

```bash
npm install
./start.sh
```

无参数运行会显示交互菜单，可选择开发模式启动、生产模式启动、停止、重启、查看状态、查看日志或构建。也可以直接执行：

```bash
./start.sh start-dev
./start.sh start-prod
./start.sh stop
./start.sh restart
./start.sh status
./start.sh logs
./start.sh build
```

运行中的 PID、模式和日志保存在 `.ffp-game/` 目录。

## 生产运行

```bash
npm install
npm run build
npm start
```

默认监听 `0.0.0.0:3000`，Express 会同时托管 `dist/client` 静态文件和 Socket.IO。

可用环境变量：

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `3000` | 监听端口 |
| `DB_PATH` | `data/ffp.db` | SQLite 文件路径 |
| `CALL_TIMEOUT_MS` | `60000` | 叫牌超时 |
| `PLAY_TIMEOUT_MS` | `15000` | 出牌超时 |
| `QUICK_PASS_TIMEOUT_MS` | `5000` | 无牌可管时自动过牌超时 |
| `BOT_ACTION_DELAY_MS` | 随机 1000~2000 | 机器人行动延迟 |
| `REMATCH_TIMEOUT_MS` | `30000` | 再来一局投票超时 |

## ZeroTier 部署

1. 在 [ZeroTier](https://www.zerotier.com/) 注册并创建一个 Network，记下 Network ID。
2. 在运行游戏的主机安装 ZeroTier 客户端并加入 Network，然后在 ZeroTier 管理页授权该设备。
3. 主机执行：

   ```bash
   npm install
   npm run build
   npm start
   ```

4. 查看主机 ZeroTier 虚拟 IP：

   ```bash
   ifconfig | grep 'inet '
   ```

   通常形如 `10.147.x.x`。

5. 朋友手机安装 ZeroTier，输入相同 Network ID，主机在管理页授权。
6. 朋友使用手机浏览器打开 `http://10.147.x.x:3000`，输入相同房号即可加入。
7. 主机需要保持在线。若 macOS 防火墙拦截，请在“系统设置 -> 网络 -> 防火墙”中允许 Node 接收入站连接。

## 验证

```bash
npm test
npm run build
```

测试覆盖规则引擎、结算、完整 Socket.IO 对局、打朋友叫牌保密、SQLite 持久化、超时托管、断线重连、测试房机器人和再来一局。

## 服务端权威与保密

- 发牌、牌型校验、叫牌判定、轮次、pass、名次和积分结算全部在服务端执行。
- 客户端只发送 `game:play`、`game:pass`、`game:call` 等操作意图。
- 打朋友叫牌后，被叫牌持有者或 1v3 叫牌者只会收到自己的私有揭示报文；其他玩家不接收该报文。
- 非持有者等到被叫牌真正打出时，客户端才根据公开出牌信息揭示敌友。
- 打朋友结算采用私发报文，只向每位玩家发送自己的积分变化，避免通过公开分数成组反推队友。
- 对局记录按玩家 token 查询；含机器人的对局展示名次和本局分，但不写总分榜与对局记录。

## 主要目录

```text
client/           Vue 3 H5
server/rules.ts   纯规则引擎
server/game.ts    服务端权威对局状态机
server/room.ts    房间、重连、超时托管
server/scoring.ts 打花 / 打朋友结算
server/db.ts      SQLite 持久化
tests/            单元测试与 Socket.IO 集成测试
```
