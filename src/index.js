// Worker 入口：
//  - /ws?room=XXX        -> 升级为 WebSocket，交给对应房间的 Durable Object（并登记房间索引）
//  - /state?room=XXX      -> 返回房间当前状态（轮询回退 / 初始加载；?reg=1 时登记房间索引）
//  - /admin               -> 管理员后台页面（静态资源 admin.html）
//  - /admin/api/ping      -> 后台自检（需 ADMIN_TOKEN）
//  - /admin/api/rooms     -> 列出所有房间（需 ADMIN_TOKEN）
//  - /admin/api/rooms/:name           -> 某房间详情（需 ADMIN_TOKEN）
//  - /admin/api/rooms/:name/action     -> 对房间执行管理操作（需 ADMIN_TOKEN）
//  - 其它路径            -> 由 Workers Static Assets 提供静态文件（public/）

import { Room } from "./room.js";

export { Room };

// 房间索引实例名：用同一个 Room 类的一个保留实例记录「出现过哪些房间」。
// 注意：Workers 运行时的 DurableObjectNamespace 只有 idFromName / newUniqueId /
// idFromString / get / getByName / jurisdiction，**没有 list()**，无法枚举命名空间；
// 所以房间列表改为「进入房间时登记 → 后台读索引」。
const INDEX_NAME = "__rooms_index__";
const INTERNAL = "https://do.internal";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function stubFor(env, name) {
  return env.ROOM.get(env.ROOM.idFromName(name));
}

// 调用某个房间 DO 的内部接口（走 HTTP fetch，而不是 RPC）
async function callDO(env, name, path, init) {
  const res = await stubFor(env, name).fetch(INTERNAL + path, init);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, msg: "房间返回了非 JSON 响应", status: res.status, body: text.slice(0, 200) };
  }
}

function postBody(obj) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(obj),
  };
}

// 登记房间索引（失败不影响正常进出房间）
async function registerRoom(env, name) {
  if (!name) return;
  await callDO(env, INDEX_NAME, "/__index/register", postBody({ name }));
}

// 读取索引里的全部房间名（排除保留名）
async function indexNames(env) {
  const j = await callDO(env, INDEX_NAME, "/__index/list");
  return (j.rooms || []).map((x) => x.name).filter((n) => n && !n.startsWith("__"));
}

// 列表：索引里的每个房间取一份后台摘要（单个房间出错不影响整体）
async function listRooms(env) {
  const names = await indexNames(env);
  const views = await Promise.all(
    names.map(async (n) => {
      try {
        return await callDO(env, n, "/__admin/view", postBody({ name: n }));
      } catch {
        return null;
      }
    }),
  );
  return views.filter(Boolean);
}

// 校验管理员令牌：支持 Authorization: Bearer <token> 或 ?token=...
function adminAuthorized(request, env) {
  if (!env.ADMIN_TOKEN) return false; // 未配置令牌则后台永久关闭
  const h = request.headers.get("authorization") || "";
  if (h.toLowerCase().startsWith("bearer ")) return h.slice(7) === env.ADMIN_TOKEN;
  const q = new URL(request.url).searchParams.get("token");
  if (q) return q === env.ADMIN_TOKEN;
  return false;
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const p = url.pathname;

  // —— 实时通道 / 状态轮询 ——
  if (p === "/ws" || p === "/state") {
    const room = url.searchParams.get("room");
    if (!room) return json({ error: "缺少 room 参数" }, 400);
    // 保留前缀留给内部索引实例，避免和房间名冲突
    if (room.startsWith("__")) return json({ error: "房间名不能以 __ 开头" }, 400);

    // 有人进入房间 → 登记到索引（供管理后台枚举）。失败不影响正常使用。
    const shouldRegister = p === "/ws" || url.searchParams.get("reg") === "1";
    if (shouldRegister) {
      const task = registerRoom(env, room).catch(() => {});
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(task);
      else await task;
    }
    return stubFor(env, room).fetch(request);
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
    // 自检：令牌是否配置、索引是否可用
    if (p === "/admin/api/ping") {
      let indexOk = false;
      let indexErr = null;
      let indexedRooms = 0;
      try {
        const j = await callDO(env, INDEX_NAME, "/__index/list");
        indexedRooms = (j.rooms || []).length;
        indexOk = true;
      } catch (e) {
        indexErr = String((e && e.message) || e);
      }
      return json({ ok: true, tokenConfigured: !!env.ADMIN_TOKEN, indexOk, indexErr, indexedRooms });
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
      if (name.startsWith("__")) return json({ error: "非法房间名" }, 400);
      if (m[2] === "/action") {
        if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
        let body = {};
        try {
          body = await request.json();
        } catch {
          body = {};
        }
        const { action, ...payload } = body;
        const res = await callDO(env, name, "/__admin/act", postBody({ name, action, payload }));
        return json(res, res && res.ok ? 200 : 400);
      }
      if (request.method === "GET") {
        return json(await callDO(env, name, "/__admin/view", postBody({ name })), 200);
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
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (err) {
      // 兜底：任何未预料的异常都返回可读的 JSON，避免后台只看到「HTTP 500」
      const message = (err && err.message) || String(err);
      const stack = String((err && err.stack) || "");
      try {
        console.error("[worker]", message, stack);
      } catch {}
      return json(
        {
          error: "服务端内部错误",
          message,
          hint: "把这条 message 发我即可定位；也可先访问 /admin/api/ping 自检",
          stack: stack.split("\n").slice(0, 6).join("\n"),
        },
        500,
      );
    }
  },
};
