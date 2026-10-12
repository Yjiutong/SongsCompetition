// Room Durable Object —— 每个房间一个实例，负责：
//  1) 持有歌单与每位参与者的选歌（持久化在 DO storage）
//  2) 通过 Hibernatable WebSocket 与所有在线客户端保持长连接
//  3) 任意变更后向房间内所有人实时广播最新状态

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  // 读取（必要时初始化）房间状态
  async getState() {
    let s = await this.state.storage.get("state");
    if (!s) {
      s = { songs: [], participants: {} };
      await this.state.storage.put("state", s);
    }
    return s;
  }

  // 对外公开的状态（参与者脱敏为数组）
  publicView(s) {
    return {
      songs: s.songs,
      participants: Object.values(s.participants).map((p) => ({
        id: p.id,
        name: p.name,
        picks: p.picks,
        online: p.online,
      })),
    };
  }

  // 向房间内所有 WebSocket 客户端广播
  async broadcast(s) {
    const payload = JSON.stringify({ type: "state", state: this.publicView(s) });
    const socks = this.state.getWebSockets();
    for (const ws of socks) {
      try {
        ws.send(payload);
      } catch {
        // 忽略已失效的连接
      }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const upgrade = request.headers.get("Upgrade");

    // —— WebSocket 升级：建立实时通道 ——
    if (upgrade && upgrade.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // —— HTTP GET /state：轮询回退 & 初始加载 ——
    if (request.method === "GET" || request.method === "HEAD") {
      const s = await this.getState();
      return new Response(JSON.stringify(this.publicView(s)), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    return new Response("Method Not Allowed", { status: 405 });
  }

  // 新连接建立后立即把当前状态推给它
  async webSocketOpen(ws) {
    const s = await this.getState();
    try {
      ws.send(JSON.stringify({ type: "state", state: this.publicView(s) }));
    } catch {
      // ignore
    }
  }

  async webSocketMessage(ws, data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    const s = await this.getState();
    const att = ws.deserializeAttachment() || {};
    let changed = false;

    if (msg.type === "hello") {
      // 客户端首次上报身份（id 用于跨刷新保持选歌）
      const id =
        msg.id && typeof msg.id === "string" && msg.id.length <= 64
          ? msg.id
          : crypto.randomUUID();
      const name = String(msg.name || "匿名用户").slice(0, 24);
      ws.serializeAttachment({ id, name });
      s.participants[id] = s.participants[id] || { id, name, picks: [], online: true };
      s.participants[id].name = name;
      s.participants[id].online = true;
      changed = true;
    } else if (att.id && s.participants[att.id]) {
      const me = s.participants[att.id];

      if (msg.type === "add_song") {
        const title = String(msg.title || "").trim().slice(0, 80);
        const artist = String(msg.artist || "").trim().slice(0, 80);
        if (title) {
          s.songs.push({ id: crypto.randomUUID(), title, artist, addedBy: att.id });
          changed = true;
        }
      } else if (msg.type === "pick") {
        // 只接受歌单中真实存在的歌曲 id
        const valid = new Set(s.songs.map((x) => x.id));
        const ids = Array.isArray(msg.songIds)
          ? msg.songIds.filter((x) => valid.has(x)).slice(0, 100)
          : [];
        me.picks = ids;
        changed = true;
      } else if (msg.type === "rename") {
        const name = String(msg.name || "").trim().slice(0, 24);
        if (name) {
          me.name = name;
          changed = true;
        }
      } else if (msg.type === "remove_song") {
        s.songs = s.songs.filter((x) => x.id !== msg.songId);
        for (const p of Object.values(s.participants)) {
          p.picks = p.picks.filter((x) => x !== msg.songId);
        }
        changed = true;
      } else if (msg.type === "clear_songs") {
        s.songs = [];
        for (const p of Object.values(s.participants)) p.picks = [];
        changed = true;
      }
    }

    if (changed) {
      await this.state.storage.put("state", s);
      await this.broadcast(s);
    }
  }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment() || {};
    if (att.id) {
      const s = await this.getState();
      if (s.participants[att.id]) {
        s.participants[att.id].online = false;
        await this.state.storage.put("state", s);
        await this.broadcast(s);
      }
    }
    try {
      ws.close();
    } catch {
      // ignore
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }
}
