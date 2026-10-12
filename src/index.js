// Worker 入口：
//  - /ws?room=XXX    -> 升级为 WebSocket，交给对应房间的 Durable Object
//  - /state?room=XXX -> 返回房间当前状态（轮询回退 / 初始加载）
//  - 其它路径        -> 由 Workers Static Assets 提供静态文件（public/）

import { Room } from "./room.js";

export { Room };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isApi = url.pathname === "/ws" || url.pathname === "/state";

    if (isApi) {
      const room = url.searchParams.get("room");
      if (!room) {
        return new Response(JSON.stringify({ error: "缺少 room 参数" }), {
          status: 400,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      const id = env.ROOM.idFromName(room);
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }

    // 静态资源（未命中时回退到 index.html，支持纯前端路由）
    return env.ASSETS.fetch(request);
  },
};
