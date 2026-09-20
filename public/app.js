"use strict";

const state = {
  loggedIn: false,
  profile: null,
  playlists: [],
  selectedPlaylist: null,
  playlistInfo: null,
  mode: "range",
  loginPolling: false,
  jobPolling: false,
  currentJob: null,
};

const elements = {
  accountDot: document.getElementById("accountDot"),
  accountText: document.getElementById("accountText"),
  addPublicPlaylistButton: document.getElementById("addPublicPlaylistButton"),
  cancelButton: document.getElementById("cancelButton"),
  downloadButton: document.getElementById("downloadButton"),
  endIndex: document.getElementById("endIndex"),
  imageSize: document.getElementById("imageSize"),
  indicesFields: document.getElementById("indicesFields"),
  indicesInput: document.getElementById("indicesInput"),
  logPanel: document.getElementById("logPanel"),
  loginBadge: document.getElementById("loginBadge"),
  loginButton: document.getElementById("loginButton"),
  loginButtonText: document.getElementById("loginButtonText"),
  loginHelp: document.getElementById("loginHelp"),
  loginLink: document.getElementById("loginLink"),
  logoutButton: document.getElementById("logoutButton"),
  openFolderButton: document.getElementById("openFolderButton"),
  outputDir: document.getElementById("outputDir"),
  overwrite: document.getElementById("overwrite"),
  playlistList: document.getElementById("playlistList"),
  playlistSearch: document.getElementById("playlistSearch"),
  progressArea: document.getElementById("progressArea"),
  progressBar: document.getElementById("progressBar"),
  progressCount: document.getElementById("progressCount"),
  progressCurrent: document.getElementById("progressCurrent"),
  progressLabel: document.getElementById("progressLabel"),
  publicPlaylistInput: document.getElementById("publicPlaylistInput"),
  rangeFields: document.getElementById("rangeFields"),
  refreshPlaylistsButton: document.getElementById("refreshPlaylistsButton"),
  selectedCover: document.getElementById("selectedCover"),
  selectedPlaylistName: document.getElementById("selectedPlaylistName"),
  selectedTrackCount: document.getElementById("selectedTrackCount"),
  selectionSummary: document.getElementById("selectionSummary"),
  startIndex: document.getElementById("startIndex"),
  toast: document.getElementById("toast"),
  trackPreviewBody: document.getElementById("trackPreviewBody"),
  workspaceContent: document.getElementById("workspaceContent"),
  workspaceEmpty: document.getElementById("workspaceEmpty"),
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `请求失败（HTTP ${response.status}）`);
  }
  return data;
}

let toastTimer = 0;
function showToast(message, type = "") {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast${type ? ` is-${type}` : ""}`;
  toastTimer = window.setTimeout(() => {
    elements.toast.className = "toast is-hidden";
  }, 4200);
}

function setAccount(profile) {
  state.profile = profile;
  state.loggedIn = Boolean(profile);
  elements.accountDot.classList.toggle("is-online", Boolean(profile));
  elements.accountText.textContent = profile ? profile.nickname : "尚未登录";
  elements.logoutButton.classList.toggle("is-hidden", !profile);
  elements.refreshPlaylistsButton.disabled = !profile;
  elements.playlistSearch.disabled = !profile && state.playlists.length === 0;
  elements.loginButton.disabled = Boolean(profile);
  elements.loginButtonText.textContent = profile ? "已登录" : "获取登录二维码";

  if (profile) {
    elements.loginBadge.textContent = "已登录";
    elements.loginBadge.className = "state-badge is-success";
    elements.loginHelp.textContent =
      "已读取登录状态。程序只读取歌单和封面，不会修改歌单、收藏或账号设置。";
    elements.loginLink.classList.add("is-hidden");
  } else {
    elements.loginBadge.textContent = "未登录";
    elements.loginBadge.className = "state-badge";
    elements.loginHelp.textContent =
      "点击后请在官方页面中选择“网易云音乐 App 扫码”，再用手机网易云音乐扫描。微信扫码或网页账号密码登录不会同步。";
  }
}

function setLoginProgress(text, badgeType = "warning") {
  elements.loginBadge.textContent = text;
  elements.loginBadge.className = `state-badge is-${badgeType}`;
}

function getErrorMessage(error) {
  return error && error.message ? error.message : "发生未知错误。";
}

async function loadSession() {
  try {
    const data = await api("/api/session");
    setAccount(data.profile);
    if (data.loggedIn || data.playlistCount > 0) {
      await loadPlaylists();
    }
  } catch (error) {
    showToast(getErrorMessage(error), "error");
  }
}

async function startLogin() {
  const popup = window.open("about:blank", "netease-login");
  elements.loginButton.disabled = true;
  elements.loginButtonText.textContent = "正在获取二维码...";
  elements.loginLink.classList.add("is-hidden");

  try {
    const data = await api("/api/login/start", {
      method: "POST",
      body: "{}",
    });
    elements.loginLink.href = data.url;
    elements.loginLink.classList.remove("is-hidden");
    if (popup) {
      popup.location.href = data.url;
    } else {
      window.open(data.url, "_blank");
    }
    setLoginProgress("等待扫码");
    elements.loginHelp.textContent =
      "请在浏览器页面中选择“网易云音乐 App 扫码”，再用手机网易云音乐扫描。不要使用微信扫码或网页账号密码登录，它们不会同步到本程序。";
    elements.loginButton.disabled = false;
    elements.loginButtonText.textContent = "重新获取二维码";
    startLoginPolling();
  } catch (error) {
    if (popup) {
      popup.close();
    }
    elements.loginButton.disabled = false;
    elements.loginButtonText.textContent = "重新获取二维码";
    setAccount(null);
    showToast(getErrorMessage(error), "error");
  }
}

async function startLoginPolling() {
  if (state.loginPolling) {
    return;
  }
  state.loginPolling = true;

  const poll = async () => {
    if (!state.loginPolling) {
      return;
    }
    try {
      const data = await api("/api/login/poll");
      if (data.state === "success") {
        state.loginPolling = false;
        setAccount(data.profile);
        showToast("登录成功，正在读取歌单。", "success");
        await loadPlaylists();
        return;
      }
      if (data.state === "confirming") {
        setLoginProgress("等待确认");
        elements.loginHelp.textContent = "已扫码，请在手机上点击确认登录。";
      } else if (data.state === "expired") {
        state.loginPolling = false;
        setLoginProgress("已过期", "warning");
        elements.loginButton.disabled = false;
        elements.loginButtonText.textContent = "重新获取二维码";
        elements.loginHelp.textContent = data.message || "二维码已过期，请重新获取。";
        return;
      } else {
        setLoginProgress("等待扫码");
      }
    } catch (error) {
      state.loginPolling = false;
      elements.loginButton.disabled = false;
      elements.loginButtonText.textContent = "重新获取二维码";
      showToast(getErrorMessage(error), "error");
      return;
    }
    window.setTimeout(poll, 1600);
  };

  poll();
}

async function loadPlaylists() {
  elements.refreshPlaylistsButton.disabled = true;
  try {
    const data = await api("/api/playlists");
    state.playlists = data.playlists || [];
    renderPlaylists();
  } catch (error) {
    showToast(getErrorMessage(error), "error");
  } finally {
    elements.refreshPlaylistsButton.disabled = !state.loggedIn;
  }
}

async function addPublicPlaylist() {
  const input = elements.publicPlaylistInput.value.trim();
  elements.addPublicPlaylistButton.disabled = true;
  try {
    const data = await api("/api/public-playlist", {
      method: "POST",
      body: JSON.stringify({ input }),
    });
    state.playlists = [
      data.playlist,
      ...state.playlists.filter((playlist) => playlist.id !== data.playlist.id),
    ];
    elements.publicPlaylistInput.value = "";
    elements.playlistSearch.disabled = false;
    renderPlaylists();
    await selectPlaylist(data.playlist);
    showToast("公开歌单已读取。", "success");
  } catch (error) {
    showToast(getErrorMessage(error), "error");
  } finally {
    elements.addPublicPlaylistButton.disabled = false;
  }
}

function renderPlaylists() {
  const query = elements.playlistSearch.value.trim().toLocaleLowerCase();
  const filtered = state.playlists.filter((playlist) =>
    playlist.name.toLocaleLowerCase().includes(query),
  );
  elements.playlistSearch.disabled = state.playlists.length === 0;

  elements.playlistList.replaceChildren();
  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-list";
    const text = document.createElement("p");
    text.textContent = state.playlists.length === 0 ? "没有读取到歌单" : "没有匹配的歌单";
    empty.append(text);
    elements.playlistList.append(empty);
    return;
  }

  for (const playlist of filtered) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "playlist-item";
    button.classList.toggle(
      "is-selected",
      state.selectedPlaylist && state.selectedPlaylist.id === playlist.id,
    );

    const thumb = document.createElement("span");
    thumb.className = "playlist-thumb";
    if (playlist.coverUrl) {
      const image = document.createElement("img");
      image.src = playlist.coverUrl;
      image.alt = "";
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => image.remove());
      thumb.append(image);
    }

    const info = document.createElement("span");
    info.className = "playlist-info";
    const name = document.createElement("span");
    name.className = "playlist-name";
    name.textContent = playlist.name;
    const meta = document.createElement("span");
    meta.className = "playlist-meta";
    if (playlist.specialType === 5) {
      meta.textContent = "我喜欢的音乐";
    } else if (playlist.owned) {
      meta.textContent = "我创建的歌单";
    } else {
      meta.textContent = playlist.creator ? `来自 ${playlist.creator}` : "收藏的歌单";
    }
    info.append(name, meta);

    const count = document.createElement("span");
    count.className = "playlist-count";
    count.textContent = `${playlist.trackCount} 首`;

    button.append(thumb, info, count);
    button.addEventListener("click", () => selectPlaylist(playlist));
    elements.playlistList.append(button);
  }
}

async function selectPlaylist(playlist) {
  if (
    state.currentJob &&
    ["queued", "running"].includes(state.currentJob.status)
  ) {
    showToast("当前还有下载任务，请等待完成或先取消任务。", "error");
    return;
  }

  state.selectedPlaylist = playlist;
  state.playlistInfo = null;
  renderPlaylists();
  elements.workspaceEmpty.classList.add("is-hidden");
  elements.workspaceContent.classList.remove("is-hidden");
  elements.selectedPlaylistName.textContent = playlist.name;
  elements.selectedTrackCount.textContent = playlist.trackCount;
  elements.selectedCover.classList.toggle("has-image", Boolean(playlist.coverUrl));
  elements.selectedCover.style.backgroundImage = playlist.coverUrl
    ? `url("${playlist.coverUrl.replace(/"/g, "%22")}")`
    : "";
  elements.downloadButton.disabled = true;
  elements.trackPreviewBody.replaceChildren();
  const loadingRow = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = 4;
  cell.className = "table-loading";
  cell.textContent = "正在计算最新加入顺序...";
  loadingRow.append(cell);
  elements.trackPreviewBody.append(loadingRow);
  resetJob();

  try {
    const data = await api(`/api/playlists/${encodeURIComponent(playlist.id)}/preview?count=30`);
    state.playlistInfo = data;
    state.selectedPlaylist.trackCount = data.trackCount;
    elements.selectedTrackCount.textContent = data.trackCount;
    elements.startIndex.max = String(data.trackCount);
    elements.endIndex.max = String(data.trackCount);
    elements.startIndex.value = "1";
    elements.endIndex.value = String(Math.min(10, data.trackCount));
    elements.indicesInput.value = "";
    elements.downloadButton.disabled = data.trackCount < 1;
    renderTrackPreview(data.preview);
    updateSelectionSummary();
  } catch (error) {
    const errorRow = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.className = "table-empty";
    cell.textContent = getErrorMessage(error);
    errorRow.append(cell);
    elements.trackPreviewBody.replaceChildren(errorRow);
    showToast(getErrorMessage(error), "error");
  }
}

function renderTrackPreview(tracks) {
  elements.trackPreviewBody.replaceChildren();
  if (!tracks || tracks.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.className = "table-empty";
    cell.textContent = "歌单里没有歌曲";
    row.append(cell);
    elements.trackPreviewBody.append(row);
    return;
  }

  for (const track of tracks) {
    const row = document.createElement("tr");

    const indexCell = document.createElement("td");
    indexCell.className = "index-cell";
    indexCell.textContent = String(track.index);

    const songCell = document.createElement("td");
    songCell.className = "song-cell";
    songCell.textContent = track.name;

    const albumCell = document.createElement("td");
    albumCell.className = "muted-cell";
    albumCell.textContent = track.album || "-";

    const timeCell = document.createElement("td");
    timeCell.className = "muted-cell";
    timeCell.textContent = formatDate(track.addedAt);

    row.append(indexCell, songCell, albumCell, timeCell);
    elements.trackPreviewBody.append(row);
  }
}

function formatDate(timestamp) {
  if (!timestamp) {
    return "未知";
  }
  return new Date(timestamp).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function parseLocalSelection() {
  const count = state.playlistInfo ? state.playlistInfo.trackCount : 0;
  if (count < 1) {
    throw new Error("歌单里没有可下载的歌曲。");
  }

  if (state.mode === "range") {
    const start = Number(elements.startIndex.value);
    const end = Number(elements.endIndex.value);
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new Error("请填写有效的起止序号。");
    }
    if (start < 1 || end < 1 || start > end) {
      throw new Error("请检查起止序号，起始值应不大于结束值。");
    }
    if (end > count) {
      throw new Error(`结束序号不能超过 ${count}。`);
    }
    return end - start + 1;
  }

  const text = elements.indicesInput.value
    .replace(/[，、；;\s]+/g, ",")
    .trim();
  if (!text) {
    throw new Error("请填写要下载的序号，例如 1,3,8-12。");
  }

  const values = new Set();
  for (const token of text.split(",").filter(Boolean)) {
    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(token);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (start < 1 || end < 1 || start > end) {
        throw new Error(`无效的序号范围：${token}`);
      }
      for (let value = start; value <= end; value += 1) {
        if (value > count) {
          throw new Error(`序号 ${value} 超过歌曲总数 ${count}。`);
        }
        values.add(value);
      }
      continue;
    }
    if (!/^\d+$/.test(token)) {
      throw new Error(`无法识别序号：${token}`);
    }
    const value = Number(token);
    if (value > count) {
      throw new Error(`序号 ${value} 超过歌曲总数 ${count}。`);
    }
    values.add(value);
  }
  return values.size;
}

function updateSelectionSummary() {
  try {
    const count = parseLocalSelection();
    elements.selectionSummary.textContent = `预计选择 ${count} 首封面`;
  } catch (error) {
    elements.selectionSummary.textContent = getErrorMessage(error);
  }
}

function setMode(mode) {
  state.mode = mode;
  for (const button of document.querySelectorAll(".segment")) {
    const active = button.dataset.mode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  elements.rangeFields.classList.toggle("is-hidden", mode !== "range");
  elements.indicesFields.classList.toggle("is-hidden", mode !== "indices");
  updateSelectionSummary();
}

function resetJob() {
  state.currentJob = null;
  state.jobPolling = false;
  elements.cancelButton.classList.add("is-hidden");
  elements.openFolderButton.classList.add("is-hidden");
  elements.progressBar.style.width = "0%";
  elements.progressCount.textContent = "0 / 0";
  elements.progressCurrent.textContent = "";
  elements.progressLabel.textContent = "等待开始";
  elements.logPanel.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "log-empty";
  empty.textContent = "下载日志会显示在这里";
  elements.logPanel.append(empty);
}

async function startDownload() {
  if (!state.selectedPlaylist) {
    showToast("请先选择歌单。", "error");
    return;
  }
  try {
    parseLocalSelection();
  } catch (error) {
    showToast(getErrorMessage(error), "error");
    return;
  }

  elements.downloadButton.disabled = true;
  elements.openFolderButton.classList.add("is-hidden");
  try {
    const job = await api("/api/download", {
      method: "POST",
      body: JSON.stringify({
        playlistId: state.selectedPlaylist.id,
        mode: state.mode,
        start: elements.startIndex.value,
        end: elements.endIndex.value,
        selection: elements.indicesInput.value,
        imageSize: elements.imageSize.value,
        outputDir: elements.outputDir.value,
        overwrite: elements.overwrite.checked,
      }),
    });
    state.currentJob = job;
    elements.cancelButton.classList.remove("is-hidden");
    elements.progressLabel.textContent = "任务已创建";
    renderJob(job);
    startJobPolling();
  } catch (error) {
    elements.downloadButton.disabled = false;
    showToast(getErrorMessage(error), "error");
  }
}

function startJobPolling() {
  if (state.jobPolling || !state.currentJob) {
    return;
  }
  state.jobPolling = true;

  const poll = async () => {
    if (!state.jobPolling || !state.currentJob) {
      return;
    }
    try {
      const job = await api(`/api/download/${encodeURIComponent(state.currentJob.id)}`);
      state.currentJob = job;
      renderJob(job);
      if (["completed", "failed", "cancelled"].includes(job.status)) {
        state.jobPolling = false;
        elements.cancelButton.classList.add("is-hidden");
        elements.downloadButton.disabled = false;
        if (job.downloadDir) {
          elements.openFolderButton.classList.remove("is-hidden");
        }
        if (job.status === "completed") {
          showToast(`下载完成：成功 ${job.success}，失败 ${job.failed}。`, "success");
        }
        return;
      }
    } catch (error) {
      state.jobPolling = false;
      elements.cancelButton.classList.add("is-hidden");
      elements.downloadButton.disabled = false;
      showToast(getErrorMessage(error), "error");
      return;
    }
    window.setTimeout(poll, 700);
  };

  poll();
}

function renderJob(job) {
  const total = Number(job.total || 0);
  const completed = Number(job.completed || 0);
  const percentage = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  elements.progressBar.style.width = `${percentage}%`;
  elements.progressCount.textContent = `${completed} / ${total}`;
  elements.progressCurrent.textContent = job.current || job.downloadDir || "";
  elements.progressLabel.textContent =
    job.status === "queued"
      ? "正在准备"
      : job.status === "running"
        ? "正在下载"
        : job.status === "completed"
          ? "下载完成"
          : job.status === "cancelled"
            ? "已取消"
            : "任务失败";

  elements.logPanel.replaceChildren();
  const logs = Array.isArray(job.logs) ? job.logs.slice(-80) : [];
  if (logs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "log-empty";
    empty.textContent = "正在等待日志...";
    elements.logPanel.append(empty);
    return;
  }

  for (const log of logs) {
    const line = document.createElement("div");
    line.className = `log-line ${log.level || "info"}`;
    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = new Date(log.time).toLocaleTimeString("zh-CN", {
      hour12: false,
    });
    const message = document.createElement("span");
    message.className = "log-message";
    message.textContent = log.message;
    line.append(time, message);
    elements.logPanel.append(line);
  }
  elements.logPanel.scrollTop = elements.logPanel.scrollHeight;
}

async function cancelJob() {
  if (!state.currentJob) {
    return;
  }
  elements.cancelButton.disabled = true;
  try {
    const job = await api(
      `/api/download/${encodeURIComponent(state.currentJob.id)}/cancel`,
      { method: "POST", body: "{}" },
    );
    state.currentJob = job;
    renderJob(job);
  } catch (error) {
    showToast(getErrorMessage(error), "error");
  } finally {
    elements.cancelButton.disabled = false;
  }
}

async function openFolder() {
  const folder = state.currentJob && state.currentJob.downloadDir;
  if (!folder) {
    return;
  }
  try {
    await api("/api/reveal", {
      method: "POST",
      body: JSON.stringify({ path: folder }),
    });
  } catch (error) {
    showToast(getErrorMessage(error), "error");
  }
}

async function logout() {
  state.loginPolling = false;
  state.jobPolling = false;
  const publicPlaylists = state.playlists.filter((playlist) => playlist.public);
  state.playlists = publicPlaylists;
  if (!state.selectedPlaylist || !state.selectedPlaylist.public) {
    state.selectedPlaylist = null;
  }
  state.playlistInfo = null;
  state.currentJob = null;
  if (state.selectedPlaylist) {
    elements.workspaceContent.classList.remove("is-hidden");
    elements.workspaceEmpty.classList.add("is-hidden");
  } else {
    elements.workspaceContent.classList.add("is-hidden");
    elements.workspaceEmpty.classList.remove("is-hidden");
  }
  elements.playlistSearch.value = "";
  renderPlaylists();
  resetJob();
  setAccount(null);
  try {
    await api("/api/logout", { method: "POST", body: "{}" });
  } catch (error) {
    showToast(getErrorMessage(error), "error");
  }
}

elements.loginButton.addEventListener("click", startLogin);
elements.addPublicPlaylistButton.addEventListener("click", addPublicPlaylist);
elements.publicPlaylistInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    addPublicPlaylist();
  }
});
elements.refreshPlaylistsButton.addEventListener("click", loadPlaylists);
elements.playlistSearch.addEventListener("input", renderPlaylists);
elements.cancelButton.addEventListener("click", cancelJob);
elements.openFolderButton.addEventListener("click", openFolder);
elements.logoutButton.addEventListener("click", logout);
elements.downloadButton.addEventListener("click", startDownload);
elements.startIndex.addEventListener("input", updateSelectionSummary);
elements.endIndex.addEventListener("input", updateSelectionSummary);
elements.indicesInput.addEventListener("input", updateSelectionSummary);
for (const button of document.querySelectorAll(".segment")) {
  button.addEventListener("click", () => setMode(button.dataset.mode));
}

async function initialize() {
  setMode("range");
  resetJob();
  await loadSession();

  const autoPlaylist = new URLSearchParams(window.location.search).get("playlist");
  if (autoPlaylist) {
    elements.publicPlaylistInput.value = autoPlaylist;
    await addPublicPlaylist();
  }
}

initialize();
