// ===== 身份（跨刷新保持）=====
const me = { id: null, name: "" };
let state = { phase: "collecting", songs: [], participants: [] };
let ws = null;
let reconnectTimer = null;
let pollTimer = null;

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
        render();
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
  pollTimer = setInterval(async () => {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    const room = getRoom();
    if (!room) return;
    try {
      const r = await fetch("/state?room=" + encodeURIComponent(room));
      if (r.ok) {
        state = await r.json();
        render();
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

function renderInner() {
  const phase = state.phase || "collecting";

  if (phase === "collecting") {
    showPhase("phase-collecting");
    renderCollecting();
  } else if (phase === "playing") {
    showPhase("phase-playing");
    renderPlaying();
  } else if (phase === "finished") {
    showPhase("phase-finished");
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

function renderCollecting() {
  refreshMaps();
  const mine = state.participants.find((p) => p.id === me.id);

  // 歌单
  const pl = document.getElementById("playlist");
  if (state.songs.length === 0) {
    pl.innerHTML = '<div class="empty">还没有歌曲，在上面添加第一首吧 ♪</div>';
  } else {
    pl.innerHTML = "";
    state.songs.forEach((s) => {
      const row = document.createElement("div");
      row.className = "song";
      const byName = s.addedBy ? (state.participants.find((p) => p.id === s.addedBy) || {}).name || "某人" : "—";
      row.innerHTML = `
        <div class="song-main">
          <div class="song-title"></div>
          <div class="song-sub">${s.artist ? escapeHtml(s.artist) + " · " : ""}<span class="by">${escapeHtml(byName)}</span> 添加</div>
        </div>
        <button class="del-btn" title="删除" onclick="removeSong('${s.id}')">×</button>`;
      row.querySelector(".song-title").textContent = s.title;
      pl.appendChild(row);
    });
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
    people.innerHTML = '<div class="empty">等待大家进入房间…</div>';
  } else {
    people.innerHTML = "";
    inGame.forEach((p) => {
      const c = document.createElement("div");
      c.className = "person" + (p.id === me.id ? " me" : "");
      c.innerHTML = `
        <span class="dot ${p.online ? "online" : ""}"></span>
        <span class="person-name"></span>`;
      c.querySelector(".person-name").textContent = p.name + (p.id === me.id ? "（你）" : "");
      people.appendChild(c);
    });
  }
}

function participantDone(p) {
  if (!p.pairs) return false;
  return p.pairs.every((pr) => pr.b === null || pr.pick != null);
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
    myPairs.innerHTML = '<div class="empty">正在同步你的身份…</div>';
  } else if (!mine.inGame) {
    myPairs.innerHTML = '<div class="empty">你在本局是旁观者，可看大家的选择（下一局自动参赛）</div>';
  } else if (!mine.pairs || mine.pairs.length === 0) {
    myPairs.innerHTML = '<div class="empty">等待本局开始…</div>';
  } else {
    myPairs.innerHTML = "";
    mine.pairs.forEach((pr, idx) => {
      const card = document.createElement("div");
      card.className = "pair-card";
      if (pr.b === null) {
        // 轮空：自动晋级，无需选择
        card.classList.add("bye");
        const a = document.createElement("div");
        a.className = "song-opt bye-opt";
        a.innerHTML = '<span class="vs-tag">轮空</span><span class="opt-title"></span>';
        a.querySelector(".opt-title").textContent = songTitle(pr.a);
        card.appendChild(a);
      } else {
        // 本轮我的选择：后端把 pick 直接挂在每个对阵上
        const picked = pr.pick != null ? pr.pick : null;
        [pr.a, pr.b].forEach((id) => {
          const opt = document.createElement("button");
          opt.className = "song-opt" + (picked === id ? " picked" : "");
          opt.innerHTML = '<span class="opt-title"></span>';
          opt.querySelector(".opt-title").textContent = songTitle(id);
          opt.onclick = () => choosePair(idx, id);
          card.appendChild(opt);
        });
        const vs = document.createElement("div");
        vs.className = "vs";
        vs.textContent = "VS";
        card.insertBefore(vs, card.children[1]);
      }
      myPairs.appendChild(card);
    });
  }

  // 公布所有人的选择
  const board = document.getElementById("board");
  const others = state.participants.slice().sort((a, b) => (b.inGame ? 1 : 0) - (a.inGame ? 1 : 0));
  if (others.length === 0) {
    board.innerHTML = '<div class="empty">等待大家选择…</div>';
  } else {
    board.innerHTML = "";
    others.forEach((p) => {
      const card = document.createElement("div");
      card.className = "person" + (p.id === me.id ? " me" : "");
      const head = document.createElement("div");
      head.className = "person-head";
      head.innerHTML = '<span class="dot"></span><span class="person-name"></span>';
      head.querySelector(".person-name").textContent = p.name + (p.id === me.id ? "（你）" : "");
      if (p.online) head.querySelector(".dot").classList.add("online");
      card.appendChild(head);

      const picks = document.createElement("div");
      picks.className = "person-picks";
      if (!p.inGame) {
        picks.innerHTML = '<span class="pick-empty">旁观者</span>';
      } else if (!p.pairs || p.pairs.length === 0) {
        picks.innerHTML = '<span class="pick-empty">等待开始</span>';
      } else {
        p.pairs.forEach((pr) => {
          if (pr.b === null) {
            const chip = document.createElement("span");
            chip.className = "pick-chip bye-chip";
            chip.textContent = "轮空：" + songTitle(pr.a);
            picks.appendChild(chip);
          } else {
            const chip = document.createElement("span");
            const chosen = pr.pick;
            chip.className = "pick-chip" + (chosen ? " chosen" : "");
            chip.textContent = chosen ? songTitle(chosen) : "（未选）";
            picks.appendChild(chip);
          }
        });
      }
      card.appendChild(picks);
      board.appendChild(card);
    });
  }

  // 下一轮按钮
  const nextBtn = document.getElementById("nextBtn");
  nextBtn.disabled = !state.roundComplete;
}

function renderFinished() {
  refreshMaps();
  const ch = document.getElementById("champions");
  const inGame = state.participants.filter((p) => p.inGame && p.champion);
  if (inGame.length === 0) {
    ch.innerHTML = '<div class="empty">—</div>';
    return;
  }
  ch.innerHTML = "";
  inGame.forEach((p) => {
    const card = document.createElement("div");
    card.className = "champion" + (p.id === me.id ? " me" : "");
    card.innerHTML = `
      <span class="dot ${p.online ? "online" : ""}"></span>
      <span class="champ-name"></span>
      <span class="champ-song"></span>`;
    card.querySelector(".champ-name").textContent = p.name + (p.id === me.id ? "（你）" : "");
    card.querySelector(".champ-song").textContent = songTitle(p.champion);
    ch.appendChild(card);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

// 回车快捷
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && document.activeElement === document.getElementById("songArtist")) addSong();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && document.activeElement === document.getElementById("roomInput")) joinRoom();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && document.activeElement === document.getElementById("nameInput")) joinRoom();
});

// ===== 初始化 =====
loadIdentity();
(function init() {
  const room = getRoom();
  if (room) document.getElementById("roomInput").value = room;
  if (me.name) document.getElementById("nameInput").value = me.name;
  if (room && me.name) joinRoom();
})();
