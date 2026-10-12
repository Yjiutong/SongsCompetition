# 歌曲淘汰赛 · 多人实时

输入房间号即可进入一个房间：多人一起添加歌单，点「开始」后进入**逐轮二选一淘汰赛**，每轮所有人各自在两组歌里选一首，淘汰到**每人只剩一首**即结束；每一轮都会**实时向所有人公布各自的选择**。后端完全运行在 Cloudflare 上，无需自建服务器。

> 原单机版保留在 [`legacy/SongsCompetition.html`](legacy/SongsCompetition.html) 仅供对照，不参与部署。

## 玩法规则

1. **共同添加歌单**：进入房间后，任意成员可添加歌曲（歌名 + 歌手），实时同步给房间内所有人。
2. **开始淘汰**：歌曲添加完毕后点「开始淘汰赛」。**歌曲数量必须为偶数**（至少 2 首）才能开始；奇数时可再添/删一首。
3. **逐轮二选一**：每一轮把当前存活的歌曲两两配对，每个人在每组里点选一首（奇数首时最后一首「轮空」自动晋级）。
4. **逐轮筛除**：全员完成本轮选择后，点「下一轮」，被淘汰的歌曲出局，存活歌曲进入下一轮继续二选一。
5. **实时公布**：每轮都会把**所有人的选择**实时公示在「本轮所有人的选择」面板，在线状态用绿点标识。
6. **结束**：当每个人只剩一首歌时游戏结束，结束页展示每个人的「最终歌曲」。

## 功能特性

- **房间号即房间**：相同房间号的人进入同一个房间，把链接/房间号发给朋友即可一起玩。
- **收集阶段**：任意成员可添加 / 删除歌曲（仅收集阶段可编辑歌单），实时同步。
- **淘汰赛阶段**：每轮二选一、逐轮筛除，直到每人一首；轮次为偶数首时两两对决，奇数首自动轮空。
- **实时公示**：每轮向所有人公布各自的选择，支持中途查看谁选了哪首。
- **实时更新**：基于 Cloudflare Durable Object 的 Hibernatable WebSocket，状态变更秒级广播；WebSocket 断线时自动回退 HTTP 轮询。
- **缓存清除（网页）**：Worker 对所有页面静态资源（`/`、`index.html`、`app.js`、`style.css` 等）返回 `Cache-Control: no-cache`，发布新版本后浏览器/边缘不会一直用旧脚本；房间内还提供「清除缓存」按钮，一键带时间戳刷新强制拉取最新页面。
- **空闲自动清理（房间）**：某个房间内**最后一人离开后 30 分钟仍无人在线**，Durable Object 会通过 Alarm 自动清除该房间的**歌单缓存**并重置对局，避免空房间长期占用存储；只要 30 分钟内有人回来，清理即被自动取消。
- **零运维**：纯静态前端 + 一个 Worker，数据存在 Cloudflare 边缘，免费额度足够小中型聚会使用。

## 技术架构（纯 Cloudflare）

```
浏览器(静态前端)  ──HTTP/WebSocket──►  Worker(src/index.js)
                                          │ 按 room 路由
                                          ▼
                                    Durable Object(Room, src/room.js)
                                      • 收集阶段持久化共享歌单
                                      • 淘汰赛：逐轮二选一、筛除、记录每人冠军
                                      • 维护房间内 WebSocket 连接
                                      • 任意变更向所有人广播
```

- **前端**：`public/` 下的静态文件，由 Workers Static Assets 直接托管。
- **Worker**（`src/index.js`）：路由 `/ws`（WebSocket 实时通道）与 `/state`（HTTP 轮询回退）到对应房间的 Durable Object，其余路径回退静态资源。
- **Durable Object**（`src/room.js`，类名 `Room`）：每个房间一个实例，持有状态并通过 Hibernatable WebSocket 实时广播。

## 目录结构

```
.
├── wrangler.toml          # Cloudflare 配置（静态资源目录 + Durable Object 绑定）
├── package.json           # 便捷脚本：dev / deploy
├── src/
│   ├── index.js           # Worker 入口 / 路由
│   └── room.js            # Room Durable Object（状态 + 实时广播）
├── public/                # 前端静态资源（部署后即为站点根）
│   ├── index.html
│   ├── style.css
│   └── app.js
└── legacy/
    └── SongsCompetition.html   # 原单机版（不参与部署）
```

## 本地开发（可选）

需要本机装有 `workerd` 运行时（Wrangler 会自动管理）：

```bash
npx wrangler@latest dev      # 启动本地服务，默认 http://localhost:8787
```

## 部署到 Cloudflare（通过 Git 仓库）

本项目以 **Cloudflare Workers + Git 仓库** 方式部署，WebSocket 实时推送在 Worker 上最稳定。

### Cloudflare 后台操作清单

1. 打开 [Cloudflare 控制台](https://dash.cloudflare.com) 并登录（免费计划即可，Durable Object 免费额度足够）。
2. 若用自有域名访问：先在控制台 **添加站点** 并把域名 DNS 改为 Cloudflare 的 NS。仅自测可直接用系统分配的 `*.workers.dev` 子域，跳过此步。
3. 左侧进入 **Workers & Pages**（新版可能直接叫 **Workers**）。
4. 点击 **Create**（创建应用）→ 选择 **Connect to Git**（连接 Git 仓库）。
5. 首次需 **授权 GitHub / GitLab**，并选择已推送本仓库的仓库。
6. 部署配置：
   - **Application name**：`songs-competition`（可自定义）
   - **Production branch**：你的主分支（如 `main`）
   - **Build command**：**留空**（无需构建，静态文件已在 `public/`）
   - **Deploy command**：保持默认 `wrangler deploy`（Cloudflare 会自动读取仓库里的 `wrangler.toml`）
7. 点击 **Deploy**。首次部署会自动执行 `wrangler.toml` 中的 Durable Object migration（`v1`），创建 `Room` 类——**无需手动操作**。
8. 部署完成后控制台给出地址，形如 `https://songs-competition.<你的子域>.workers.dev`。
9. 把该地址（可带 `?room=房间号`）发给朋友，即可多人进入同一房间实时点歌。

### 自定义域名（可选）

在应用详情 **Settings → Triggers / Domains & Routes** 中绑定子域（如 `song.yourdomain.com`）。

### 备选：Cloudflare Pages

若改用 Pages 部署，只需把 `wrangler.toml` 中的：

```toml
[assets]
directory = "public"
```

改为：

```toml
pages_build_output_dir = "public"
```

其余配置与代码不变，在 Pages 的「连接 Git」流程中把 **Build output directory** 设为 `public` 即可。

## 使用说明

1. 打开站点，输入**房间号**与**昵称**进入房间。
2. **收集阶段**：在「添加歌曲」处提交歌名（可填歌手），歌曲会出现在共享歌单并同步给所有人。凑齐偶数首后点「开始淘汰赛」。
3. **淘汰赛阶段**：每轮在「你的对阵」里点击二选一；右侧「本轮所有人的选择」实时显示大家的取舍。全员选完后点「下一轮」继续筛除。
4. 当每人只剩一首时进入结束页，展示每个人的最终歌曲；点「再来一局」可保留歌单重开。
5. 点「复制邀请链接」把带房间号的链接发给朋友，对方打开后输入昵称即可加入同一房间。
6. 刷新页面会凭本地身份保持你的昵称与房间。

## 数据与隐私

- 房间数据（歌单、各人昵称与选择）仅保存在对应房间的 Durable Object 中，按房间号隔离。
- 本应用不接入任何第三方服务，数据不出 Cloudflare。
- 房间号即访问凭证：知道房间号即可读写该房间，请勿在公开场合泄露私密房间号。

## 常见问题

- **WebSocket 不可用时还能用吗？** 能。客户端在 WebSocket 断开后会每 4 秒通过 `/state` 轮询一次，保证状态最终一致（仅实时性略降）。
- **想改规则（如固定 2 的整次幂、隐藏他人选择、限时投票）？** 淘汰赛逻辑都在 `src/room.js`（`start` / `choose` / `next_round` 等消息处理），按需调整即可。
- **轮空是怎么回事？** 当某轮存活歌曲为奇数时，最后一组只有一首歌，它「轮空」自动晋级下一轮，无需选择。
- **本地 `wrangler dev` 起不来？** 多为本机缺少 `workerd` 原生运行时或网络受限，不影响 Cloudflare 云端部署。
