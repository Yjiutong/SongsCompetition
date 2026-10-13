// Worker 入口：
//  - /ws?room=XXX        -> 升级为 WebSocket，交给对应房间的 Durable Object（并登记房间索引）
//  - /state?room=XXX      -> 返回房间当前状态（轮询回退 / 初始加载；?reg=1 时登记房间索引）
//  - /api/netease?url=... -> 抓取网易云歌单的歌曲名与歌手（服务端代抓，前端无跨域问题）
//  - /api/library         -> 返回当前预制曲库（公开，客户端曲库弹窗从这里拉取；未播种则从 library.json 播种）
//  - /admin               -> 管理员后台页面（静态资源 admin.html）
//  - /admin/api/ping      -> 后台自检（需 ADMIN_TOKEN）
//  - /admin/api/rooms     -> 列出所有房间（需 ADMIN_TOKEN）
//  - /admin/api/rooms/:name           -> 某房间详情（需 ADMIN_TOKEN）
//  - /admin/api/rooms/:name/action     -> 对房间执行管理操作（需 ADMIN_TOKEN）
//    支持 remove_song / remove_participant / clear_songs / reset / wipe / notice，
//    以及 delete（删除房间：清空该实例全部存储并从索引注销，仅无人在线时可删）
//  - /admin/api/library                -> 读取全局预制曲库（需 ADMIN_TOKEN）
//  - /admin/api/library/action         -> 编辑预制曲库 / 恢复默认（需 ADMIN_TOKEN）
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

// 从房间索引注销（后台删除房间用；失败不影响删除本身）
async function unregisterRoom(env, name) {
  if (!name) return;
  await callDO(env, INDEX_NAME, "/__index/unregister", postBody({ name }));
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

// 预制曲库：从索引实例读当前曲库；从未播种时从静态资产 library.json 播种并写回
async function serveLibrary(env, url) {
  const stored = await callDO(env, INDEX_NAME, "/__index/library");
  if (stored && Array.isArray(stored.groups) && stored.data && typeof stored.data === "object") {
    return { groups: stored.groups, data: stored.data };
  }
  const seed = await loadSeed(env, url);
  await callDO(env, INDEX_NAME, "/__index/library/action", postBody({ action: "set", payload: seed }));
  return seed;
}

// 默认曲库种子（public/library.json）。资产取不到时退化为空壳，保证接口可用。
async function loadSeed(env, url) {
  try {
    const res = await env.ASSETS.fetch(new URL("/library.json", url.origin));
    if (res.ok) {
      const j = await res.json();
      if (j && Array.isArray(j.groups) && j.data) return j;
    }
  } catch {
    // 资产不可用就用空壳
  }
  return { groups: ["虚拟歌姬", "作者"], data: {} };
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

/* ===== 网易云歌单导入 =====
 * 只抓取「歌曲名 + 歌手名」：公开歌单无需登录即可读取，
 * 服务端代抓也省掉前端跨域问题。支持各种形式的分享链接或纯数字 ID。
 */
const NE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const NE_HEADERS = { "user-agent": NE_UA, referer: "https://music.163.com/" };
const NE_MAX_SONGS = 300; // 单次导入上限，够淘汰赛用了

// 从分享链接里解析歌单 ID：
//   https://music.163.com/playlist?id=123 / https://music.163.com/playlist/123/?userid=45
//   https://y.music.163.com/m/playlist?id=123 / https://music.163.com/#/playlist?id=123
function parsePlaylistId(input) {
  const s = String(input || "").trim();
  if (!s) return null;
  if (/^\d{3,12}$/.test(s)) return s; // 纯 ID
  let m = s.match(/[?&]id=(\d{3,12})/);
  if (m) return m[1];
  m = s.match(/playlist\/(\d{3,12})/);
  if (m) return m[1];
  m = s.match(/(?:^|\/)(\d{3,12})(?:[/?#]|$)/);
  if (m) return m[1];
  return null;
}

function trackToSong(t) {
  const title = String((t && t.name) || "").trim();
  if (!title) return null;
  const artists = (t.artists || t.ar || []).map((a) => a && a.name).filter(Boolean);
  return { title: title.slice(0, 80), artist: artists.join(" / ").slice(0, 80) };
}

async function fetchNeteasePlaylist(input) {
  const id = parsePlaylistId(input);
  if (!id) return { ok: false, error: "无法识别歌单链接：请粘贴网易云歌单分享链接或纯数字 ID" };

  let detail = null;
  try {
    const res = await fetch("https://music.163.com/api/playlist/detail?id=" + id, {
      headers: NE_HEADERS,
    });
    detail = await res.json();
  } catch (e) {
    return { ok: false, error: "抓取失败：" + String((e && e.message) || e) };
  }

  const result = (detail && detail.result) || null;
  const tracks = (result && result.tracks) || [];
  const trackIds = (result && result.trackIds) || [];
  if (!result || (tracks.length === 0 && trackIds.length === 0)) {
    return { ok: false, error: "歌单不存在、未公开或链接已失效" };
  }

  let songs = tracks.map(trackToSong).filter(Boolean);
  // 大歌单的 tracks 可能被截断：按 trackIds 分批补全（每批 50 首）
  const have = new Set(tracks.map((t) => t.id));
  const missing = trackIds.map((x) => x.id).filter((x) => !have.has(x));
  const budget = NE_MAX_SONGS - songs.length;
  for (let i = 0; i < missing.length && i < budget; i += 50) {
    const chunk = missing.slice(i, i + 50);
    try {
      const c = encodeURIComponent(JSON.stringify(chunk.map((x) => ({ id: x }))));
      const res = await fetch("https://music.163.com/api/v3/song/detail?c=" + c, {
        headers: NE_HEADERS,
      });
      const j = await res.json();
      for (const t of j.songs || []) {
        const song = trackToSong(t);
        if (song) songs.push(song);
      }
    } catch {
      break; // 补全失败就用已抓到的部分
    }
  }

  // 去重 + 截断到上限
  const seen = new Set();
  const out = [];
  for (const s of songs) {
    const key = (s.title + "|" + s.artist).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= NE_MAX_SONGS) break;
  }
  return { ok: true, id, name: String(result.name || "歌单 " + id).slice(0, 60), count: out.length, songs: out };
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

  // —— 网易云歌单导入（无需登录，只取歌曲名与歌手）——
  if (p === "/api/netease") {
    if (request.method !== "GET") return json({ error: "Method Not Allowed" }, 405);
    return json(await fetchNeteasePlaylist(url.searchParams.get("url") || ""));
  }

  // —— 预制曲库（公开读取，供客户端曲库弹窗使用）——
  if (p === "/api/library") {
    if (request.method !== "GET") return json({ error: "Method Not Allowed" }, 405);
    return json(await serveLibrary(env, url), 200);
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
        // 删除房间：清空该 DO 实例的全部存储（含 alarm）并从索引注销。
        // 门槛是「无人在线」——在线数以 DO 内的实时状态为准，后台列表可能是几分钟前的旧数据。
        // 极小竞争窗口（读到 0 人到执行清理之间有人进房）可接受：进房者的连接会被
        // 断开，重新进入即得到全新空房间。
        if (action === "delete") {
          const view = await callDO(env, name, "/__admin/view", postBody({ name }));
          const online =
            view && typeof view.onlineCount === "number"
              ? view.onlineCount
              : view && Array.isArray(view.participants)
                ? view.participants.filter((p) => p && p.online).length
                : 0;
          if (online > 0) {
            return json({ ok: false, msg: "房间内还有 " + online + " 名在线玩家，暂不能删除" }, 400);
          }
          // 运行时没有「从代码删除 DO 实例」的 API（namespace 上没有 delete），
          // 由 DO 自己清空全部存储，效果等同删除实例：列表消失、同名房间重建为空。
          try {
            await callDO(env, name, "/__admin/delete", postBody({ name }));
          } catch (e) {
            return json({ ok: false, msg: "清理房间数据失败：" + String((e && e.message) || e) }, 500);
          }
          await unregisterRoom(env, name);
          return json({ ok: true, msg: "已删除房间" }, 200);
        }
        const res = await callDO(env, name, "/__admin/act", postBody({ name, action, payload }));
        return json(res, res && res.ok ? 200 : 400);
      }
      if (request.method === "GET") {
        return json(await callDO(env, name, "/__admin/view", postBody({ name })), 200);
      }
      return json({ error: "Method Not Allowed" }, 405);
    }
    // 预制曲库：后台读取与编辑（全局，持久化在索引实例）
    if (p === "/admin/api/library") {
      if (request.method !== "GET") return json({ error: "Method Not Allowed" }, 405);
      return json(await serveLibrary(env, url), 200);
    }
    if (p === "/admin/api/library/action") {
      if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
      let body = {};
      try {
        body = await request.json();
      } catch {
        body = {};
      }
      const { action, payload } = body;
      // 恢复默认：先清空存储，再重新播种 library.json
      if (action === "reset") {
        await callDO(env, INDEX_NAME, "/__index/library/action", postBody({ action: "reset" }));
        const seed = await loadSeed(env, url);
        await callDO(env, INDEX_NAME, "/__index/library/action", postBody({ action: "set", payload: seed }));
        return json({ ok: true, ...seed }, 200);
      }
      const res = await callDO(env, INDEX_NAME, "/__index/library/action", postBody({ action, payload: payload || {} }));
      return json(res, res && res.ok ? 200 : 400);
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
