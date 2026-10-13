// ===== 身份（跨刷新保持）=====
const me = { id: null, name: "" };
let state = { phase: "collecting", songs: [], participants: [] };
let ws = null;
let reconnectTimer = null;
let pollTimer = null;
// 多人同时操作时会连着收到多条广播，用这个标记把它们合并到同一帧只渲染一次
let renderQueued = false;
// 服务端与本地时钟偏差（广播里带 serverNow，用于倒计时显示）
let serverOffset = 0;
let timerTick = null;

function loadIdentity() {
  me.id = localStorage.getItem("sc_id");
  if (!me.id) {
    me.id = (crypto.randomUUID ? crypto.randomUUID() : "u" + Math.random().toString(36).slice(2));
    localStorage.setItem("sc_id", me.id);
  }
  me.name = localStorage.getItem("sc_name") || "";
}
function saveName(n) {
  me.name = n;
  localStorage.setItem("sc_name", n);
}
function getRoom() {
  return new URLSearchParams(location.search).get("room");
}

// ===== 视图切换 =====
function showView(id) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  window.scrollTo(0, 0);
}
function showPhase(id) {
  document.querySelectorAll(".phase").forEach((v) => v.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

// ===== Toast =====
let toastTimer = null;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
}

// ===== 加入房间 =====
function joinRoom() {
  const room = document.getElementById("roomInput").value.trim();
  const name = document.getElementById("nameInput").value.trim();
  if (!room) return toast("请输入房间号");
  if (!name) return toast("请输入昵称");

  saveName(name);
  const newUrl = location.pathname + "?room=" + encodeURIComponent(room);
  history.replaceState(null, "", newUrl);

  document.getElementById("roomId").textContent = room;
  showView("view-room");
  connect();
  startPoll();
}

function leaveRoom() {
  try { ws && ws.close(); } catch {}
  clearTimeout(reconnectTimer);
  clearInterval(pollTimer);
  history.replaceState(null, "", location.pathname);
  showView("view-join");
}

// 清除网页缓存：带时间戳参数强制重新拉取最新页面与静态资源
function clearCache() {
  const sep = location.search ? "&" : "?";
  location.href = location.pathname + location.search + sep + "_cb=" + Date.now();
}

function copyLink() {
  const url = location.origin + location.pathname + "?room=" + encodeURIComponent(getRoom());
  navigator.clipboard.writeText(url).then(
    () => toast("邀请链接已复制"),
    () => toast(url)
  );
}

// ===== 实时连接 =====
function connect() {
  const room = getRoom();
  if (!room) return;
  const proto = location.protocol === "https:" ? "wss://" : "ws://";
  const url = proto + location.host + "/ws?room=" + encodeURIComponent(room);

  try {
    ws = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    setConn(true);
    send({ type: "hello", id: me.id, name: me.name });
  };
  ws.onmessage = (e) => {
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    if (m.type === "state") {
      state = m.state;
      serverOffset = (m.state.serverNow || Date.now()) - Date.now();
      scheduleRender();
    } else if (m.type === "error") {
      toast(m.message || "操作未生效");
    } else if (m.type === "warning") {
      // 服务端的软警告（如准备人数不足）：确认后带 force 重发同一动作
      if (confirm(m.message || "确定继续吗？")) {
        if (m.action === "start") send({ type: "start", force: true });
      }
    } else if (m.type === "imported") {
      toast("已导入 " + m.added + " 首" + (m.skipped ? "（跳过重复 " + m.skipped + " 首）" : ""));
      if (m.added > 0) closeImport();
    }
  };
  ws.onclose = () => {
    setConn(false);
    scheduleReconnect();
  };
  ws.onerror = () => {
    try { ws.close(); } catch {}
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 2000);
}

function setConn(on) {
  const el = document.getElementById("connStatus");
  el.textContent = on ? "实时连接中" : "已断开，重连中…";
  el.className = "conn " + (on ? "conn-on" : "conn-off");
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  } else {
    toast("连接未就绪，稍后重试");
  }
}

// 轮询回退：WebSocket 临时不可用时仍能同步状态
function startPoll() {
  clearInterval(pollTimer);
  let first = true; // 首次轮询顺带把房间登记进索引（供管理后台列出），之后不再带
  pollTimer = setInterval(async () => {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    const room = getRoom();
    if (!room) return;
    try {
      const reg = first ? "&reg=1" : "";
      first = false;
      // viewer=自己的 id：隐藏模式下轮询回退也能看到自己的选择
      const r = await fetch(
        "/state?room=" + encodeURIComponent(room) + reg + "&viewer=" + encodeURIComponent(me.id || "")
      );
      if (r.ok) {
        state = await r.json();
        serverOffset = (state.serverNow || Date.now()) - Date.now();
        scheduleRender();
      }
    } catch {}
  }, 4000);
}

// ===== 操作 =====
function isHost() {
  return !!state.hostId && state.hostId === me.id;
}
function myParticipant() {
  return state.participants.find((p) => p.id === me.id);
}

function addSong() {
  const titleEl = document.getElementById("songTitle");
  const artistEl = document.getElementById("songArtist");
  const title = titleEl.value.trim();
  const artist = artistEl.value.trim();
  if (!title) return toast("请输入歌名");
  send({ type: "add_song", title, artist });
  titleEl.value = "";
  artistEl.value = "";
  titleEl.focus();
}

function addFromLibrary(title, artist) {
  send({ type: "add_song", title, artist });
  toast("已添加：" + title);
}

function removeSong(songId) {
  if (!confirm("从歌单中删除这首歌？")) return;
  send({ type: "remove_song", songId });
}

function clearSongs() {
  if (!confirm("清空整个歌单？")) return;
  send({ type: "clear_songs" });
}

function toggleReady() {
  send({ type: "ready" });
}

function setDuration() {
  send({ type: "set_duration", duration: Number(document.getElementById("durationSel").value) });
}

function setReveal() {
  send({ type: "set_reveal", value: document.getElementById("revealSel").value === "1" });
}

function toggleReveal() {
  send({ type: "set_reveal", value: !state.revealPicks });
}

function startGame() {
  if (state.songs.length < 2) return toast("至少添加 2 首歌");
  if (state.songs.length % 2 !== 0) return toast("歌曲数量必须为偶数才能开始");
  send({ type: "start" }); // 准备不足 2/3 时服务端会回 warning，确认后自动带 force 重发
}

function choosePair(pairIndex, songId) {
  send({ type: "choose", pairIndex, songId });
}

function nextRound() {
  send({ type: "next_round" });
}

function forceSettle() {
  if (!confirm("立即结算？还没追赶完的玩家将按随机评选出最终歌曲。")) return;
  send({ type: "force_settle" });
}

function resetGame() {
  send({ type: "reset" });
}

/* ===== 曲库弹窗 ===== */
let libArtist = null;
let libQuery = "";

function openLibrary() {
  libQuery = "";
  document.getElementById("libSearch").value = "";
  const artists = Object.keys(SONG_LIBRARY);
  libArtist = artists[0] || null;
  document.getElementById("libraryModal").style.display = "flex";
  renderLibrary();
}
function closeLibrary() {
  document.getElementById("libraryModal").style.display = "none";
}

function renderLibrary() {
  libQuery = document.getElementById("libSearch").value.trim().toLowerCase();
  const artists = Object.keys(SONG_LIBRARY);
  const hit = (a) =>
    !libQuery ||
    a.toLowerCase().includes(libQuery) ||
    SONG_LIBRARY[a].some((t) => t.toLowerCase().includes(libQuery));
  const artistHits = artists.filter(hit);

  // 左侧：歌手列表（有命中歌曲才显示）
  const artistBox = document.getElementById("libArtists");
  artistBox.textContent = "";
  for (const a of artistHits) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "lib-artist" + (a === libArtist ? " active" : "");
    item.textContent = a;
    item.onclick = () => {
      libArtist = a;
      renderLibrary();
    };
    artistBox.appendChild(item);
  }
  // 当前选中的歌手没有命中时，切到第一个有命中的歌手
  if (artistHits.indexOf(libArtist) < 0) libArtist = artistHits[0] || null;

  // 右侧：歌曲列表
  const songBox = document.getElementById("libSongs");
  songBox.textContent = "";
  const songs = SONG_LIBRARY[libArtist] || [];
  const shown = libQuery ? songs.filter((t) => t.toLowerCase().includes(libQuery)) : songs;
  if (shown.length === 0) {
    songBox.appendChild(emptyNode("没有匹配的歌曲"));
    return;
  }
  for (const title of shown) {
    const row = document.createElement("div");
    row.className = "lib-song";
    const nm = document.createElement("span");
    nm.className = "lib-song-name";
    nm.textContent = title;
    const plus = document.createElement("button");
    plus.type = "button";
    plus.className = "lib-add";
    plus.textContent = "＋";
    plus.title = "加入歌单";
    plus.onclick = () => addFromLibrary(title, libArtist);
    row.appendChild(nm);
    row.appendChild(plus);
    songBox.appendChild(row);
  }
}

/* ===== 网易云导入弹窗 ===== */
let importData = null; // {name, songs:[{title,artist}]}

function openImport() {
  document.getElementById("importUrl").value = "";
  document.getElementById("importStatus").textContent = "";
  document.getElementById("importPreview").style.display = "none";
  importData = null;
  document.getElementById("importModal").style.display = "flex";
}
function closeImport() {
  document.getElementById("importModal").style.display = "none";
}

async function fetchImport() {
  const url = document.getElementById("importUrl").value.trim();
  if (!url) return toast("请先粘贴网易云歌单链接或 ID");
  const status = document.getElementById("importStatus");
  const btn = document.getElementById("importFetchBtn");
  btn.disabled = true;
  status.textContent = "⏳ 正在抓取歌单…";
  try {
    const r = await fetch("/api/netease?url=" + encodeURIComponent(url));
    const j = await r.json();
    if (!j.ok) {
      status.textContent = "❌ " + (j.error || "抓取失败");
      return;
    }
    importData = j;
    document.getElementById("importName").textContent = "《" + j.name + "》";
    document.getElementById("importCount").textContent = "共 " + j.count + " 首";
    renderImportList();
    document.getElementById("importPreview").style.display = "block";
    status.textContent = "";
  } catch (e) {
    status.textContent = "❌ 网络错误：" + String((e && e.message) || e);
  } finally {
    btn.disabled = false;
  }
}

function renderImportList() {
  const list = document.getElementById("importList");
  list.textContent = "";
  if (!importData) return;
  for (const s of importData.songs) {
    const row = document.createElement("label");
    row.className = "import-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "import-cb";
    cb.checked = true;
    const nm = document.createElement("span");
    nm.className = "import-item-name";
    nm.textContent = s.title;
    const ar = document.createElement("span");
    ar.className = "muted";
    ar.textContent = s.artist || "";
    row.appendChild(cb);
    row.appendChild(nm);
    row.appendChild(ar);
    list.appendChild(row);
  }
}

function importSelectAll(on) {
  document.getElementById("importList").querySelectorAll(".import-cb").forEach((cb) => (cb.checked = on));
}

function confirmImport() {
  if (!importData) return;
  const boxes = document.getElementById("importList").querySelectorAll(".import-cb");
  const picked = [];
  importData.songs.forEach((s, i) => {
    if (boxes[i] && boxes[i].checked) picked.push(s);
  });
  if (picked.length === 0) return toast("还没有选中任何歌曲");
  // 服务端单条消息上限 100 首，分批发送（WebSocket 保序，依次处理）
  for (let i = 0; i < picked.length; i += 100) {
    send({ type: "import_songs", songs: picked.slice(i, i + 100) });
  }
}

// ===== 渲染 =====
function render() {
  try {
    renderInner();
  } catch (err) {
    // 任何渲染异常都不该让界面白屏：打到控制台并提示用户
    console.error("[render error]", err);
    toast("界面渲染出错：" + (err && err.message ? err.message : String(err)));
  }
}

// 同一帧内可能有多条广播到达（多人同时点击时尤其明显），合并成一次渲染
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  const raf = (typeof window !== "undefined" && window.requestAnimationFrame) || ((f) => setTimeout(f, 16));
  raf(() => {
    renderQueued = false;
    render();
  });
}

const PHASES = ["collecting", "playing", "finished"];
let curPhase = null;

function renderInner() {
  const phase = state.phase || "collecting";
  if (PHASES.indexOf(phase) >= 0 && phase !== curPhase) {
    showPhase("phase-" + phase);
    curPhase = phase;
  }
  // 房主标识 / 管理员通知
  document.getElementById("hostBadge").style.display = isHost() ? "" : "none";
  const noticeBar = document.getElementById("noticeBar");
  if (state.notice) {
    noticeBar.textContent = "📢 " + state.notice;
    noticeBar.style.display = "";
  } else {
    noticeBar.style.display = "none";
  }
  if (phase === "collecting") {
    renderCollecting();
  } else if (phase === "playing") {
    renderPlaying();
  } else if (phase === "finished") {
    renderFinished();
  }
  updateTimerLabel();
}

const songMap = {};
function refreshMaps() {
  for (const k in songMap) delete songMap[k];
  state.songs.forEach((s) => (songMap[s.id] = s));
}
function songTitle(id) {
  return songMap[id] ? songMap[id].title : "（已删除）";
}

/* ---------------- 增量渲染 ----------------
 * 旧写法是每条广播都把整个列表 innerHTML 清空再重建：人多 + 歌多的时候，
 * 一次广播就要销毁/创建上百个节点（公示板 = 人数 × 对阵数），
 * 十个人各点一轮就是上千次重建，页面明显卡顿，而且点下去的那一下经常被重建吞掉。
 * 现在按「key 列表」做增量：key 顺序没变就只改文字和 class，不碰 DOM 结构。
 */
function emptyNode(text) {
  const d = document.createElement("div");
  d.className = "empty";
  d.textContent = text;
  return d;
}

// 手动清空某个容器时，必须同时作废它的增量缓存，否则会更新到已脱离文档的旧节点上
function clearBox(box, text) {
  box.textContent = "";
  if (box.__sec) {
    box.__sec.keys = null;
    box.__sec.nodes = [];
  }
  if (text) box.appendChild(emptyNode(text));
}

function syncList(box, items, keyOf, build, update) {
  const keys = items.map(keyOf);
  const sec = box.__sec || (box.__sec = { keys: null, nodes: [] });

  let same = sec.keys !== null && sec.keys.length === keys.length;
  if (same) {
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] !== sec.keys[i]) { same = false; break; }
    }
  }

  if (!same) {
    // 结构真的变了才重建
    sec.keys = keys;
    sec.nodes = [];
    box.textContent = "";
    for (let i = 0; i < items.length; i++) {
      const node = build(items[i], i);
      sec.nodes.push(node);
      box.appendChild(node);
    }
  }
  for (let i = 0; i < items.length; i++) update(sec.nodes[i], items[i], i);
}

function setOn(el, on, cls) {
  if (on) el.classList.add(cls);
  else el.classList.remove(cls);
}

function badge(text, cls) {
  const b = document.createElement("span");
  b.className = "badge " + cls;
  b.textContent = text;
  return b;
}

/* ---------------- 收集阶段 ---------------- */
function buildSongRow(s) {
  const row = document.createElement("div");
  row.className = "song";
  const main = document.createElement("div");
  main.className = "song-main";
  const title = document.createElement("div");
  title.className = "song-title";
  const sub = document.createElement("div");
  sub.className = "song-sub";
  main.appendChild(title);
  main.appendChild(sub);
  const del = document.createElement("button");
  del.className = "del-btn";
  del.type = "button";
  del.title = "删除";
  del.textContent = "×";
  del.onclick = () => removeSong(s.id);
  row.appendChild(main);
  row.appendChild(del);
  return row;
}

function updateSongRow(row, s) {
  const main = row.children[0];
  main.children[0].textContent = s.title;
  const byName = s.addedBy
    ? (state.participants.find((p) => p.id === s.addedBy) || {}).name || "某人"
    : "—";
  main.children[1].textContent = (s.artist ? s.artist + " · " : "") + byName + " 添加";
}

function buildPersonRow(p) {
  const c = document.createElement("div");
  c.className = "person";
  const dot = document.createElement("span");
  dot.className = "dot";
  const nm = document.createElement("span");
  nm.className = "person-name";
  const badges = document.createElement("span");
  badges.className = "badges";
  c.appendChild(dot);
  c.appendChild(nm);
  c.appendChild(badges);
  return c;
}

function updatePersonRow(c, p) {
  setOn(c, p.id === me.id, "me");
  const dot = c.children[0];
  setOn(dot, !!p.online, "online");
  c.children[1].textContent = p.name + (p.id === me.id ? "（你）" : "");
  const badges = c.children[2];
  badges.textContent = "";
  if (p.id === state.hostId) badges.appendChild(badge("房主", "badge-host"));
  if (p.ready) badges.appendChild(badge("已准备", "badge-ready"));
}

function renderCollecting() {
  refreshMaps();
  const mine = myParticipant();
  const ready = !!(mine && mine.ready);

  // 歌单
  const pl = document.getElementById("playlist");
  if (state.songs.length === 0) {
    clearBox(pl, "还没有歌曲，在上面添加第一首吧 ♪");
  } else {
    syncList(pl, state.songs, (s) => s.id, buildSongRow, updateSongRow);
  }
  document.getElementById("songCount").textContent = "共 " + state.songs.length + " 首";

  // 准备后锁定添加
  document.getElementById("songTitle").disabled = ready;
  document.getElementById("songArtist").disabled = ready;
  document.getElementById("libBtn").style.display = ready ? "none" : "";
  document.getElementById("importBtn").style.display = ready ? "none" : "";
  document.getElementById("readyLockHint").style.display = ready ? "" : "none";

  // 开始区：房主设置 + 开始按钮；其他人看到准备按钮
  const host = isHost();
  document.getElementById("hostSettings").style.display = host ? "" : "none";
  document.getElementById("startBtn").style.display = host ? "" : "none";
  document.getElementById("readyBtn").style.display = host ? "none" : "";
  document.getElementById("readyBtn").textContent = ready ? "取消准备" : "✓ 我准备好了";
  document.getElementById("durationSel").value = String(state.roundDuration);
  document.getElementById("revealSel").value = state.revealPicks ? "1" : "0";

  const inGame = state.participants.filter((p) => p.inGame);
  const startBtn = document.getElementById("startBtn");
  const hint = document.getElementById("startHint");
  const even = state.songs.length >= 2 && state.songs.length % 2 === 0;
  const readyText = "已准备 " + (state.readyCount || 0) + " / " + inGame.length + " 人（房主计入）";
  if (!even) {
    startBtn.disabled = true;
    startBtn.textContent = "开始淘汰赛";
    hint.textContent =
      state.songs.length < 2
        ? "至少添加 2 首歌后开始"
        : "歌曲数量需为偶数（当前 " + state.songs.length + " 首），再加/删一首即可";
  } else {
    startBtn.disabled = false;
    startBtn.textContent = "开始淘汰赛（" + state.songs.length + " 首）";
    hint.textContent = host
      ? readyText + " · 不足 2/3 时会警告，可强制开始"
      : "等待房主开始 · " + readyText;
  }

  // 参赛者
  document.getElementById("inGameCount").textContent = "· " + inGame.length + " 人";
  const people = document.getElementById("people");
  if (inGame.length === 0) {
    clearBox(people, "等待大家进入房间…");
  } else {
    syncList(people, inGame, (p) => p.id, buildPersonRow, updatePersonRow);
  }
}

/* ---------------- 淘汰赛阶段 ---------------- */
function participantDone(p) {
  if (!p.pairs) return false;
  return p.pairs.every((pr) => pr.b === null || pr.pick != null);
}

function buildPairCard(pr, idx) {
  const card = document.createElement("div");
  card.className = "pair-card";
  if (pr.b === null) {
    card.classList.add("bye");
    const a = document.createElement("div");
    a.className = "song-opt bye-opt";
    const tag = document.createElement("span");
    tag.className = "vs-tag";
    tag.textContent = "轮空";
    const t = document.createElement("span");
    t.className = "opt-title";
    a.appendChild(tag);
    a.appendChild(t);
    card.appendChild(a);
  } else {
    [pr.a, pr.b].forEach((id) => {
      const opt = document.createElement("button");
      opt.className = "song-opt";
      opt.type = "button";
      const t = document.createElement("span");
      t.className = "opt-title";
      opt.appendChild(t);
      opt.onclick = () => choosePair(idx, id);
      card.appendChild(opt);
    });
    const vs = document.createElement("div");
    vs.className = "vs";
    vs.textContent = "VS";
    card.insertBefore(vs, card.children[1]);
  }
  return card;
}

function updatePairCard(card, pr) {
  const opts = card.querySelectorAll(".song-opt");
  if (pr.b === null) {
    // 轮空：自动晋级，无需选择
    opts[0].querySelector(".opt-title").textContent = songTitle(pr.a);
  } else {
    // 本轮我的选择：后端把 pick 直接挂在每个对阵上
    const picked = pr.pick != null ? pr.pick : null;
    [pr.a, pr.b].forEach((id, i) => {
      const opt = opts[i];
      setOn(opt, picked === id, "picked");
      opt.querySelector(".opt-title").textContent = songTitle(id);
    });
  }
}

function buildBoardPerson(p) {
  const card = document.createElement("div");
  card.className = "person";
  const head = document.createElement("div");
  head.className = "person-head";
  const dot = document.createElement("span");
  dot.className = "dot";
  const nm = document.createElement("span");
  nm.className = "person-name";
  const rt = document.createElement("span");
  rt.className = "round-tag";
  head.appendChild(dot);
  head.appendChild(nm);
  head.appendChild(rt);
  const picks = document.createElement("div");
  picks.className = "person-picks";
  card.appendChild(head);
  card.appendChild(picks);
  return card;
}

function updateBoardPerson(card, p) {
  setOn(card, p.id === me.id, "me");
  const head = card.children[0];
  const picks = card.children[1];
  setOn(head.children[0], !!p.online, "online");
  head.children[1].textContent = p.name + (p.id === me.id ? "（你）" : "");
  // 落后于共享轮的玩家：标注正在追赶第几轮
  const rt = head.children[2];
  if (p.behind) {
    rt.textContent = "追赶第 " + (p.playerRound + 1) + " 轮";
    rt.style.display = "";
  } else {
    rt.textContent = "";
    rt.style.display = "none";
  }

  if (!p.inGame) {
    clearBox(picks, null);
    picks.appendChild(pickEmpty("旁观者"));
  } else if (p.champion != null) {
    // 已角逐出最终歌曲：永远公开
    clearBox(picks, null);
    const chip = document.createElement("span");
    chip.className = "pick-chip champ-chip";
    chip.textContent = "🏆 " + songTitle(p.champion);
    picks.appendChild(chip);
  } else if (!p.pairs || p.pairs.length === 0) {
    clearBox(picks, null);
    picks.appendChild(pickEmpty("等待开始"));
  } else {
    syncList(picks, p.pairs, pairKey, buildPickChip, updatePickChip);
  }
}

function pickEmpty(text) {
  const s = document.createElement("span");
  s.className = "pick-empty";
  s.textContent = text;
  return s;
}

// 对阵内容（a|b）变了才重建卡片：轮次推进时索引不变但歌曲会换
function pairKey(pr) {
  return (pr.b === null ? "bye|" : "vs|") + pr.a + "|" + pr.b;
}

function buildPickChip(pr) {
  const chip = document.createElement("span");
  chip.className = "pick-chip";
  return chip;
}

function updatePickChip(chip, pr) {
  if (pr.b === null) {
    chip.className = "pick-chip bye-chip";
    chip.textContent = "轮空：" + songTitle(pr.a);
  } else if (pr.hidden) {
    chip.className = "pick-chip hidden-chip";
    chip.textContent = "（已隐藏）";
  } else {
    const chosen = pr.pick;
    chip.className = "pick-chip" + (chosen ? " chosen" : "");
    chip.textContent = chosen ? songTitle(chosen) : "（未选）";
  }
}

function renderPlaying() {
  refreshMaps();
  const mine = myParticipant();
  const host = isHost();
  const waiting = state.currentRound >= state.totalRounds; // 同步玩家已角逐完，等待追赶

  document.getElementById("roundNo").textContent = waiting
    ? state.totalRounds
    : state.currentRound + 1;
  document.getElementById("roundTotal").textContent = state.totalRounds;

  // 本轮进度
  const onlineInGame = state.participants.filter((p) => p.inGame && p.online);
  const done = onlineInGame.filter(participantDone).length;
  const statusEl = document.getElementById("roundStatus");
  if (waiting) {
    statusEl.textContent =
      "已角逐出结果，等待 " + (state.pendingCount || 0) + " 人追赶";
    statusEl.className = "round-status done";
  } else if (state.roundComplete) {
    statusEl.textContent = host ? "本轮已全部选择 ✓ 可进入下一轮" : "本轮已全部选择 ✓ 等待房主进入下一轮";
    statusEl.className = "round-status done";
  } else {
    statusEl.textContent = "等待选择中… " + done + " / " + onlineInGame.length + " 人已完成";
    statusEl.className = "round-status";
  }

  // 房主控件：公开/隐藏切换、下一轮
  const revealBtn = document.getElementById("revealBtn");
  revealBtn.style.display = host ? "" : "none";
  revealBtn.textContent = state.revealPicks ? "👁 每轮选择：公开" : "👁 每轮选择：隐藏";
  const nextBtn = document.getElementById("nextBtn");
  nextBtn.style.display = host ? "" : "none";
  nextBtn.disabled = !state.roundComplete || waiting;
  nextBtn.textContent = waiting ? "已到末轮" : "下一轮";
  document.getElementById("revealTag").textContent = state.revealPicks ? "" : "（本局选择隐藏中）";

  // 我在追赶旧轮次的提示
  const behindNotice = document.getElementById("behindNotice");
  if (mine && mine.behind) {
    behindNotice.textContent =
      "你落后了 " + (state.currentRound - mine.playerRound) + " 轮，正在追赶：依次完成选择即可连续跟上，不受本轮限时影响";
    behindNotice.style.display = "";
  } else {
    behindNotice.style.display = "none";
  }
  const eventNotice = document.getElementById("eventNotice");
  if (state.lastEvent) {
    eventNotice.textContent = "⏳ " + state.lastEvent;
    eventNotice.style.display = "";
  } else {
    eventNotice.style.display = "none";
  }

  // 我的对阵
  const myPairs = document.getElementById("myPairs");
  document.getElementById("myPairsHint").textContent =
    mine && mine.behind ? "追赶第 " + (mine.playerRound + 1) + " 轮 · 点击二选一" : "点击二选一";
  if (!mine) {
    clearBox(myPairs, "正在同步你的身份…");
  } else if (!mine.inGame) {
    clearBox(myPairs, "你在本局是旁观者，可看大家的选择（下一局自动参赛）");
  } else if (mine.champion != null) {
    clearBox(myPairs, null);
    const c = document.createElement("div");
    c.className = "empty champ-line";
    c.textContent = "🏆 你的最终歌曲：" + songTitle(mine.champion);
    myPairs.appendChild(c);
  } else if (!mine.pairs || mine.pairs.length === 0) {
    clearBox(myPairs, "等待本局开始…");
  } else {
    syncList(myPairs, mine.pairs, pairKey, buildPairCard, updatePairCard);
  }

  // 公布所有人的选择
  const board = document.getElementById("board");
  const others = state.participants.slice().sort((a, b) => (b.inGame ? 1 : 0) - (a.inGame ? 1 : 0));
  if (others.length === 0) {
    clearBox(board, "等待大家选择…");
  } else {
    syncList(board, others, (p) => p.id, buildBoardPerson, updateBoardPerson);
  }

  // 等待追赶区：展示已定冠军 + 房主强制结算
  const waitingBar = document.getElementById("waitingBar");
  const playGrid = document.getElementById("playGrid");
  if (waiting) {
    playGrid.style.display = "none";
    waitingBar.style.display = "";
    const doneList = state.participants.filter((p) => p.inGame && p.champion != null);
    const doneChamps = document.getElementById("doneChamps");
    if (doneList.length === 0) {
      clearBox(doneChamps, "—");
    } else {
      syncList(doneChamps, doneList, (p) => p.id, buildChampion, updateChampion);
    }
    document.getElementById("settleBtn").style.display = host ? "" : "none";
  } else {
    playGrid.style.display = "";
    waitingBar.style.display = "none";
  }

  updateTimerLabel();
}

/* ---------------- 结束阶段 ---------------- */
function buildChampion(p) {
  const card = document.createElement("div");
  card.className = "champion";
  const dot = document.createElement("span");
  dot.className = "dot";
  const nm = document.createElement("span");
  nm.className = "champ-name";
  const song = document.createElement("span");
  song.className = "champ-song";
  card.appendChild(dot);
  card.appendChild(nm);
  card.appendChild(song);
  return card;
}

function updateChampion(card, p) {
  setOn(card, p.id === me.id, "me");
  setOn(card.children[0], !!p.online, "online");
  card.children[1].textContent = p.name + (p.id === me.id ? "（你）" : "");
  card.children[2].textContent = songTitle(p.champion);
}

function renderFinished() {
  refreshMaps();
  const ch = document.getElementById("champions");
  const inGame = state.participants.filter((p) => p.inGame && p.champion);
  if (inGame.length === 0) {
    clearBox(ch, "—");
    return;
  }
  syncList(ch, inGame, (p) => p.id, buildChampion, updateChampion);
  document.getElementById("resetBtn").style.display = isHost() ? "" : "none";
  document.getElementById("resetHint").style.display = isHost() ? "none" : "";
}

/* ---------------- 单轮倒计时 ---------------- */
function updateTimerLabel() {
  const el = document.getElementById("roundTimer");
  if (!el) return;
  if (state.phase !== "playing" || !state.roundEndsAt) {
    el.textContent = "";
    el.className = "round-timer";
    return;
  }
  const remain = state.roundEndsAt - (Date.now() + serverOffset);
  if (remain <= 0) {
    el.textContent = "⏱ 00:00";
    el.className = "round-timer urgent";
    return;
  }
  const s = Math.ceil(remain / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  el.textContent = "⏱ " + mm + ":" + ss;
  el.className = "round-timer" + (s <= 10 ? " urgent" : "");
}

// ===== 回车快捷 =====
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const a = document.activeElement;
  if (a === document.getElementById("songArtist")) addSong();
  else if (a === document.getElementById("importUrl")) fetchImport();
  else if (a === document.getElementById("roomInput")) joinRoom();
  else if (a === document.getElementById("nameInput")) joinRoom();
});

// ===== 初始化 =====
loadIdentity();
(function init() {
  const room = getRoom();
  if (room) document.getElementById("roomInput").value = room;
  if (me.name) document.getElementById("nameInput").value = me.name;
  clearInterval(timerTick);
  timerTick = setInterval(updateTimerLabel, 500);
  if (room && me.name) joinRoom();
})();
