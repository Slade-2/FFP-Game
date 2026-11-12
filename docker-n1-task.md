# N1 Docker 部署进度

- [x] 预检 SSH、Docker、CPU、USB 挂载、空间和内存。
- [x] 从 `codex/fixbug` 创建 `codex/docker-n1`。
- [x] 创建 Dockerfile、.dockerignore 和 docker-compose.yml。
- [x] rsync 工作目录到 N1 USB 盘。
- [x] 在 N1 原生构建镜像；早期失败与最终成功的日志均保留在 USB。
- [x] 验证健康接口、首页、60 秒持续运行和服务日志。
- [x] 确认重启策略、host 网络、环境变量及数据库卷。
- [x] 从 Mac 验证局域网访问并记录交付结果。

预检记录：`ssh n1` 指向 `192.168.0.145:11511`，N1 为 `aarch64`；Docker client/server 29.6.1，Root Dir `/overlay/upper/opt/docker`。`/overlay` 为 USB `/dev/sda3` ext4，28.0G 可用 27.9G；eMMC 是 `/dev/mmcblk1`，未用作 Docker Root。内存约 1.98GB，available 1.70GB，无 swap。119GB USB 盘未出现。

停点：N1 原本缺少 `rsync`，通过系统配置的 `apk` 软件源安装 3.5.1-r1 后同步成功。首次 `docker build -t ffp-game:latest .` 343 秒失败，构建容器无法解析 `deb.debian.org`，日志为 `/overlay/ffp-game-build-first.log`。第二次仅添加 `--network host`，Debian 软件包下载和编译工具安装成功，但在 `Step 4/18 : COPY package.json package-lock.json ./` 长时间无进展；观察到内核反复出现 overlayfs 上下层复用警告，未证实其就是卡住的根因。第二次在 2152 秒后发 SIGINT 终止，日志为 `/overlay/ffp-game-build.log`。因构建尝试已达两次，本轮停止，镜像、容器及局域网验证均未完成。

收尾：Mac 本地 `npm run build` 通过；清理了首次失败构建留下的临时容器。N1 仍无 `ffp-game:latest` 镜像和正式容器。

## 本轮修复与停点

- [x] 将配置、镜像、卷、容器和 `docker info` 备份到 USB `/overlay/ffp-docker-backup.MgBcAP`。
- [x] 停止 Docker 后将旧目录完整复制到 USB `/overlay/docker`，rsync 耗时 388 秒；内容与元数据校验差异 0 行。旧目录保留。
- [x] 仅通过 UCI `dockerd.globals.data_root` 切换数据目录并启动 Docker；新 Root Dir `/overlay/docker`，基础镜像可见。
- [x] 同一最小构建 193 秒成功，诊断轮 300 秒超时；迁移后未见新增的三种 overlayfs 警告。
- [x] 正式构建尝试一次，`npm ci`、服务端与前端编译、`npm prune --omit=dev` 均成功；在运行阶段 `COPY --from=build /app/node_modules ./node_modules` 超过六分钟没有日志进展，按用户停点发送 SIGINT，耗时 2333 秒、退出码 130。日志在备份目录的 `ffp-build.after.log`。
- [ ] 未生成 `ffp-game:latest`；按要求停止，容器验证、正式部署、Mac 局域网验证均未执行。

## 修复轮 2：单阶段构建与部署（2026-11-08/09）

- [x] `Dockerfile` 改成 `node:22-bookworm-slim` 单阶段：保留构建、运行和健康检查配置，去掉跨阶段 `COPY`，在 `npm prune --omit=dev` 后清理 npm cache。首次单阶段构建在递归 `chown -R /app` 停滞，20 分钟没有新日志后按规则终止（2004 秒，退出码 130）；据数据库代码确认只需写 `/app/data`，将命令改为 `chown node:node /app/data`。
- [x] N1 重试 `docker build --network host -t ffp-game:latest .` 成功，耗时 2089 秒（34 分 49 秒），日志 `/overlay/ffp-docker-backup.MgBcAP/ffp-build-single-retry.log`。镜像 `linux/arm64`，ID `sha256:dcf7268bf916614a38d8e8f305d04daabc161cbdf2b46dc684ddc3d7997fe7d5`，`docker image ls` 显示 964MB。
- [x] N1 临时 `docker run` 验证：健康接口返回 HTTP 200 与 `{"ok":true}`，首页 HTTP 200，运行超过 60 秒，日志有 `FFP-Game listening on http://0.0.0.0:3000`，健康状态最终为 `healthy`。临时容器和临时命名卷已清理。
- [x] 先按原 compose bridge 端口映射启动：N1 本地接口正常，Mac 连接 `192.168.0.145:3000` 被拒绝，日志 `/overlay/ffp-docker-backup.MgBcAP/compose-up.log`。随后将 `docker-compose.yml` 改为 `network_mode: host`，移除 `ports`；重建日志 `/overlay/ffp-docker-backup.MgBcAP/compose-up-host.log`，配置展开记录 `compose-config-host.log`。
- [x] host 网络下 N1 本地接口正常，但 Mac 仍被拒绝。核实 N1 `phy0-sta0` 属于防火墙 `home` 区，入站默认为 REJECT，已有规则只允许 80、443、11511。将原 `/etc/config/firewall` 备份到 USB `/overlay/ffp-docker-backup.MgBcAP/firewall.before-ffp`，仅新增 `firewall.ffp_game` 规则允许 `192.168.0.0/24` 到 N1 的 TCP 3000；`fw4 check` 通过并 reload，检查与 reload 输出分别保存为 `firewall-ffp-check.log` 和 `firewall-ffp-reload.log`。其中已有 `docker_nat.extra` 和 `passwall2.reload` 的 fw4 提示未处理。
- [x] Mac 最终访问 `http://192.168.0.145:3000/api/health` 返回 HTTP 200 与 `{"ok":true}`；首页 HTTP 200。正式 `ffp-game` 为 `running`、`healthy`、重启次数 0，host 网络、`unless-stopped`；卷 `ffp-game_ffp-data` 位于 USB `/overlay/docker/volumes/ffp-game_ffp-data/_data`，SQLite 数据库已建立。
- [x] 生产依赖审计告警仅记录，不更新：`body-parser` 2.3.0 high（GHSA-27r3-jxmh-p828）、`qs` 6.16.0 moderate（GHSA-6pq8-jhm2-2vcw）、`source-map-js` 1.2.1 high（GHSA-68fv-2mgg-jv7q）。构建日志确认为 3 项（1 moderate、2 high）。
- [x] 用同一镜像运行隔离的临时容器，主动抛出 `Error: FFP log probe`：退出码 1，`docker logs` 显示错误及 Node 堆栈；日志保存在 USB `log-probe-run.log` 和 `log-probe-docker.log`，临时容器已删除。
- [ ] 未做建房、加机器人、打一局的游戏冒烟测试；留待下一轮。未发生真实应用故障，已验证人为异常退出的日志链路。

提交状态：仍在 `codex/docker-n1`；未 commit、push、merge 或建 PR。`agent.md` 已修改；`.dockerignore`、`Dockerfile`、`docker-compose.yml`、本文件未跟踪。旧 Docker 数据目录和备份原样保留。
