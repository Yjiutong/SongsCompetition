// Room Durable Object —— 每个房间一个实例，负责：
//  1) 收集阶段：所有人共同往歌单里加歌；非房主可「准备」（准备后不能加歌）；
//     房主确认开始（准备人数不足 2/3 会警告，房主可强制开始），歌曲需为偶数
//  2) 淘汰赛阶段：开始后每轮「二选一」逐轮筛除，直到每个人只剩一首歌：
//     - 单轮限时：超时未选的对阵随机晋级并自动进入下一轮；在线玩家全部选完即提前结束本轮
//     - 离线玩家不阻塞轮次；回归后可连续选择，逐轮追赶进度
//     - 每轮选择可设为公开/隐藏（房主随时切换），最终角逐出的歌曲永远公开
//  3) 通过 Hibernatable WebSocket 实时广播；Alarm 同时驱动「轮次截止」与「空闲清理」

// 内部接口用的 JSON 响应 / 请求体解析（供 Worker 调用 DO 的内部接口使用）
function jsonRes(data) {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
async function bodyJson(request) {
  try {
    return (await request.json()) || {};
  } catch {
    return {};
  }
}

// 单轮限时的可选值（毫秒）；0 = 不限时
const ROUND_DURATIONS = [30000, 60000, 90000, 120000, 0];

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
        currentRound: 0, // 共享轮次索引（0 起）
        totalRounds: 0, // 从初始歌曲数推算的总轮数
        roundComplete: false, // 所有在线参赛者已完成当前共享轮
        roundDuration: 60000, // 单轮限时（毫秒），0 = 不限时
        roundEndsAt: null, // 当前轮截止时间戳（毫秒）
        revealPicks: true, // 每轮选择是否对其他人公开
        hostId: null, // 房主 = 第一个进入房间的人
        joinSeq: 0, // 加入顺序计数器（用于房主移交时取最早加入者）
        notice: null, // 管理员广播的通知
        lastEvent: null, // 最近一次系统事件（超时/结算/房主移交等）
        emptySince: null, // 最后一位在线者离开的时间戳；用于空闲清理
        participants: {}, // id -> {id,name,online,inGame,ready,joinedAt,progress,survivors,picks,champion}
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

  // Alarm 只有一个槽位，轮次截止与空闲清理共用：取更近的时间点排期
  scheduleAlarm(s) {
    const now = Date.now();
    let at = null;
    if (s.emptySince != null) at = (s.emptySince ?? now) + this.EVICT_AFTER_MS;
    if (
      s.phase === "playing" &&
      s.roundDuration > 0 &&
      s.roundEndsAt &&
      !s.roundComplete &&
      s.currentRound < s.totalRounds
    ) {
      if (at == null || s.roundEndsAt < at) at = s.roundEndsAt;
    }
    try {
      if (at != null) this.state.storage.setAlarm(at);
      else this.state.storage.deleteAlarm();
    } catch {}
  }

  // 根据某参与者的幸存歌曲列表，算出本轮的所有「二选一」对阵。
  // 纯函数（无随机）：同样的幸存列表永远得到同样的对阵，
  // 因此离线玩家回归后可以按历史选择逐轮重放、追赶进度。
  // 歌曲数为奇数时，最后一个视为「轮空」(b = null) 自动晋级
  computePairs(survivors) {
    const pairs = [];
    const list = survivors || [];
    for (let i = 0; i < list.length; i += 2) {
      if (i + 1 < list.length) pairs.push({ a: list[i], b: list[i + 1] });
      else pairs.push({ a: list[i], b: null }); // 轮空
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

  // 某位玩家当前轮（= 其个人进度 progress 对应的那一轮）的对阵
  pairsOf(p) {
    return this.computePairs(p.survivors);
  }

  // 该玩家是否已完成当前轮的所有「非轮空」对阵的选择
  roundDoneFor(p) {
    return this.pairsOf(p).every((pr, i) => pr.b === null || p.picks[i] != null);
  }

  // 把当前轮的选择结算成新的幸存列表（未选的兜底取 a，正常流程不会触发）
  settleRound(p) {
    const next = [];
    this.pairsOf(p).forEach((pr, i) => {
      if (pr.b === null) next.push(pr.a); // 轮空自动晋级
      else next.push(p.picks[i] != null ? p.picks[i] : pr.a);
    });
    p.survivors = next;
    p.picks = [];
  }

  // 玩家完成当前轮：结算并推进其个人进度
  advancePlayer(p) {
    this.settleRound(p);
    p.progress += 1;
  }

  // 随机补齐某玩家当前轮未选的对阵（超时 / 强制结算用）
  autoFillRound(p) {
    let filled = false;
    this.pairsOf(p).forEach((pr, i) => {
      if (pr.b !== null && p.picks[i] == null) {
        p.picks[i] = Math.random() < 0.5 ? pr.a : pr.b;
        filled = true;
      }
    });
    return filled;
  }

  // 从当前轮开始一路随机打到结束（房主强制结算用）
  autoFinishPlayer(s, p) {
    while (p.progress < s.totalRounds) {
      this.autoFillRound(p);
      this.advancePlayer(p);
    }
    p.champion = p.survivors[0] || null;
  }

  // 重新计算共享轮完成状态：落后追赶者选完立即推进，并判断是否全员角逐结束。
  // 返回是否有状态变化（供调用方决定是否落盘广播）。
  // 语义：同步玩家（progress === currentRound）选完后原地等待，由房主点击下一轮
  //       或超时统一结算推进——保证「本轮所有人的选择」始终是同一轮的数据。
  refreshRoundState(s) {
    if (s.phase !== "playing") return false;
    let changed = false;
    const active = Object.values(s.participants).filter((p) => p.inGame);
    // 落后追赶者：选完当前轮立即结算推进（可连续选择逐轮追上）
    for (const p of active) {
      if (p.progress < s.currentRound && this.roundDoneFor(p)) {
        this.advancePlayer(p);
        changed = true;
      }
    }
    // 共享轮完成：只看「正处于当前轮」的在线玩家；落后追赶者与离线玩家都不阻塞
    const onRound = active.filter((p) => p.online && p.progress >= s.currentRound);
    const rc = onRound.length > 0 && onRound.every((p) => this.roundDoneFor(p));
    if (rc !== s.roundComplete) {
      s.roundComplete = rc;
      changed = true;
    }
    if (s.roundComplete) s.roundEndsAt = null; // 本轮已无需计时
    if (active.length > 0 && active.every((p) => p.progress >= s.totalRounds)) {
      this.finishGame(s);
      changed = true;
    }
    return changed;
  }

  finishGame(s) {
    s.phase = "finished";
    s.roundEndsAt = null;
    for (const p of Object.values(s.participants)) {
      if (p.inGame && p.champion == null) p.champion = p.survivors[0] || null;
    }
  }

  // 房主确认后进入下一轮：结算已完成上一轮的玩家（幸存列表推进到新轮次）
  advanceRound(s) {
    const prev = s.currentRound;
    s.currentRound = prev + 1;
    s.roundComplete = false;
    for (const p of Object.values(s.participants)) {
      // 已完成上一轮的同步玩家在此结算；没选完的（离线/超时未补）落后，后续追赶
      if (p.inGame && p.progress === prev && this.roundDoneFor(p)) {
        this.advancePlayer(p);
      }
    }
    if (s.currentRound >= s.totalRounds) {
      // 同步玩家已全部角逐完：等待落后玩家追赶，或由房主强制结算
      s.roundEndsAt = null;
    } else if (s.roundDuration > 0) {
      s.roundEndsAt = Date.now() + s.roundDuration;
    } else {
      s.roundEndsAt = null;
    }
    this.refreshRoundState(s);
  }

  // 单轮超时：在线但未选完的参赛者，未选对阵随机晋级，然后自动进入下一轮。
  // 离线玩家的未选对阵保留原样，回归后逐轮追赶。
  timeoutRound(s) {
    let touched = false;
    for (const p of Object.values(s.participants)) {
      if (!p.inGame || !p.online || p.progress !== s.currentRound) continue;
      if (this.autoFillRound(p)) touched = true;
    }
    s.roundEndsAt = null;
    s.lastEvent = "第 " + (s.currentRound + 1) + " 轮超时，未选对阵已随机晋级";
    if (touched) this.refreshRoundState(s);
    // 超时即结束当前轮：直接推进（若刚好全员结束则上面已 finishGame）
    if (s.phase === "playing" && s.currentRound < s.totalRounds) {
      this.advanceRound(s);
    }
  }

  // 对外公开的状态。viewerId 为当前观看着（WebSocket 连接身份 / ?viewer=）；
  // 隐藏模式下，其他人未公开的选择不下发，只标记 hidden。
  publicView(s, viewerId) {
    const active = Object.values(s.participants).filter((p) => p.inGame);
    const hidePicks = s.phase === "playing" && !s.revealPicks;
    const participants = Object.values(s.participants).map((p) => {
      const base = {
        id: p.id,
        name: p.name,
        online: p.online,
        inGame: p.inGame,
        ready: !!p.ready,
        playerRound: p.progress, // 该玩家当前所处的轮（落后于共享轮时正在追赶）
        behind: p.inGame && s.phase === "playing" && p.progress < s.currentRound,
        survivorCount: (p.survivors || []).length,
      };
      if (s.phase === "playing" && p.inGame) {
        const mine = p.id === viewerId;
        base.pairs = this.pairsOf(p).map((pr, i) => {
          const pick = p.picks[i] != null ? p.picks[i] : null;
          const hidden = hidePicks && !mine && pick != null;
          return { a: pr.a, b: pr.b, pick: hidden ? null : pick, hidden };
        });
      }
      // 已角逐出最终歌曲（或全场结束）→ 永远公开
      if (
        p.inGame &&
        (s.phase === "finished" ||
          (s.phase === "playing" && s.totalRounds > 0 && p.progress >= s.totalRounds))
      ) {
        base.champion = p.champion != null ? p.champion : p.survivors[0] || null;
      }
      return base;
    });
    return {
      phase: s.phase,
      notice: s.notice || null,
      lastEvent: s.lastEvent || null,
      currentRound: s.currentRound,
      totalRounds: s.totalRounds,
      roundComplete: s.roundComplete,
      roundDuration: s.roundDuration,
      roundEndsAt: s.roundEndsAt || null,
      serverNow: Date.now(),
      revealPicks: !!s.revealPicks,
      hostId: s.hostId || null,
      // 收集阶段需要歌手/添加者信息；对局中只需要歌名（减小广播体积）
      songs:
        s.phase === "collecting"
          ? s.songs
          : s.songs.map((x) => ({ id: x.id, title: x.title })),
      inGameCount: active.length,
      readyCount: active.filter((p) => p.ready || p.id === s.hostId).length,
      pendingCount:
        s.phase === "playing" ? active.filter((p) => p.progress < s.totalRounds).length : 0,
      participants,
    };
  }

  // ===== 管理员视图 / 操作（由 Worker 的 /admin/api 调用）=====
  songTitle(id, s) {
    const x = s.songs.find((y) => y.id === id);
    return x ? (x.artist ? `${x.title} - ${x.artist}` : x.title) : id;
  }

  // 管理员后台看的房间摘要：参与者、歌单、阶段、计数
  async adminView(name) {
    const s = await this.getState();
    const participants = Object.values(s.participants).map((p) => ({
      id: p.id,
      name: p.name,
      online: p.online,
      inGame: p.inGame,
      ready: !!p.ready,
      host: p.id === s.hostId,
      playerRound: p.progress,
      behind: p.inGame && s.phase === "playing" && p.progress < s.currentRound,
      survivors: (p.survivors || []).length,
      champion: p.champion ? this.songTitle(p.champion, s) : null,
    }));
    const songs = s.songs.map((x) => ({
      id: x.id,
      title: x.title,
      artist: x.artist,
      addedBy: x.addedBy,
    }));
    return {
      name,
      phase: s.phase,
      notice: s.notice || null,
      lastEvent: s.lastEvent || null,
      currentRound: s.currentRound,
      totalRounds: s.totalRounds,
      roundComplete: s.roundComplete,
      roundDuration: s.roundDuration,
      roundEndsAt: s.roundEndsAt || null,
      revealPicks: !!s.revealPicks,
      hostId: s.hostId || null,
      songCount: songs.length,
      onlineCount: participants.filter((p) => p.online).length,
      participantCount: participants.length,
      songs,
      participants,
    };
  }

  // 管理员对房间执行的操作：移除歌曲 / 移除参与者 / 清空歌单 / 重置 / 彻底清空 / 广播通知
  async adminAction(name, action, payload = {}) {
    const s = await this.getState();
    let ok = true;
    let msg = "ok";

    const purgeSurvivors = (songId) => {
      for (const p of Object.values(s.participants)) {
        if (!p.inGame) continue;
        p.survivors = (p.survivors || []).filter((x) => x !== songId);
        p.picks = []; // 对阵结构变了，本轮选择作废重选
      }
    };
    const transferHostIfNeeded = (leaverId) => {
      if (s.hostId !== leaverId) return;
      const next = Object.values(s.participants)
        .filter((p) => p.online && p.id !== leaverId)
        .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0))[0];
      if (next) {
        s.hostId = next.id;
        s.lastEvent = next.name + " 成为新房主";
      }
    };

    switch (action) {
      case "remove_song": {
        const id = payload.songId;
        if (!id || !s.songs.some((x) => x.id === id)) {
          ok = false;
          msg = "歌曲不存在";
          break;
        }
        s.songs = s.songs.filter((x) => x.id !== id);
        purgeSurvivors(id); // 同步从每个人的幸存列表/选择里剔除
        if (s.phase === "playing") this.refreshRoundState(s);
        break;
      }
      case "remove_participant": {
        const pid = payload.pid;
        if (!pid || !s.participants[pid]) {
          ok = false;
          msg = "参与者不存在";
          break;
        }
        delete s.participants[pid];
        transferHostIfNeeded(pid);
        if (s.phase === "playing") this.refreshRoundState(s);
        break;
      }
      case "clear_songs": {
        // 清空歌单并回到收集阶段，保留参与者
        s.songs = [];
        s.phase = "collecting";
        s.currentRound = 0;
        s.totalRounds = 0;
        s.roundComplete = false;
        s.roundEndsAt = null;
        s.lastEvent = null;
        for (const p of Object.values(s.participants)) {
          p.inGame = true;
          p.ready = false;
          p.progress = 0;
          p.survivors = [];
          p.picks = [];
          p.champion = null;
        }
        break;
      }
      case "reset": {
        // 保留歌单，回到收集阶段，清空战绩（与客户端「再来一局」一致）
        s.phase = "collecting";
        s.currentRound = 0;
        s.totalRounds = 0;
        s.roundComplete = false;
        s.roundEndsAt = null;
        s.lastEvent = null;
        for (const p of Object.values(s.participants)) {
          p.inGame = true;
          p.ready = false;
          p.progress = 0;
          p.survivors = [];
          p.picks = [];
          p.champion = null;
        }
        break;
      }
      case "wipe": {
        // 彻底清空整个房间（含参与者与歌单）
        s.songs = [];
        s.phase = "collecting";
        s.currentRound = 0;
        s.totalRounds = 0;
        s.roundComplete = false;
        s.roundEndsAt = null;
        s.participants = {};
        s.hostId = null;
        s.emptySince = null;
        s.notice = null;
        s.lastEvent = null;
        break;
      }
      case "notice": {
        s.notice = String(payload.text || "").slice(0, 200) || null;
        break;
      }
      default:
        ok = false;
        msg = "未知操作";
    }

    if (ok) {
      await this.state.storage.put("state", s);
      this.scheduleAlarm(s);
      await this.broadcast(s); // 实时推送给房间内所有人
    }
    return { ok, msg };
  }

  // 向房间内所有 WebSocket 客户端广播。
  // 隐藏模式下按观看者身份分别序列化，避免把别人未公开的选择发出去。
  async broadcast(s) {
    const socks = this.state.getWebSockets();
    if (socks.length === 0) return;
    const perViewer = s.phase === "playing" && !s.revealPicks;
    let payload = null;
    if (!perViewer) payload = JSON.stringify({ type: "state", state: this.publicView(s) });
    for (const ws of socks) {
      try {
        const data = perViewer
          ? JSON.stringify({
              type: "state",
              state: this.publicView(s, (ws.deserializeAttachment() || {}).id),
            })
          : payload;
        ws.send(data);
      } catch {
        // 忽略已失效的连接
      }
    }
  }

  // 给单个连接回消息（错误提示 / 开始前的警告等）
  sendTo(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      // ignore
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

    // —— 内部接口：只由 Worker 内部调用（外部请求到不了这里，Worker 只转发 /ws 与 /state）——
    // 之所以走 HTTP 而不是 RPC：Room 是普通类（未 extends DurableObject），RPC 调不通。
    if (url.pathname === "/__admin/view" && (request.method === "GET" || request.method === "POST")) {
      const name = url.searchParams.get("name") || (await bodyJson(request)).name || "";
      return jsonRes(await this.adminView(name));
    }
    if (url.pathname === "/__admin/act" && request.method === "POST") {
      const b = await bodyJson(request);
      return jsonRes(await this.adminAction(b.name || "", b.action, b.payload || {}));
    }
    if (url.pathname === "/__index/register" && request.method === "POST") {
      const b = await bodyJson(request);
      return jsonRes(await this.registerRoom(b.name || ""));
    }
    if (url.pathname === "/__index/list") {
      return jsonRes(await this.listRooms());
    }
    // 预制曲库（全局，存在索引实例里）：后台可编辑，客户端拉取
    if (url.pathname === "/__index/library" && request.method === "GET") {
      return jsonRes((await this.getLibrary()) || {});
    }
    if (url.pathname === "/__index/library/action" && request.method === "POST") {
      const b = await bodyJson(request);
      return jsonRes(await this.libraryAction(b.action || "", b.payload || {}));
    }

    // —— HTTP GET /state：轮询回退 & 初始加载（?viewer= 传入自己的 id，隐藏模式下才看得到自己的选择）——
    if (request.method === "GET" || request.method === "HEAD") {
      const s = await this.getState();
      return jsonRes(this.publicView(s, url.searchParams.get("viewer") || null));
    }

    return new Response("Method Not Allowed", { status: 405 });
  }

  // ===== 房间索引（仅供保留实例 __rooms_index__ 使用）=====
  // Workers 运行时的 DurableObjectNamespace 没有 list()，无法枚举房间；
  // 因此每次有人进入房间时，Worker 会把房间名登记到这个索引实例里，供管理后台列出。
  async registerRoom(name) {
    if (!name) return { ok: false, msg: "缺少房间名" };
    const idx = (await this.state.storage.get("index")) || {};
    const now = Date.now();
    // 顺手清理 7 天没出现过的房间名，避免索引无限膨胀
    for (const k of Object.keys(idx)) {
      if (now - (idx[k] || 0) > 7 * 24 * 60 * 60 * 1000) delete idx[k];
    }
    const prev = idx[name] || 0;
    // 5 分钟内已登记过就不再写盘（同一房间的轮询/重连不会造成写放大）
    if (now - prev < 5 * 60 * 1000) return { ok: true, cached: true };
    idx[name] = now;
    await this.state.storage.put("index", idx);
    return { ok: true, count: Object.keys(idx).length };
  }

  async listRooms() {
    const idx = (await this.state.storage.get("index")) || {};
    const rooms = Object.entries(idx).map(([name, lastSeen]) => ({ name, lastSeen }));
    rooms.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    return { rooms };
  }

  // ===== 预制曲库（仅供保留实例 __rooms_index__ 使用）=====
  // 管理员在后台增删改的「全局预设曲库」，持久化在索引实例的 storage["library"] 里。
  // 客户端打开曲库弹窗时从 Worker 的 /api/library 拉取，而非读取前端静态文件，
  // 这样后台的改动能实时同步给所有房间。格式：{ groups:[分类名], data:{ 分类:{ 条目名:[歌名] } } }
  async getLibrary() {
    const lib = await this.state.storage.get("library");
    if (lib && Array.isArray(lib.groups) && lib.data && typeof lib.data === "object") return lib;
    return null; // 未播种：由 Worker 从 library.json 资产播种
  }

  // 校验并整体写入曲库（用于 set / reset 后回写）
  async setLibrary(lib) {
    if (!lib || typeof lib !== "object" || !Array.isArray(lib.groups) || typeof lib.data !== "object") {
      return { ok: false, msg: "曲库格式不正确" };
    }
    const data = {};
    for (const g of lib.groups) data[g] = lib.data[g] || {};
    await this.state.storage.put("library", { groups: lib.groups.slice(), data });
    return { ok: true };
  }

  // 单条增删改操作；返回 { ok, msg? }
  async libraryAction(action, payload = {}) {
    const norm = (s) => String(s == null ? "" : s).trim();
    let lib = await this.getLibrary();
    if (!lib) lib = { groups: [], data: {} }; // 尚未播种也允许后台直接编辑（会先建空壳）
    const groups = lib.groups.slice();
    const data = {};
    // 统一成 { 分类: { 条目: [歌名] } }；容错：缺条目时补空对象
    for (const g of groups) {
      const raw = lib.data[g];
      data[g] = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    }

    switch (action) {
      case "add_group": {
        const g = norm(payload.group);
        if (!g) return { ok: false, msg: "分类名不能为空" };
        if (groups.includes(g)) return { ok: false, msg: "分类已存在" };
        groups.push(g);
        data[g] = {};
        break;
      }
      case "rename_group": {
        const from = norm(payload.from);
        const to = norm(payload.to);
        if (!from || !to) return { ok: false, msg: "分类名不能为空" };
        const i = groups.indexOf(from);
        if (i < 0) return { ok: false, msg: "分类不存在" };
        if (from !== to && groups.includes(to)) return { ok: false, msg: "目标分类已存在" };
        groups[i] = to;
        data[to] = data[from] || {};
        delete data[from];
        break;
      }
      case "remove_group": {
        const g = norm(payload.group);
        const i = groups.indexOf(g);
        if (i < 0) return { ok: false, msg: "分类不存在" };
        groups.splice(i, 1);
        delete data[g];
        break;
      }
      case "add_entry": {
        const g = norm(payload.group);
        const n = norm(payload.name);
        if (!g || !n) return { ok: false, msg: "分类与名称不能为空" };
        if (!groups.includes(g)) groups.push(g);
        data[g] = data[g] || {};
        if (!data[g][n]) data[g][n] = [];
        break;
      }
      case "rename_entry": {
        const g = norm(payload.group);
        const from = norm(payload.from);
        const to = norm(payload.to);
        if (!g || !from || !to) return { ok: false, msg: "分类/旧名/新名不能为空" };
        if (!data[g] || !data[g][from]) return { ok: false, msg: "条目不存在" };
        data[g][to] = data[g][from];
        delete data[g][from];
        break;
      }
      case "remove_entry": {
        const g = norm(payload.group);
        const n = norm(payload.name);
        if (data[g]) delete data[g][n];
        break;
      }
      case "add_song": {
        const g = norm(payload.group);
        const n = norm(payload.name);
        const t = norm(payload.title);
        if (!g || !n || !t) return { ok: false, msg: "分类 / 名称 / 歌名不能为空" };
        data[g] = data[g] || {};
        data[g][n] = data[g][n] || [];
        if (data[g][n].includes(t)) return { ok: false, msg: "这首歌已经在曲库里了" };
        data[g][n].push(t);
        break;
      }
      case "edit_song": {
        const g = norm(payload.group);
        const n = norm(payload.name);
        const from = norm(payload.from);
        const to = norm(payload.to);
        if (!g || !n || !from || !to) return { ok: false, msg: "参数不完整" };
        if (!data[g] || !data[g][n]) return { ok: false, msg: "条目不存在" };
        const i = data[g][n].indexOf(from);
        if (i < 0) return { ok: false, msg: "原歌名不存在" };
        if (to !== from && data[g][n].includes(to)) return { ok: false, msg: "新歌名已存在" };
        data[g][n][i] = to;
        break;
      }
      case "remove_song": {
        const g = norm(payload.group);
        const n = norm(payload.name);
        const t = norm(payload.title);
        if (data[g] && data[g][n]) data[g][n] = data[g][n].filter((x) => x !== t);
        break;
      }
      case "set": {
        // 整库替换（payload 为 {groups,data}）
        const r = await this.setLibrary(payload);
        if (!r.ok) return r;
        return { ok: true };
      }
      case "reset": {
        // 清空后由 Worker 重新播种默认曲库
        await this.state.storage.delete("library");
        return { ok: true, reseeded: false };
      }
      default:
        return { ok: false, msg: "未知操作：" + action };
    }
    await this.state.storage.put("library", { groups, data });
    return { ok: true };
  }

  // 新连接建立后立即把当前状态推给它（尚未上报身份，按陌生人过滤隐藏项）
  async webSocketOpen(ws) {
    const s = await this.getState();
    if (s.emptySince != null) {
      s.emptySince = null; // 有连接打开 = 房间非空
      await this.state.storage.put("state", s);
    }
    this.scheduleAlarm(s);
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
        s.joinSeq = (s.joinSeq || 0) + 1;
        s.participants[id] = {
          id,
          name,
          online: true,
          inGame: s.phase === "collecting",
          ready: false,
          joinedAt: s.joinSeq,
          progress: 0,
          survivors: [],
          picks: [],
          champion: null,
        };
      } else {
        existing.name = name;
        existing.online = true;
        // 已在房间的老用户，若处于收集阶段且之前是旁观，则转为参赛
        if (s.phase === "collecting") existing.inGame = true;
      }
      // 没有房主时（新房 / 房主被清理），先进来的人就是房主
      if (!s.hostId) s.hostId = id;
      s.emptySince = null; // 有人在线，取消空闲清理计时
      changed = true;
    } else if (att.id && s.participants[att.id]) {
      const me = s.participants[att.id];
      const isHost = att.id === s.hostId;

      if (msg.type === "rename") {
        const name = String(msg.name || "").trim().slice(0, 24);
        if (name) {
          me.name = name;
          changed = true;
        }
      } else if (msg.type === "ready" && s.phase === "collecting" && me.inGame) {
        // 准备 / 取消准备：准备后的玩家不能再添加歌曲
        me.ready = !me.ready;
        changed = true;
      } else if (msg.type === "add_song" && s.phase === "collecting") {
        if (me.ready) {
          this.sendTo(ws, { type: "error", message: "你已准备，不能添加歌曲（取消准备后即可）" });
        } else {
          const title = String(msg.title || "").trim().slice(0, 80);
          const artist = String(msg.artist || "").trim().slice(0, 80);
          if (title) {
            s.songs.push({ id: crypto.randomUUID(), title, artist, addedBy: att.id });
            changed = true;
          }
        }
      } else if (msg.type === "import_songs" && s.phase === "collecting") {
        // 批量导入（网易云歌单）：与房单里去重
        if (me.ready) {
          this.sendTo(ws, { type: "error", message: "你已准备，不能添加歌曲（取消准备后即可）" });
        } else {
          const list = Array.isArray(msg.songs) ? msg.songs.slice(0, 100) : [];
          const seen = new Set(s.songs.map((x) => (x.title + "|" + x.artist).toLowerCase()));
          let added = 0;
          let skipped = 0;
          for (const it of list) {
            const title = String((it && it.title) || "").trim().slice(0, 80);
            const artist = String((it && it.artist) || "").trim().slice(0, 80);
            if (!title) continue;
            const key = (title + "|" + artist).toLowerCase();
            if (seen.has(key)) {
              skipped++;
              continue;
            }
            seen.add(key);
            s.songs.push({ id: crypto.randomUUID(), title, artist, addedBy: att.id });
            added++;
          }
          if (added > 0) changed = true;
          this.sendTo(ws, { type: "imported", added, skipped });
        }
      } else if (msg.type === "remove_song" && s.phase === "collecting") {
        s.songs = s.songs.filter((x) => x.id !== msg.songId);
        changed = true;
      } else if (msg.type === "clear_songs" && s.phase === "collecting") {
        s.songs = [];
        changed = true;
      } else if (msg.type === "set_duration" && s.phase === "collecting") {
        if (!isHost) {
          this.sendTo(ws, { type: "error", message: "只有房主可以设置单轮时长" });
        } else {
          const d = Number(msg.duration);
          if (ROUND_DURATIONS.indexOf(d) >= 0) {
            s.roundDuration = d;
            changed = true;
          }
        }
      } else if (msg.type === "set_reveal") {
        // 每轮选择公开/隐藏：房主可随时切换（对下一帧广播生效）
        if (!isHost) {
          this.sendTo(ws, { type: "error", message: "只有房主可以切换公开/隐藏" });
        } else {
          s.revealPicks = !!msg.value;
          changed = true;
        }
      } else if (msg.type === "start" && s.phase === "collecting") {
        if (!isHost) {
          this.sendTo(ws, { type: "error", message: "只有房主可以开始游戏" });
        } else if (s.songs.length < 2 || s.songs.length % 2 !== 0) {
          this.sendTo(ws, { type: "error", message: "歌曲数量需为偶数且至少 2 首才能开始" });
        } else {
          const active = Object.values(s.participants).filter((p) => p.inGame);
          const readyCount = active.filter((p) => p.ready || p.id === s.hostId).length;
          const need = Math.ceil((active.length * 2) / 3);
          if (!msg.force && readyCount < need) {
            // 准备不足 2/3：只警告，房主确认后可带 force 重发
            this.sendTo(ws, {
              type: "warning",
              action: "start",
              message:
                "仅 " + readyCount + " / " + active.length + " 人准备（不足 2/3），确定强行开始吗？",
            });
          } else {
            const ids = s.songs.map((x) => x.id);
            // 洗牌，让对阵更随机公平（所有人的对阵保持一致，便于横向比较）
            for (let i = ids.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [ids[i], ids[j]] = [ids[j], ids[i]];
            }
            for (const p of Object.values(s.participants)) {
              if (!p.inGame) continue;
              p.survivors = ids.slice();
              p.picks = [];
              p.progress = 0;
              p.champion = null;
              p.ready = false;
            }
            s.phase = "playing";
            s.currentRound = 0;
            s.totalRounds = this.computeTotalRounds(ids.length);
            s.roundComplete = false;
            s.lastEvent = null;
            s.roundEndsAt = s.roundDuration > 0 ? Date.now() + s.roundDuration : null;
            changed = true;
          }
        }
      } else if (msg.type === "choose" && s.phase === "playing" && me.inGame) {
        // 选择永远针对「该玩家自己当前所处的那一轮」：
        // 同步玩家选共享轮；落后玩家在追赶旧轮，可连续选择
        const pairs = this.pairsOf(me);
        const idx = Number(msg.pairIndex);
        const pr = pairs[idx];
        const pick = String(msg.songId || "");
        if (pr && pr.b !== null && (pick === pr.a || pick === pr.b)) {
          me.picks[idx] = pick;
          changed = true;
        }
        // 选完当前轮（或只剩轮空）即结算推进个人进度，并重算共享轮状态
        if (this.refreshRoundState(s)) changed = true;
      } else if (msg.type === "next_round" && s.phase === "playing") {
        if (!isHost) {
          this.sendTo(ws, { type: "error", message: "只有房主可以进入下一轮" });
        } else if (!s.roundComplete) {
          this.sendTo(ws, { type: "error", message: "本轮还有人在选择，稍候" });
        } else if (s.currentRound < s.totalRounds) {
          s.lastEvent = null; // 房主主动开新轮：清掉上一轮的事件提示
          this.advanceRound(s);
          changed = true;
        }
      } else if (msg.type === "force_settle" && s.phase === "playing") {
        // 房主强制结算：还没追赶完的玩家按随机评选出最终歌曲
        if (!isHost) {
          this.sendTo(ws, { type: "error", message: "只有房主可以强制结算" });
        } else {
          for (const p of Object.values(s.participants)) {
            if (p.inGame && p.progress < s.totalRounds) this.autoFinishPlayer(s, p);
          }
          s.lastEvent = "房主强制结算：未追赶完的玩家已随机评选";
          this.refreshRoundState(s);
          changed = true;
        }
      } else if (msg.type === "reset") {
        if (!isHost) {
          this.sendTo(ws, { type: "error", message: "只有房主可以重置对局" });
        } else {
          // 回到收集阶段，保留歌单，清空战绩，准备下一局
          s.phase = "collecting";
          s.currentRound = 0;
          s.totalRounds = 0;
          s.roundComplete = false;
          s.roundEndsAt = null;
          s.lastEvent = null;
          for (const p of Object.values(s.participants)) {
            p.inGame = true;
            p.ready = false;
            p.progress = 0;
            p.survivors = [];
            p.picks = [];
            p.champion = null;
          }
          changed = true;
        }
      }
    }

    if (changed) {
      await this.state.storage.put("state", s);
      this.scheduleAlarm(s);
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
        // 房主掉线：转交给最早加入且仍在线的玩家（无人在线则保持原房主）
        if (s.hostId === att.id) {
          const next = Object.values(s.participants)
            .filter((p) => p.online && p.id !== att.id)
            .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0))[0];
          if (next) {
            s.hostId = next.id;
            s.lastEvent = next.name + " 成为新房主";
          }
        }
        if (!this.anyOnline(s) && s.emptySince == null) {
          // 最后一人离开：记下时间，30 分钟后若仍无人则清除歌单缓存
          s.emptySince = Date.now();
        }
        // 离线玩家不再阻塞当前轮
        this.refreshRoundState(s);
        await this.state.storage.put("state", s);
        this.scheduleAlarm(s);
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

  // Durable Object Alarm：轮次截止 / 空闲清理（共用一个槽位，到点后分别处理）
  async alarm() {
    const s = await this.getState();
    const now = Date.now();
    let changed = false;

    // 1) 单轮限时到点：随机结算未选对阵并自动进入下一轮
    if (
      s.phase === "playing" &&
      s.roundDuration > 0 &&
      s.roundEndsAt &&
      !s.roundComplete &&
      s.currentRound < s.totalRounds &&
      now >= s.roundEndsAt
    ) {
      this.timeoutRound(s);
      changed = true;
    }

    // 2) 空闲清理
    if (this.anyOnline(s)) {
      if (s.emptySince != null) {
        s.emptySince = null;
        changed = true;
      }
    } else {
      const deadline = (s.emptySince ?? now) + this.EVICT_AFTER_MS;
      if (now >= deadline) {
        // 30 分钟无人在线：清除歌单缓存并重置对局（保留离线参与者记录）
        s.songs = [];
        s.phase = "collecting";
        s.currentRound = 0;
        s.totalRounds = 0;
        s.roundComplete = false;
        s.roundEndsAt = null;
        s.lastEvent = null;
        for (const p of Object.values(s.participants)) {
          p.inGame = true;
          p.ready = false;
          p.progress = 0;
          p.survivors = [];
          p.picks = [];
          p.champion = null;
        }
        // 房间已清空重启：房主名额释放，下一个进来的人接任
        s.hostId = null;
        s.emptySince = null;
        changed = true;
      }
    }

    if (changed) {
      await this.state.storage.put("state", s);
      await this.broadcast(s);
    }
    this.scheduleAlarm(s);
  }
}
