// 房间管理后台逻辑（可读源码）。此文件即为线上运行版本，便于直接查看与调试。
const K = "sc_admin_token";
let TOKEN = localStorage.getItem(K) || "";
let ROOMS = [];
let current = null;

const loginBox = document.getElementById("login");
const app = document.getElementById("app");

function api(path, opts = {}) {
  const u = new URL(path, location.origin);
  u.searchParams.set("token", TOKEN);
  return fetch(u.toString(), opts);
}

// 调用接口并解析 JSON；非 2xx 时抛出后端给出的具体原因（而不是只有「HTTP 500」）
async function apiJson(path, opts = {}) {
  const r = await api(path, opts);
  let j = null;
  try {
    j = await r.json();
  } catch {}
  if (!r.ok) {
    const msg = j && (j.message || j.error || j.msg);
    throw new Error(msg || "HTTP " + r.status);
  }
  return j;
}

async function ping() {
  const el = document.getElementById("pingInfo");
  try {
    const j = await apiJson("/admin/api/ping");
    el.textContent =
      "索引房间 " + j.indexedRooms + " 个" + (j.indexOk ? "" : "（索引异常：" + (j.indexErr || "未知") + "）");
  } catch (e) {
    el.textContent = "自检失败：" + (e.message || e);
  }
}

async function lookupRoom() {
  const v = document.getElementById("lookup").value.trim();
  if (!v) return;
  try {
    await openDetail(v);
  } catch {}
}

async function doLogin() {
  const v = document.getElementById("tokenInput").value.trim();
  if (!v) return;
  TOKEN = v;
  const err = document.getElementById("loginErr");
  err.classList.add("hidden");
  try {
    const r = await api("/admin/api/rooms");
    if (r.status === 403) throw new Error("令牌无效或未配置 ADMIN_TOKEN");
    if (!r.ok) {
      let j = null;
      try {
        j = await r.json();
      } catch {}
      throw new Error((j && (j.message || j.error)) || "HTTP " + r.status);
    }
    localStorage.setItem(K, TOKEN);
    loginBox.classList.add("hidden");
    app.classList.remove("hidden");
    loadRooms();
    ping();
  } catch (e) {
    err.textContent = e.message || "登录失败";
    err.classList.remove("hidden");
  }
}

function logout() {
  localStorage.removeItem(K);
  TOKEN = "";
  app.classList.add("hidden");
  document.getElementById("detail").classList.add("hidden");
  loginBox.classList.remove("hidden");
}

document.getElementById("loginBtn").onclick = doLogin;
document.getElementById("tokenInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doLogin();
});

function phasePill(ph) {
  if (ph === "playing") return '<span class="pill play">进行中</span>';
  if (ph === "finished") return '<span class="pill fin">已结束</span>';
  return '<span class="pill col">收集中</span>';
}

async function loadRooms() {
  const body = document.getElementById("roomsBody");
  body.innerHTML = '<tr><td colspan="6" class="muted">加载中…</td></tr>';
  try {
    const j = await apiJson("/admin/api/rooms");
    ROOMS = Array.isArray(j) ? j : [];
    renderRooms();
  } catch (e) {
    body.innerHTML = '<tr><td colspan="6" class="err">加载失败：' + esc(e.message || e) + "</td></tr>";
  }
}

function renderRooms() {
  const f = (document.getElementById("filter").value || "").trim().toLowerCase();
  const body = document.getElementById("roomsBody");
  const list = ROOMS.filter((x) => !f || (x.name || "").toLowerCase().includes(f));
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="6" class="muted">没有匹配的房间</td></tr>';
    return;
  }
  body.innerHTML = list
    .map(
      (x) => `<tr>
      <td>${esc(x.name)}</td>
      <td>${phasePill(x.phase)}</td>
      <td><span class="dot ${x.onlineCount > 0 ? "on" : ""}"></span>${x.onlineCount}/${x.participantCount}</td>
      <td>${x.songCount}</td>
      <td>${x.phase === "playing" ? x.currentRound + 1 + "/" + (x.totalRounds || "?") : "-"}</td>
      <td><button class="tiny" onclick="openDetail('${enc(x.name)}')">查看 / 管理</button></td>
    </tr>`,
    )
    .join("");
}

async function openDetail(name) {
  current = name;
  const d = document.getElementById("detail");
  d.classList.remove("hidden");
  document.getElementById("detailMsg").classList.add("hidden");
  try {
    const x = await apiJson("/admin/api/rooms/" + encodeURIComponent(name));
    document.getElementById("detailTitle").textContent = "房间：" + x.name;
    document.getElementById("detailPhase").textContent =
      x.phase === "playing" ? "进行中" : x.phase === "finished" ? "已结束" : "收集中";
    const nb = document.getElementById("detailNotice");
    nb.textContent = x.notice ? "通知：" + x.notice : "";
    nb.style.display = x.notice ? "" : "none";

    const pb = document.getElementById("partsBody");
    if (!x.participants.length) {
      pb.innerHTML = '<tr><td colspan="6" class="muted">暂无参与者</td></tr>';
    } else {
      pb.innerHTML = x.participants
        .map(
          (p) => `<tr>
          <td>${esc(p.name)}</td>
          <td>${p.online ? '<span class="pill on">在线</span>' : '<span class="pill off">离线</span>'}</td>
          <td>${p.inGame ? "是" : "否"}</td>
          <td>${p.survivors}</td>
          <td>${esc(p.champion || "-")}</td>
          <td><button class="tiny danger" onclick="removePart('${p.id}')">移除</button></td>
        </tr>`,
        )
        .join("");
    }

    const sb = document.getElementById("songsBody");
    if (!x.songs.length) {
      sb.innerHTML = '<tr><td colspan="4" class="muted">暂无歌曲</td></tr>';
    } else {
      sb.innerHTML = x.songs
        .map(
          (s) => `<tr>
          <td>${esc(s.title)}</td>
          <td>${esc(s.artist || "-")}</td>
          <td class="muted">${esc((s.addedBy || "").slice(0, 8))}</td>
          <td><button class="tiny danger" onclick="removeSong('${s.id}')">删除</button></td>
        </tr>`,
        )
        .join("");
    }
  } catch (e) {
    flash("加载房间详情失败：" + (e.message || e), false);
  }
}

function closeDetail() {
  current = null;
  document.getElementById("detail").classList.add("hidden");
}

// 统一的「操作」调用：始终返回 {ok,msg}，不因非 JSON 响应而崩
async function postAction(payload) {
  const r = await api("/admin/api/rooms/" + encodeURIComponent(current) + "/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  let j = null;
  try {
    j = await r.json();
  } catch {}
  if (!j || typeof j !== "object") j = { ok: false, msg: "HTTP " + r.status };
  return j;
}

function failMsg(j) {
  return j.msg || j.error || j.message || "未知错误";
}

async function act(action) {
  if (!current) return;
  if (action === "wipe" && !confirm("确认彻底清空房间「" + current + "」？此操作会删除歌单和所有参与者。")) return;
  if (action === "clear_songs" && !confirm("确认清空房间「" + current + "」的歌单并回到收集阶段？")) return;
  const j = await postAction({ action });
  flash(j.ok ? "操作成功：" + action : "失败：" + failMsg(j), j.ok);
  if (j.ok) {
    loadRooms();
    openDetail(current);
  }
}

async function removeSong(id) {
  const j = await postAction({ action: "remove_song", songId: id });
  flash(j.ok ? "已删除歌曲" : "失败：" + failMsg(j), j.ok);
  if (j.ok) openDetail(current);
}

async function removePart(pid) {
  if (!confirm("确认将该参与者移出房间？")) return;
  const j = await postAction({ action: "remove_participant", pid });
  flash(j.ok ? "已移除参与者" : "失败：" + failMsg(j), j.ok);
  if (j.ok) openDetail(current);
}

async function sendNotice() {
  const t = document.getElementById("noticeText").value.trim();
  if (!t) return;
  const j = await postAction({ action: "notice", text: t });
  flash(j.ok ? "通知已广播" : "失败：" + failMsg(j), j.ok);
  if (j.ok) {
    document.getElementById("noticeText").value = "";
    openDetail(current);
  }
}

function flash(msg, ok) {
  const el = document.getElementById("detailMsg");
  el.textContent = msg;
  el.className = ok ? "ok" : "err";
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function enc(s) {
  return encodeURIComponent(s);
}

// 启动：若已存令牌则尝试直接进入
if (TOKEN) {
  (async () => {
    try {
      const r = await api("/admin/api/rooms");
      if (r.ok) {
        loginBox.classList.add("hidden");
        app.classList.remove("hidden");
        loadRooms();
        ping();
        return;
      }
    } catch {}
    localStorage.removeItem(K);
    TOKEN = "";
  })();
}
