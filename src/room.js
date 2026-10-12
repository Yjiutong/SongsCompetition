// Room Durable Object —— 每个房间一个实例，负责：
//  1) 收集阶段：所有人共同往歌单里加歌
//  2) 淘汰赛阶段：点击「开始」(需偶数首) 后，每轮「二选一」逐轮筛除，
//     直到每个人只剩一首歌即结束；每轮实时向所有人公布各自的选择
//  3) 通过 Hibernatable WebSocket 向房间内所有人实时广播最新状态

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  // 读取（必要时初始化）房间状态
  async getState() {
    let s = await this.state.storage.get("state");
    if (!s) {
      s = {
        songs: [], // [{id,title,artist,addedBy}]
        phase: "collecting", // collecting | playing | finished
        currentRound: 0,
        totalRounds: 0,
        roundComplete: false,
        emptySince: null, // 最后一位在线者离开的时间戳；用于空闲清理
        participants: {}, // id -> {id,name,online,inGame,survivors,picks,champion}
      };
      await this.state.storage.put("state", s);
    }
    return s;
  }

  // ===== 空闲清理：房间内 30 分钟无人在线则清除歌单缓存 =====
  EVICT_AFTER_MS = 30 * 60 * 1000;

  anyOnline(s) {
    return Object.values(s.participants).some((p) => p && p.online);
  }
  cancelEviction() {
    try { this.state.storage.deleteAlarm(); } catch {}
  }
  scheduleEviction(s) {
    const fireAt = (s.emptySince ?? Date.now()) + this.EVICT_AFTER_MS;
    try { this.state.storage.setAlarm(fireAt); } catch {}
  }

  // 根据某参与者的幸存歌曲列表，算出本轮的所有「二选一」对阵
  // 歌曲数为奇数时，最后一个视为「轮空」(b = null) 自动晋级
  computePairs(survivors) {
    const pairs = [];
    for (let i = 0; i < survivors.length; i += 2) {
      if (i + 1 < survivors.length) pairs.push({ a: survivors[i], b: survivors[i + 1] });
      else pairs.push({ a: survivors[i], b: null }); // 轮空
    }
    return pairs;
  }

  // 计算从头淘汰到只剩一首所需的轮数
  computeTotalRounds(n) {
    let r = 0;
    while (n > 1) {
      n = Math.ceil(n / 2);
      r++;
    }
    return r;
  }

  // 判断某个参与者是否已经完成了本轮所有「非轮空」对阵的选择
  hasPickedAll(s, p) {
    const pairs = this.computePairs(p.survivors);
    return pairs.every((pr, idx) => pr.b === null || p.picks[idx] != null);
  }

  // 对外公开的状态（参与者脱敏为数组，并附上本轮对阵）
  publicView(s) {
    const inGame = Object.values(s.participants).filter((p) => p.inGame);
    const participants = Object.values(s.participants).map((p) => {
      const base = { id: p.id, name: p.name, online: p.online, inGame: p.inGame };
      if (s.phase === "playing" && p.inGame) {
        const pairs = this.computePairs(p.survivors).map((pr, idx) => ({
          a: pr.a,
          b: pr.b,
          pick: p.picks[idx] != null ? p.picks[idx] : null,
        }));
        base.pairs = pairs;
        base.survivorCount = p.survivors.length;
      }
      if (s.phase === "finished" && p.inGame) {
        base.champion = p.champion || null;
      }
      return base;
    });
    return {
      phase: s.phase,
      currentRound: s.currentRound,
      totalRounds: s.totalRounds,
      roundComplete: s.roundComplete,
      songs: s.songs,
      inGameCount: inGame.length,
      participants,
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
    this.cancelEviction(); // 有连接打开 = 房间非空，取消空闲清理
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
      // 客户端首次上报身份（id 用于跨刷新保持身份）
      const id =
        msg.id && typeof msg.id === "string" && msg.id.length <= 64
          ? msg.id
          : crypto.randomUUID();
      const name = String(msg.name || "匿名用户").slice(0, 24);
      ws.serializeAttachment({ id, name });
      const existing = s.participants[id];
      if (!existing) {
        // 收集阶段加入 = 参赛；游戏中/已结束加入 = 旁观，等下一局
        const inGame = s.phase === "collecting";
        s.participants[id] = {
          id,
          name,
          online: true,
          inGame,
          survivors: [],
          picks: {},
          champion: null,
        };
      } else {
        existing.name = name;
        existing.online = true;
        // 已在房间的老用户，若处于收集阶段且之前是旁观，则转为参赛
        if (s.phase === "collecting") existing.inGame = true;
      }
      s.emptySince = null; // 有人在线，取消空闲清理计时
      this.cancelEviction();
      changed = true;
    } else if (att.id && s.participants[att.id]) {
      const me = s.participants[att.id];

      if (msg.type === "add_song" && s.phase === "collecting") {
        const title = String(msg.title || "").trim().slice(0, 80);
        const artist = String(msg.artist || "").trim().slice(0, 80);
        if (title) {
          s.songs.push({ id: crypto.randomUUID(), title, artist, addedBy: att.id });
          changed = true;
        }
      } else if (msg.type === "remove_song" && s.phase === "collecting") {
        s.songs = s.songs.filter((x) => x.id !== msg.songId);
        changed = true;
      } else if (msg.type === "clear_songs" && s.phase === "collecting") {
        s.songs = [];
        changed = true;
      } else if (msg.type === "rename") {
        const name = String(msg.name || "").trim().slice(0, 24);
        if (name) {
          me.name = name;
          changed = true;
        }
      } else if (msg.type === "start" && s.phase === "collecting") {
        // 必须偶数首且至少 2 首才能开始
        if (s.songs.length >= 2 && s.songs.length % 2 === 0) {
          const ids = s.songs.map((x) => x.id);
          // 洗牌，让对阵更随机公平
          for (let i = ids.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [ids[i], ids[j]] = [ids[j], ids[i]];
          }
          for (const p of Object.values(s.participants)) {
            if (p.inGame) {
              p.survivors = ids.slice();
              p.picks = {};
              p.champion = null;
            }
          }
          s.phase = "playing";
          s.currentRound = 0;
          s.totalRounds = this.computeTotalRounds(ids.length);
          s.roundComplete = false;
          changed = true;
        }
      } else if (msg.type === "choose" && s.phase === "playing" && me.inGame) {
        const pairs = this.computePairs(me.survivors);
        const idx = Number(msg.pairIndex);
        const pr = pairs[idx];
        if (pr && pr.b !== null) {
          const pick = String(msg.songId || "");
          if (pick === pr.a || pick === pr.b) {
            me.picks[idx] = pick;
            changed = true;
            // 检查是否全员已完成本轮选择
            const inGame = Object.values(s.participants).filter((p) => p.inGame);
            s.roundComplete = inGame.length > 0 && inGame.every((p) => this.hasPickedAll(s, p));
          }
        }
      } else if (msg.type === "next_round" && s.phase === "playing" && s.roundComplete) {
        // 本回合全员选完，进入下一轮筛除
        for (const p of Object.values(s.participants)) {
          if (!p.inGame) continue;
          const pairs = this.computePairs(p.survivors);
          const next = [];
          pairs.forEach((pr, idx) => {
            if (pr.b === null) next.push(pr.a); // 轮空自动晋级
            else next.push(p.picks[idx] != null ? p.picks[idx] : pr.a);
          });
          p.survivors = next;
          p.picks = {};
        }
        s.currentRound += 1;
        const inGame = Object.values(s.participants).filter((p) => p.inGame);
        const allOne = inGame.length > 0 && inGame.every((p) => p.survivors.length === 1);
        if (allOne || s.currentRound >= s.totalRounds) {
          s.phase = "finished";
          for (const p of inGame) p.champion = p.survivors[0] || null;
        } else {
          s.roundComplete = false;
        }
        changed = true;
      } else if (msg.type === "reset") {
        // 回到收集阶段，保留歌单，清空战绩，准备下一局
        s.phase = "collecting";
        s.currentRound = 0;
        s.totalRounds = 0;
        s.roundComplete = false;
        for (const p of Object.values(s.participants)) {
          p.inGame = true;
          p.survivors = [];
          p.picks = {};
          p.champion = null;
        }
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
      const me = s.participants[att.id];
      if (me) {
        me.online = false;
        if (!this.anyOnline(s)) {
          // 最后一人离开：记下时间，30 分钟后若仍无人则清除歌单缓存
          if (s.emptySince == null) s.emptySince = Date.now();
          this.scheduleEviction(s);
        }
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

  // Durable Object Alarm：到时间后检查是否仍空房，是则清除歌单缓存
  async alarm() {
    const s = await this.getState();
    if (this.anyOnline(s)) {
      s.emptySince = null;
      this.cancelEviction(); // 有人回来了，撤销清理
      await this.state.storage.put("state", s);
      return;
    }
    const deadline = (s.emptySince ?? Date.now()) + this.EVICT_AFTER_MS;
    if (Date.now() >= deadline) {
      // 30 分钟无人在线：清除歌单缓存并重置对局（保留离线参与者记录）
      s.songs = [];
      s.phase = "collecting";
      s.currentRound = 0;
      s.totalRounds = 0;
      s.roundComplete = false;
      for (const p of Object.values(s.participants)) {
        p.inGame = true;
        p.survivors = [];
        p.picks = {};
        p.champion = null;
      }
      s.emptySince = null;
      this.cancelEviction();
      await this.state.storage.put("state", s);
      await this.broadcast(s);
    } else {
      this.scheduleEviction(s); // 还没到时间，按原 deadline 重新排期
    }
  }
}
