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
  document.getElementById("roomsMsg").classList.add("hidden"); // 清掉上一次的列表级提示
  try {
    const j = await apiJson("/admin/api/rooms");
    ROOMS = Array.isArray(j) ? j : [];
    renderRooms();
  } catch (e) {
    body.innerHTML = '<tr><td colspan="6" class="err">加载失败：' + esc(e.message || e) + "</td></tr>";
  }
}

// 房间行的「删除」按钮：无人在线才可点；有人在线时禁用并说明原因
// （服务端也会再校验一次，避免后台列表是旧数据时误删）
function delBtn(x) {
  const busy = (x.onlineCount || 0) > 0;
  return (
    '<button class="tiny danger" onclick="delRoom(\'' +
    enc(x.name) +
    '\')"' +
    (busy ? " disabled title=\"房间内有人在线，暂不能删除\"" : ' title="删除房间，数据不可恢复"') +
    ">删除</button>"
  );
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
      <td><button class="tiny" onclick="openDetail('${enc(x.name)}')">查看 / 管理</button>${delBtn(x)}</td>
    </tr>`,
    )
    .join("");
}

// 删除房间：仅无人在线时可删（服务端以实时状态为准再校验）。
// 删掉的不只是数据，房间本身也会从后台列表消失；之后有人再进同名房间会是全新空房间。
async function delRoom(name) {
  if (!name) return;
  if (!confirm("确认删除房间「" + name + "」？房间数据会被移除并从后台列表消失，此操作不可撤销。")) return;
  const j = await postAction({ action: "delete" }, name);
  if (j.ok) {
    if (current === name) closeDetail();
    await loadRooms();
    flashRooms("已删除房间「" + name + "」", true);
    ping();
  } else {
    flashRooms("删除失败：" + failMsg(j), false);
  }
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

    // 「删除房间」仅在无人在线时可点（服务端还会再校验）
    const dBtn = document.getElementById("detailDelBtn");
    const busy = (x.onlineCount || 0) > 0;
    dBtn.disabled = busy;
    dBtn.title = busy ? "房间内有人在线，暂不能删除" : "删除房间，数据不可恢复";

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

// 统一的「操作」调用：始终返回 {ok,msg}，不因非 JSON 响应而崩。
// room 省略时操作当前打开详情的房间；列表行上的操作（如删除）显式传房间名。
async function postAction(payload, room) {
  const target = room || current;
  const r = await api("/admin/api/rooms/" + encodeURIComponent(target) + "/action", {
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

// 列表级提示（删除房间等不依赖详情面板打开的操作）
function flashRooms(msg, ok) {
  const el = document.getElementById("roomsMsg");
  el.textContent = msg;
  el.className = ok ? "ok" : "err";
  el.classList.remove("hidden");
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

// ===== 预制曲库管理（后台可增删改，实时同步给所有房间）=====
let LIB = { groups: [], data: {} };

function switchTab(which) {
  const rooms = which === "rooms";
  document.getElementById("roomsPanel").classList.toggle("hidden", !rooms);
  document.getElementById("libPanel").classList.toggle("hidden", rooms);
  document.getElementById("tabRooms").classList.toggle("active", rooms);
  document.getElementById("tabLib").classList.toggle("active", !rooms);
  if (!rooms) loadLibrary();
}

async function loadLibrary() {
  const box = document.getElementById("libGroups");
  box.innerHTML = '<div class="muted">加载中…</div>';
  try {
    LIB = await apiJson("/admin/api/library");
    renderLibraryAdmin();
  } catch (e) {
    box.innerHTML = '<div class="err">加载失败：' + esc(e.message || e) + "</div>";
  }
}

// 调用曲库编辑接口；失败也返回 {ok:false,msg} 而不是抛异常，方便统一提示
async function libAct(action, payload) {
  try {
    return await apiJson("/admin/api/library/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, payload }),
    });
  } catch (e) {
    return { ok: false, msg: e.message || "请求失败" };
  }
}

function mkBtn(label, cls, onclick) {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = label;
  b.onclick = onclick;
  return b;
}

function flashLib(msg, ok) {
  const el = document.getElementById("libMsg");
  el.textContent = (ok ? "✓ " : "✗ ") + msg;
  el.className = ok ? "ok" : "err";
}

function renderLibraryAdmin() {
  const box = document.getElementById("libGroups");
  const stat = document.getElementById("libStat");
  const f = (document.getElementById("libFilter").value || "").trim().toLowerCase();

  // 按过滤词筛分类与条目
  const view = {};
  let totalEntries = 0;
  let totalSongs = 0;
  for (const g of LIB.groups || []) {
    const names = Object.keys(LIB.data[g] || {}).filter(
      (n) =>
        !f ||
        n.toLowerCase().includes(f) ||
        (LIB.data[g][n] || []).some((t) => t.toLowerCase().includes(f)),
    );
    if ((!f || g.toLowerCase().includes(f) || names.length) && names.length) {
      view[g] = names;
    }
  }
  for (const g of Object.keys(view)) {
    totalEntries += view[g].length;
    for (const n of view[g]) totalSongs += (LIB.data[g][n] || []).length;
  }
  stat.textContent =
    "共 " + (LIB.groups || []).length + " 个分类 / " + totalEntries + " 个条目 / " + totalSongs + " 首歌" +
    (f ? "（已按筛选显示）" : "");

  if (!Object.keys(view).length) {
    box.innerHTML = '<div class="muted">没有匹配的曲库内容</div>';
    return;
  }
  box.innerHTML = "";
  for (const g of Object.keys(view)) {
    const card = document.createElement("div");
    card.className = "lib-card";
    const head = document.createElement("div");
    head.className = "lc-head";
    const gName = document.createElement("span");
    gName.className = "lc-name";
    gName.textContent = g;
    const gCount = document.createElement("span");
    gCount.className = "lc-count";
    gCount.textContent = view[g].length + " 个条目";
    head.appendChild(gName);
    head.appendChild(gCount);
    const acts = document.createElement("div");
    acts.className = "acts";
    acts.appendChild(mkBtn("重命名", "tiny", () => libRenameGroup(g)));
    acts.appendChild(mkBtn("删除分类", "tiny danger", () => libRemoveGroup(g)));
    acts.appendChild(mkBtn("＋条目", "tiny", () => libAddEntry(g)));
    head.appendChild(acts);
    card.appendChild(head);

    const ents = document.createElement("div");
    ents.className = "lib-entries";
    for (const n of view[g]) {
      const ent = document.createElement("div");
      ent.className = "lib-entry";
      const eh = document.createElement("div");
      eh.className = "le-head";
      const nName = document.createElement("span");
      nName.className = "le-name";
      nName.textContent = n;
      const nCount = document.createElement("span");
      nCount.className = "le-count";
      nCount.textContent = (LIB.data[g][n] || []).length + " 首";
      eh.appendChild(nName);
      eh.appendChild(nCount);
      const eacts = document.createElement("div");
      eacts.className = "acts";
      eacts.appendChild(mkBtn("＋歌", "tiny", () => libAddSong(g, n)));
      eacts.appendChild(mkBtn("重命名", "tiny", () => libRenameEntry(g, n)));
      eacts.appendChild(mkBtn("删除", "tiny danger", () => libRemoveEntry(g, n)));
      eh.appendChild(eacts);
      ent.appendChild(eh);

      const songs = document.createElement("div");
      songs.className = "lib-songs";
      for (const t of LIB.data[g][n] || []) {
        const chip = document.createElement("span");
        chip.className = "lib-chip";
        const nm = document.createElement("span");
        nm.textContent = t;
        chip.appendChild(nm);
        chip.appendChild(mkBtn("编辑", "tiny", () => libEditSong(g, n, t)));
        chip.appendChild(mkBtn("×", "tiny danger", () => libRemoveSong(g, n, t)));
        songs.appendChild(chip);
      }
      ent.appendChild(songs);
      ents.appendChild(ent);
    }
    card.appendChild(ents);
    box.appendChild(card);
  }
}

async function libAddGroup() {
  const g = prompt("新分类名称（如：虚拟歌姬 / 作者）：");
  if (!g) return;
  const j = await libAct("add_group", { group: g });
  flashLib(j.ok ? "已新增分类" : "失败：" + (j.msg || ""), j.ok);
  if (j.ok) loadLibrary();
}
async function libRenameGroup(from) {
  const to = prompt("重命名分类为：", from);
  if (!to || to === from) return;
  const j = await libAct("rename_group", { from, to });
  flashLib(j.ok ? "已重命名" : "失败：" + (j.msg || ""), j.ok);
  if (j.ok) loadLibrary();
}
async function libRemoveGroup(g) {
  if (!confirm("删除分类「" + g + "」及其下所有条目？此操作不可撤销。")) return;
  const j = await libAct("remove_group", { group: g });
  flashLib(j.ok ? "已删除分类" : "失败：" + (j.msg || ""), j.ok);
  if (j.ok) loadLibrary();
}
async function libAddEntry(g) {
  const n = prompt("在「" + g + "」下新增条目名称（如歌手名 / 作者名）：");
  if (!n) return;
  const j = await libAct("add_entry", { group: g, name: n });
  flashLib(j.ok ? "已新增条目" : "失败：" + (j.msg || ""), j.ok);
  if (j.ok) loadLibrary();
}
async function libRenameEntry(g, from) {
  const to = prompt("重命名条目为：", from);
  if (!to || to === from) return;
  const j = await libAct("rename_entry", { group: g, from, to });
  flashLib(j.ok ? "已重命名" : "失败：" + (j.msg || ""), j.ok);
  if (j.ok) loadLibrary();
}
async function libRemoveEntry(g, n) {
  if (!confirm("删除条目「" + n + "」及其下所有歌曲？")) return;
  const j = await libAct("remove_entry", { group: g, name: n });
  flashLib(j.ok ? "已删除条目" : "失败：" + (j.msg || ""), j.ok);
  if (j.ok) loadLibrary();
}
async function libAddSong(g, n) {
  const t = prompt("在「" + n + "」下新增歌曲名：");
  if (!t) return;
  const j = await libAct("add_song", { group: g, name: n, title: t });
  flashLib(j.ok ? "已添加歌曲" : "失败：" + (j.msg || ""), j.ok);
  if (j.ok) loadLibrary();
}
async function libEditSong(g, n, from) {
  const to = prompt("修改歌名为：", from);
  if (!to || to === from) return;
  const j = await libAct("edit_song", { group: g, name: n, from, to });
  flashLib(j.ok ? "已修改" : "失败：" + (j.msg || ""), j.ok);
  if (j.ok) loadLibrary();
}
async function libRemoveSong(g, n, t) {
  const j = await libAct("remove_song", { group: g, name: n, title: t });
  flashLib(j.ok ? "已删除歌曲" : "失败：" + (j.msg || ""), j.ok);
  if (j.ok) loadLibrary();
}
async function libReset() {
  if (!confirm("恢复默认曲库？这会覆盖当前所有后台改动。")) return;
  const j = await libAct("reset", {});
  flashLib(j.ok ? "已恢复默认曲库" : "失败：" + (j.msg || ""), j.ok);
  if (j.ok) loadLibrary();
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
