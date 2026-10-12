# 共享歌单 · 多人实时点歌

输入房间号即可进入一个共享歌单：多人一起添加歌曲，每个人在歌单里挑选自己喜欢的，所有人的选择**实时公示**。后端完全运行在 Cloudflare 上，无需自建服务器。

> 原单机版「歌曲淘汰赛」保留在 [`legacy/SongsCompetition.html`](legacy/SongsCompetition.html) 仅供对照，不参与部署。

## 功能特性

- **房间号即歌单**：相同房间号的人进入同一个歌单，把链接/房间号发给朋友即可一起玩。
- **共同添加歌单**：任意成员可添加歌曲（歌名 + 歌手），实时同步给房间内所有人。
- **各自选歌**：在共享歌单里点「选 / 已选」切换自己的选择（可多选）。
- **实时公示**：右侧「大家的选择」面板实时显示每位参与者选了哪些歌，按选歌数量排序，在线状态用绿点标识。
- **实时更新**：基于 Cloudflare Durable Object 的 Hibernatable WebSocket，状态变更秒级广播；WebSocket 断线时自动回退 HTTP 轮询。
- **零运维**：纯静态前端 + 一个 Worker，数据存在 Cloudflare 边缘，免费额度足够小中型聚会使用。

## 技术架构（纯 Cloudflare）

```
浏览器(静态前端)  ──HTTP/WebSocket──►  Worker(src/index.js)
                                          │ 按 room 路由
                                          ▼
                                    Durable Object(Room, src/room.js)
                                      • 持久化歌单 + 每人选歌
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
2. 在「添加歌曲」处提交歌名（可填歌手），歌曲会出现在共享歌单并同步给所有人。
3. 在歌单里点「选」即可把该歌加入你的选择，再点一次取消；右侧面板实时显示大家的选择。
4. 点「复制邀请链接」把带房间号的链接发给朋友，对方打开后输入昵称即可加入同一房间。
5. 刷新页面会凭本地身份保持你的选择与昵称。

## 数据与隐私

- 房间数据（歌单、各人昵称与选择）仅保存在对应房间的 Durable Object 中，按房间号隔离。
- 本应用不接入任何第三方服务，数据不出 Cloudflare。
- 房间号即访问凭证：知道房间号即可读写该房间，请勿在公开场合泄露私密房间号。

## 常见问题

- **WebSocket 不可用时还能用吗？** 能。客户端在 WebSocket 断开后会每 4 秒通过 `/state` 轮询一次，保证状态最终一致（仅实时性略降）。
- **想每人只选 1 首 / 先各自选再统一揭晓？** 当前为多选实时公示；如需改为单选或隐藏他人选择，调整 `src/room.js` 中 `pick` 逻辑即可。
- **本地 `wrangler dev` 起不来？** 多为本机缺少 `workerd` 原生运行时或网络受限，不影响 Cloudflare 云端部署。
