# 歌曲淘汰赛 · 项目长期记忆

## 部署形态
- 纯 Cloudflare：Worker（`src/index.js`）+ 单个 Durable Object 类 `Room`（`src/room.js`）+ 静态资源 `public/`。
- `wrangler.toml`：`name = "songscompetition"`（必须与 Cloudflare Builds 的 CI 名称一致）、`compatibility_date = "2025-06-01"`、`not_found_handling = "single-page-application"`、迁移用 `new_sqlite_classes = ["Room"]`（免费套餐必需，`new_classes` 会报 code:10097）。
- 管理员令牌 `ADMIN_TOKEN` 只放在 Cloudflare Secret（或本地 `.dev.vars`，已 gitignore），**绝不写进 wrangler.toml**。
- 用户从 GitHub（`origin` = github.com/Yjiutong/SongsCompetition）拉取部署；改动需要 commit + push 才生效。

## 用户明确偏好
- **前端不做混淆/压缩**（2026-10-12 用户明确要求取消）：`public/app.js`、`public/admin.js` 必须是未压缩、可直接阅读的源码；不要加防 F12 / 禁右键脚本；`wrangler.toml` 不加 `minify = true`。用户自己要读代码。
- 安全性依靠服务端：游戏规则（对阵生成、选票校验、淘汰判定）全部在 Durable Object 内，前端只是展示层。

## 关键实现要点（易踩坑）
- `DurableObjectNamespace` **没有 `list()`**；`Room` 是普通类不支持 RPC。房间枚举靠保留实例 `__rooms_index__` 登记 + DO 内部 HTTP 路径（`/__admin/view`、`/__admin/act`、`/__index/register`、`/__index/list`）。
- 前端读的是 `publicView().pairs[i].pick`，**不是** `picks[idx]`。
- 房间名以 `__` 开头被拒绝（保留前缀）。
- 30 分钟无人（`EVICT_AFTER_MS`）由 DO Alarm 清空歌单。
- 测试脚本在 `.workbuddy/tmp/`（已 gitignore，不部署）：room / worker / render / admin 四套，共约 100 项断言。
