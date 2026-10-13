// ===== 身份（跨刷新保持）=====
const me = { id: null, name: "" };
let state = { phase: "collecting", songs: [], participants: [] };
let ws = null;
let reconnectTimer = null;
let pollTimer = null;
// 多人同时操作时会连着收到多条广播，用这个标记把它们合并到同一帧只渲染一次
let renderQueued = false;

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
    try {
      const m = JSON.parse(e.data);
      if (m.type === "state") {
        state = m.state;
        scheduleRender();
      }
    } catch {}
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
      const r = await fetch("/state?room=" + encodeURIComponent(room) + reg);
      if (r.ok) {
        state = await r.json();
        scheduleRender();
      }
    } catch {}
  }, 4000);
}

// ===== 操作 =====
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

function removeSong(songId) {
  if (!confirm("从歌单中删除这首歌？")) return;
  send({ type: "remove_song", songId });
}

function clearSongs() {
  if (!confirm("清空整个歌单？")) return;
  send({ type: "clear_songs" });
}

function startGame() {
  if (state.songs.length < 2) return toast("至少添加 2 首歌");
  if (state.songs.length % 2 !== 0) return toast("歌曲数量必须为偶数才能开始");
  send({ type: "start" });
}

function choosePair(pairIndex, songId) {
  send({ type: "choose", pairIndex, songId });
}

function nextRound() {
  send({ type: "next_round" });
}

function resetGame() {
  send({ type: "reset" });
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
  if (phase === "collecting") {
    renderCollecting();
  } else if (phase === "playing") {
    renderPlaying();
  } else if (phase === "finished") {
    renderFinished();
  }
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
  c.appendChild(dot);
  c.appendChild(nm);
  return c;
}

function updatePersonRow(c, p) {
  setOn(c, p.id === me.id, "me");
  const dot = c.children[0];
  setOn(dot, !!p.online, "online");
  c.children[1].textContent = p.name + (p.id === me.id ? "（你）" : "");
}

function renderCollecting() {
  refreshMaps();
  const mine = state.participants.find((p) => p.id === me.id);

  // 歌单
  const pl = document.getElementById("playlist");
  if (state.songs.length === 0) {
    clearBox(pl, "还没有歌曲，在上面添加第一首吧 ♪");
  } else {
    syncList(pl, state.songs, (s) => s.id, buildSongRow, updateSongRow);
  }

  document.getElementById("songCount").textContent = "共 " + state.songs.length + " 首";

  // 开始按钮
  const even = state.songs.length >= 2 && state.songs.length % 2 === 0;
  const startBtn = document.getElementById("startBtn");
  const hint = document.getElementById("startHint");
  if (state.songs.length < 2) {
    startBtn.disabled = true;
    startBtn.textContent = "开始淘汰赛";
    hint.textContent = "至少添加 2 首歌后开始";
  } else if (!even) {
    startBtn.disabled = true;
    startBtn.textContent = "开始淘汰赛";
    hint.textContent = "歌曲数量需为偶数（当前 " + state.songs.length + " 首），再加/删一首即可";
  } else {
    startBtn.disabled = false;
    startBtn.textContent = "开始淘汰赛（" + state.songs.length + " 首）";
    hint.textContent = "全员准备就绪后点击，开始逐轮二选一";
  }

  // 参赛者
  const inGame = state.participants.filter((p) => p.inGame);
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
  head.appendChild(dot);
  head.appendChild(nm);
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

  if (!p.inGame) {
    clearBox(picks, null);
    picks.appendChild(pickEmpty("旁观者"));
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
  } else {
    const chosen = pr.pick;
    chip.className = "pick-chip" + (chosen ? " chosen" : "");
    chip.textContent = chosen ? songTitle(chosen) : "（未选）";
  }
}

function renderPlaying() {
  refreshMaps();
  const mine = state.participants.find((p) => p.id === me.id);

  document.getElementById("roundNo").textContent = (state.currentRound + 1);
  document.getElementById("roundTotal").textContent = state.totalRounds;

  // 本轮进度
  const inGame = state.participants.filter((p) => p.inGame && p.pairs);
  const done = inGame.filter(participantDone).length;
  const statusEl = document.getElementById("roundStatus");
  if (state.roundComplete) {
    statusEl.textContent = "本轮已全部选择 ✓ 可进入下一轮";
    statusEl.className = "round-status done";
  } else {
    statusEl.textContent = "等待选择中… " + done + " / " + inGame.length + " 人已完成";
    statusEl.className = "round-status";
  }

  // 我的对阵
  const myPairs = document.getElementById("myPairs");
  if (!mine) {
    clearBox(myPairs, "正在同步你的身份…");
  } else if (!mine.inGame) {
    clearBox(myPairs, "你在本局是旁观者，可看大家的选择（下一局自动参赛）");
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

  // 下一轮按钮
  document.getElementById("nextBtn").disabled = !state.roundComplete;
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
}

// ===== 回车快捷 =====
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const a = document.activeElement;
  if (a === document.getElementById("songArtist")) addSong();
  else if (a === document.getElementById("roomInput")) joinRoom();
  else if (a === document.getElementById("nameInput")) joinRoom();
});

// ===== 初始化 =====
loadIdentity();
(function init() {
  const room = getRoom();
  if (room) document.getElementById("roomInput").value = room;
  if (me.name) document.getElementById("nameInput").value = me.name;
  if (room && me.name) joinRoom();
})();
