// ===== 身份（跨刷新保持）=====
const me = { id: null, name: "" };
let state = { songs: [], participants: [] };
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

// 轮询回退：即使 WebSocket 临时不可用，也能保持状态同步
function startPoll() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (ws && ws.readyState === WebSocket.OPEN) return; // 有 WS 就不轮询
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

function togglePick(songId) {
  const mine = state.participants.find((p) => p.id === me.id);
  const cur = mine ? mine.picks.slice() : [];
  const i = cur.indexOf(songId);
  if (i >= 0) cur.splice(i, 1);
  else cur.push(songId);
  send({ type: "pick", songIds: cur });
}

function removeSong(songId) {
  if (!confirm("从歌单中删除这首歌？所有人的相关选择也会清除。")) return;
  send({ type: "remove_song", songId });
}

function clearSongs() {
  if (!confirm("清空整个歌单？所有人的选择也会清空。")) return;
  send({ type: "clear_songs" });
}

// ===== 渲染 =====
function render() {
  const songMap = {};
  state.songs.forEach((s) => (songMap[s.id] = s));
  const nameMap = {};
  state.participants.forEach((p) => (nameMap[p.id] = p.name));
  const mine = state.participants.find((p) => p.id === me.id);
  const myPicks = mine ? mine.picks : [];

  // 歌单
  const pl = document.getElementById("playlist");
  if (state.songs.length === 0) {
    pl.innerHTML = '<div class="empty">还没有歌曲，在上面添加第一首吧 ♪</div>';
  } else {
    pl.innerHTML = "";
    state.songs.forEach((s) => {
      const picked = myPicks.includes(s.id);
      const byName = s.addedBy ? nameMap[s.addedBy] || "某人" : "—";
      const row = document.createElement("div");
      row.className = "song" + (picked ? " picked" : "");
      row.innerHTML = `
        <div class="song-main">
          <div class="song-title"></div>
          <div class="song-sub">${s.artist ? escapeHtml(s.artist) + " · " : ""}<span class="by">${escapeHtml(byName)}</span> 添加</div>
        </div>
        <button class="pick-btn" onclick="togglePick('${s.id}')">${picked ? "已选 ✓" : "选"}</button>
        <button class="del-btn" title="删除" onclick="removeSong('${s.id}')">×</button>`;
      row.querySelector(".song-title").textContent = s.title;
      pl.appendChild(row);
    });
  }

  // 头部计数
  document.getElementById("songCount").textContent = "共 " + state.songs.length + " 首";
  document.getElementById("mePickCount").textContent = myPicks.length
    ? "· 你已选 " + myPicks.length + " 首"
    : "";

  // 大家的选择
  const board = document.getElementById("board");
  const people = state.participants.slice().sort((a, b) => b.picks.length - a.picks.length);
  if (people.length === 0) {
    board.innerHTML = '<div class="empty">等待大家选歌…</div>';
  } else {
    board.innerHTML = "";
    people.forEach((p) => {
      const isMe = p.id === me.id;
      const card = document.createElement("div");
      card.className = "person" + (isMe ? " me" : "");
      let picksHtml;
      if (p.picks.length === 0) {
        picksHtml = '<span class="pick-empty">还没选</span>';
      } else {
        picksHtml = p.picks
          .map((id) => {
            const t = songMap[id] ? songMap[id].title : "（已删除）";
            return '<span class="pick-chip"></span>';
          })
          .join("");
      }
      card.innerHTML = `
        <div class="person-head">
          <span class="dot ${p.online ? "online" : ""}"></span>
          <span class="person-name"></span>
        </div>
        <div class="person-picks">${picksHtml}</div>`;
      card.querySelector(".person-name").textContent = p.name + (isMe ? "（你）" : "");
      // 用 textContent 填充 chip，避免 XSS
      if (p.picks.length) {
        const wrap = card.querySelector(".person-picks");
        wrap.innerHTML = "";
        p.picks.forEach((id) => {
          const chip = document.createElement("span");
          chip.className = "pick-chip";
          chip.textContent = songMap[id] ? songMap[id].title : "（已删除）";
          wrap.appendChild(chip);
        });
      }
      board.appendChild(card);
    });
  }
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

// 回车快捷添加
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
  if (room && me.name) joinRoom(); // 通过分享链接进入时自动进场
})();
