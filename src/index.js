// Worker 入口：
//  - /ws?room=XXX        -> 升级为 WebSocket，交给对应房间的 Durable Object
//  - /state?room=XXX      -> 返回房间当前状态（轮询回退 / 初始加载）
//  - /admin               -> 管理员后台页面（静态资源 admin.html）
//  - /admin/api/rooms     -> 列出所有房间（需 ADMIN_TOKEN）
//  - /admin/api/rooms/:name           -> 某房间详情（需 ADMIN_TOKEN）
//  - /admin/api/rooms/:name/action     -> 对房间执行管理操作（需 ADMIN_TOKEN）
//  - 其它路径            -> 由 Workers Static Assets 提供静态文件（public/）

import { Room } from "./room.js";

export { Room };

// 校验管理员令牌：支持 Authorization: Bearer <token> 或 ?token=...
function adminAuthorized(request, env) {
  if (!env.ADMIN_TOKEN) return false; // 未配置令牌则后台永久关闭
  const h = request.headers.get("authorization") || "";
  if (h.toLowerCase().startsWith("bearer ")) return h.slice(7) === env.ADMIN_TOKEN;
  const q = new URL(request.url).searchParams.get("token");
  if (q) return q === env.ADMIN_TOKEN;
  return false;
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// 枚举所有房间（Durable Object 命名空间列表），逐个取摘要
async function listRooms(env) {
  const out = [];
  let cursor;
  do {
    const r = await env.ROOM.list({ limit: 1000, cursor });
    const objs = r.objects || r.results || [];
    for (const o of objs) {
      const name = o.name;
      if (!name) continue; // 跳过无名实例
      try {
        const stub = env.ROOM.get(o.id);
        out.push(await stub.adminView(name));
      } catch {
        // 个别实例异常不影响整体列表
      }
    }
    cursor = r.cursor;
  } while (cursor);
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    // —— 实时通道 / 状态轮询 ——
    if (p === "/ws" || p === "/state") {
      const room = url.searchParams.get("room");
      if (!room) return json({ error: "缺少 room 参数" }, 400);
      const id = env.ROOM.idFromName(room);
      return env.ROOM.get(id).fetch(request);
    }

    // —— 管理员后台页面（外壳无需鉴权，数据接口才鉴权）——
    if (p === "/admin" || p === "/admin/") {
      const asset = await env.ASSETS.fetch(new URL("/admin.html", url.origin));
      const headers = new Headers(asset.headers);
      headers.set("Cache-Control", "no-cache");
      return new Response(asset.body, {
        status: asset.status,
        statusText: asset.statusText,
        headers,
      });
    }

    // —— 管理员 API ——
    if (p.startsWith("/admin/api/")) {
      if (!adminAuthorized(request, env)) {
        return json(
          { error: "未授权：请在 Cloudflare 配置 ADMIN_TOKEN 后用令牌访问后台" },
          403,
        );
      }
      // 房间列表
      if (p === "/admin/api/rooms") {
        if (request.method !== "GET") return json({ error: "Method Not Allowed" }, 405);
        return json(await listRooms(env), 200);
      }
      // 房间详情 / 操作
      const m = p.match(/^\/admin\/api\/rooms\/([^/]+)(\/action)?$/);
      if (m) {
        const name = decodeURIComponent(m[1]);
        const stub = env.ROOM.get(env.ROOM.idFromName(name));
        if (m[2] === "/action") {
          if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
          let body = {};
          try {
            body = await request.json();
          } catch {
            body = {};
          }
          const { action, ...payload } = body;
          const res = await stub.adminAction(name, action, payload);
          return json(res, res.ok ? 200 : 400);
        }
        if (request.method === "GET") {
          return json(await stub.adminView(name), 200);
        }
        return json({ error: "Method Not Allowed" }, 405);
      }
      return json({ error: "Not Found" }, 404);
    }

    // —— 静态资源（页面资源关闭强缓存，确保发布后生效）——
    const assetResp = await env.ASSETS.fetch(request);
    const isPageAsset =
      p === "/" ||
      p.endsWith("/") ||
      /\.(html?|js|css|json|map|svg|png|jpg|jpeg|gif|webp|ico|woff2?)$/i.test(p);
    if (isPageAsset) {
      const headers = new Headers(assetResp.headers);
      headers.set("Cache-Control", "no-cache");
      return new Response(assetResp.body, {
        status: assetResp.status,
        statusText: assetResp.statusText,
        headers,
      });
    }
    return assetResp;
  },
};
