"use strict";

const state = {
  playlists: [],
  selectedPlaylist: null,
  playlistInfo: null,
  mode: "range",
  sortOrder: "asc",
  jobPolling: false,
  currentJob: null,
  unavailableTracks: [],
  appInitialized: false,
  analysisRequestId: 0,
  donationShownJobs: new Set(),
  legalMode: "startup",
};

const elements = {
  addPublicPlaylistButton: document.getElementById("addPublicPlaylistButton"),
  analysisAvailable: document.getElementById("analysisAvailable"),
  analysisDescription: document.getElementById("analysisDescription"),
  analysisMissingCover: document.getElementById("analysisMissingCover"),
  analysisRestricted: document.getElementById("analysisRestricted"),
  analysisTotal: document.getElementById("analysisTotal"),
  analysisUnavailable: document.getElementById("analysisUnavailable"),
  cancelButton: document.getElementById("cancelButton"),
  downloadButton: document.getElementById("downloadButton"),
  donationCloseButton: document.getElementById("donationCloseButton"),
  donationDoneButton: document.getElementById("donationDoneButton"),
  donationModal: document.getElementById("donationModal"),
  donationSkipButton: document.getElementById("donationSkipButton"),
  endIndex: document.getElementById("endIndex"),
  imageSize: document.getElementById("imageSize"),
  indicesFields: document.getElementById("indicesFields"),
  indicesInput: document.getElementById("indicesInput"),
  legalAgreeCheckbox: document.getElementById("legalAgreeCheckbox"),
  legalConsentRow: document.querySelector(".legal-consent"),
  legalContinueButton: document.getElementById("legalContinueButton"),
  legalExitButton: document.getElementById("legalExitButton"),
  legalModal: document.getElementById("legalModal"),
  logPanel: document.getElementById("logPanel"),
  openFolderButton: document.getElementById("openFolderButton"),
  orderDescription: document.getElementById("orderDescription"),
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
  toggleUnavailableButton: document.getElementById("toggleUnavailableButton"),
  trackPreviewBody: document.getElementById("trackPreviewBody"),
  unavailableList: document.getElementById("unavailableList"),
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

function getErrorMessage(error) {
  return error && error.message ? error.message : "发生未知错误。";
}

function normalizeOutputPathText(value) {
  let text = String(value || "").trim();
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'")))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

async function loadSession() {
  try {
    const data = await api("/api/session");
    if (data.playlistCount > 0) {
      await loadPlaylists();
    }
  } catch (error) {
    showToast(getErrorMessage(error), "error");
  }
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
    elements.refreshPlaylistsButton.disabled = state.playlists.length === 0;
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
      ...state.playlists.filter(
        (playlist) =>
          playlist.id !== data.playlist.id ||
          playlist.provider !== data.playlist.provider,
      ),
    ];
    elements.publicPlaylistInput.value = "";
    elements.playlistSearch.disabled = false;
    renderPlaylists();
    await selectPlaylist(data.playlist);
    showToast(
      `${data.playlist.provider === "qq" ? "QQ 音乐" : "网易云音乐"}歌单已读取。`,
      "success",
    );
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
  const requestId = state.analysisRequestId + 1;
  state.analysisRequestId = requestId;
  updateImageSizeOptions(playlist.provider);
  renderPlaylists();
  elements.workspaceEmpty.classList.add("is-hidden");
  elements.workspaceContent.classList.remove("is-hidden");
  elements.selectedPlaylistName.textContent = playlist.name;
  elements.selectedTrackCount.textContent = playlist.trackCount;
  elements.orderDescription.textContent =
    playlist.provider === "qq"
      ? state.sortOrder === "desc"
        ? "序号按 QQ 音乐歌单返回顺序倒序排列"
        : "序号按 QQ 音乐歌单返回顺序排列"
      : state.sortOrder === "desc"
        ? "序号按加入时间从晚到早排列"
        : "序号按加入时间从早到晚排列";
  elements.selectedCover.classList.toggle("has-image", Boolean(playlist.coverUrl));
  elements.selectedCover.style.backgroundImage = playlist.coverUrl
    ? `url("${playlist.coverUrl.replace(/"/g, "%22")}")`
    : "";
  resetAnalysis();
  elements.downloadButton.disabled = true;
  elements.trackPreviewBody.replaceChildren();
  const loadingRow = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = 5;
  cell.className = "table-loading";
  cell.textContent = "正在识别歌曲总数和版权状态...";
  loadingRow.append(cell);
  elements.trackPreviewBody.append(loadingRow);
  resetJob();

  try {
    const provider = playlist.provider || "netease";
    const data = await api(
      `/api/playlists/${encodeURIComponent(provider)}/${encodeURIComponent(playlist.id)}/preview?count=50&order=${encodeURIComponent(state.sortOrder)}`,
    );
    if (requestId !== state.analysisRequestId) {
      return;
    }
    state.playlistInfo = data;
    elements.analysisDescription.textContent =
      provider === "qq"
        ? "QQ 音乐封面地址来自公开分享歌单接口，封面下载与音频付费状态无关。"
        : "版权状态根据网易云返回的歌曲状态和 noCopyrightRcmd 字段判断。";
    state.selectedPlaylist.trackCount = data.trackCount;
    elements.selectedTrackCount.textContent = data.trackCount;
    elements.startIndex.max = String(data.trackCount);
    elements.endIndex.max = String(data.trackCount);
    elements.startIndex.value = "1";
    elements.endIndex.value = String(Math.min(10, data.trackCount));
    elements.indicesInput.value = "";
    elements.downloadButton.disabled = data.trackCount < 1;
    renderAnalysis(data);
    renderTrackPreview(data.preview);
    updateSelectionSummary();
  } catch (error) {
    if (requestId !== state.analysisRequestId) {
      return;
    }
    const errorRow = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.className = "table-empty";
    cell.textContent = getErrorMessage(error);
    errorRow.append(cell);
    elements.trackPreviewBody.replaceChildren(errorRow);
    elements.analysisTotal.textContent = "—";
    elements.analysisDescription.textContent = `识别失败：${getErrorMessage(error)}`;
    showToast(getErrorMessage(error), "error");
  }
}

function updateImageSizeOptions(provider) {
  const options = elements.imageSize.querySelectorAll("option");
  if (provider === "qq") {
    options[0].textContent = "800 × 800（QQ 音乐最高可用）";
    options[1].textContent = "500 × 500";
  } else {
    options[0].textContent = "1080 × 1080（推荐）";
    options[1].textContent = "640 × 640";
  }
}

function renderTrackPreview(tracks) {
  elements.trackPreviewBody.replaceChildren();
  if (!tracks || tracks.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
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

    const statusCell = document.createElement("td");
    const status = document.createElement("span");
    status.className = `status-pill status-${track.availability || "available"}`;
    status.textContent = track.availabilityLabel || "正常";
    status.title = track.availabilityReason || "";
    statusCell.append(status);

    const timeCell = document.createElement("td");
    timeCell.className = "muted-cell";
    timeCell.textContent = track.addedAt
      ? formatDate(track.addedAt)
      : state.selectedPlaylist && state.selectedPlaylist.provider === "qq"
        ? "歌单顺序"
        : "未知";

    row.append(indexCell, songCell, albumCell, statusCell, timeCell);
    elements.trackPreviewBody.append(row);
  }
}

function resetAnalysis() {
  state.unavailableTracks = [];
  elements.analysisTotal.textContent = "0";
  elements.analysisAvailable.textContent = "0";
  elements.analysisRestricted.textContent = "0";
  elements.analysisUnavailable.textContent = "0";
  elements.analysisMissingCover.textContent = "0";
  elements.toggleUnavailableButton.classList.add("is-hidden");
  elements.unavailableList.classList.add("is-hidden");
  elements.unavailableList.replaceChildren();
}

function renderAnalysis(data) {
  const summary = data.summary || {};
  state.unavailableTracks = Array.isArray(data.unavailableTracks)
    ? data.unavailableTracks
    : [];
  elements.analysisTotal.textContent = String(summary.total || data.trackCount || 0);
  elements.analysisAvailable.textContent = String(summary.available || 0);
  elements.analysisRestricted.textContent = String(summary.restricted || 0);
  elements.analysisUnavailable.textContent = String(summary.unavailable || 0);
  elements.analysisMissingCover.textContent = String(summary.missingCover || 0);

  if (state.unavailableTracks.length === 0) {
    elements.toggleUnavailableButton.classList.add("is-hidden");
    elements.unavailableList.classList.add("is-hidden");
    elements.unavailableList.replaceChildren();
    return;
  }

  elements.toggleUnavailableButton.textContent = `查看无版权歌曲（${state.unavailableTracks.length}）`;
  elements.toggleUnavailableButton.classList.remove("is-hidden");
  elements.unavailableList.replaceChildren();
  for (const track of state.unavailableTracks) {
    const item = document.createElement("div");
    item.className = "unavailable-item";

    const index = document.createElement("span");
    index.className = "unavailable-index";
    index.textContent = `#${track.index}`;

    const name = document.createElement("span");
    name.className = "unavailable-name";
    name.textContent = `${track.name}${track.artists.length ? ` - ${track.artists.join("、")}` : ""}`;
    name.title = name.textContent;

    const reason = document.createElement("span");
    reason.className = "unavailable-reason";
    reason.textContent = track.canDownloadCover ? "封面可下载" : "无封面";

    item.append(index, name, reason);
    elements.unavailableList.append(item);
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

async function setSortOrder(order) {
  state.sortOrder = order === "desc" ? "desc" : "asc";
  for (const button of document.querySelectorAll(".sort-option")) {
    const active = button.dataset.order === state.sortOrder;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  if (state.selectedPlaylist) {
    await selectPlaylist(state.selectedPlaylist);
  }
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
        playlistProvider: state.selectedPlaylist.provider || "netease",
        sortOrder: state.sortOrder,
        mode: state.mode,
        start: elements.startIndex.value,
        end: elements.endIndex.value,
        selection: elements.indicesInput.value,
        imageSize: elements.imageSize.value,
        outputDir: normalizeOutputPathText(elements.outputDir.value),
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
          if (!state.donationShownJobs.has(job.id)) {
            state.donationShownJobs.add(job.id);
            window.setTimeout(showDonationModal, 900);
          }
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
elements.toggleUnavailableButton.addEventListener("click", () => {
  elements.unavailableList.classList.toggle("is-hidden");
});
elements.downloadButton.addEventListener("click", startDownload);
elements.outputDir.addEventListener("blur", () => {
  elements.outputDir.value = normalizeOutputPathText(elements.outputDir.value);
});
elements.startIndex.addEventListener("input", updateSelectionSummary);
elements.endIndex.addEventListener("input", updateSelectionSummary);
elements.indicesInput.addEventListener("input", updateSelectionSummary);
for (const button of document.querySelectorAll(".segment")) {
  button.addEventListener("click", () => setMode(button.dataset.mode));
}
for (const button of document.querySelectorAll(".sort-option")) {
  button.addEventListener("click", () => setSortOrder(button.dataset.order));
}

async function initialize() {
  if (state.appInitialized) {
    return;
  }
  state.appInitialized = true;
  setMode("range");
  resetJob();
  await loadSession();

  const autoPlaylist = new URLSearchParams(window.location.search).get("playlist");
  if (autoPlaylist) {
    elements.publicPlaylistInput.value = autoPlaylist;
    await addPublicPlaylist();
  }
}

function setAppInert(value) {
  document.querySelector(".topbar").inert = value;
  document.querySelector(".app-shell").inert = value;
}

function showDonationModal() {
  setAppInert(true);
  document.body.classList.add("legal-locked");
  elements.donationModal.classList.remove("is-hidden");
}

function closeDonationModal() {
  elements.donationModal.classList.add("is-hidden");
  document.body.classList.remove("legal-locked");
  setAppInert(false);
  showToast("感谢使用", "success");
  window.setTimeout(showSafetyNotice, 900);
}

function showSafetyNotice() {
  state.legalMode = "safety";
  elements.legalAgreeCheckbox.checked = true;
  elements.legalContinueButton.disabled = false;
  elements.legalContinueButton.textContent = "我已知晓";
  elements.legalConsentRow.classList.add("is-hidden");
  elements.legalExitButton.classList.add("is-hidden");
  elements.legalModal.classList.remove("is-hidden");
  document.body.classList.add("legal-locked");
  setAppInert(true);
}

function restoreStartupLegalControls() {
  elements.legalConsentRow.classList.remove("is-hidden");
  elements.legalExitButton.classList.remove("is-hidden");
  elements.legalContinueButton.textContent = "我已知晓，仅限个人本地使用";
}

function initializeLegalNotice() {
  state.legalMode = "startup";
  document.body.classList.add("legal-locked");
  setAppInert(true);
  elements.legalContinueButton.disabled = !elements.legalAgreeCheckbox.checked;

  elements.legalAgreeCheckbox.addEventListener("change", () => {
    elements.legalContinueButton.disabled = !elements.legalAgreeCheckbox.checked;
  });
  elements.legalContinueButton.addEventListener("click", () => {
    if (state.legalMode === "startup" && !elements.legalAgreeCheckbox.checked) {
      return;
    }
    elements.legalModal.classList.add("is-hidden");
    document.body.classList.remove("legal-locked");
    setAppInert(false);
    if (state.legalMode === "startup") {
      restoreStartupLegalControls();
      initialize();
    } else {
      restoreStartupLegalControls();
      state.legalMode = "startup";
    }
  });
  elements.legalExitButton.addEventListener("click", () => {
    window.close();
    elements.legalExitButton.textContent = "请关闭此页面";
    elements.legalContinueButton.disabled = true;
    elements.legalAgreeCheckbox.disabled = true;
  });
  elements.legalAgreeCheckbox.focus();
}

elements.donationCloseButton.addEventListener("click", closeDonationModal);
elements.donationSkipButton.addEventListener("click", closeDonationModal);
elements.donationDoneButton.addEventListener("click", closeDonationModal);

initializeLegalNotice();
