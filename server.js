"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  assertReadOnlyNeteaseEndpoint,
  buildCoverUrl,
  formatFileName,
  parsePlaylistId,
  parseSelection,
  sanitizeFileName,
  sortTrackIdsByAdded,
} = require("./core");

const API_BASE = "https://music.163.com";
const PUBLIC_DIR = path.join(__dirname, "public");
const BASE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Referer: "https://music.163.com/",
};

const state = {
  cookies: [],
  loginKey: "",
  loginStatus: "idle",
  profile: null,
  playlists: [],
  publicPlaylists: new Map(),
  playlistCache: new Map(),
  jobs: new Map(),
};

function jsonResponse(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function textResponse(response, statusCode, body, contentType = "text/plain") {
  response.writeHead(statusCode, {
    "Content-Type": `${contentType}; charset=utf-8`,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function requireLogin() {
  if (!state.profile || state.cookies.length === 0) {
    const error = new Error("请先扫码登录网易云音乐。");
    error.statusCode = 401;
    throw error;
  }
}

function cookieHeader() {
  return state.cookies.join("; ");
}

function mergeSetCookies(setCookies) {
  const jar = new Map();
  for (const item of state.cookies) {
    const [pair] = item.split(";");
    const separator = pair.indexOf("=");
    if (separator > 0) {
      jar.set(pair.slice(0, separator), pair);
    }
  }

  for (const rawCookie of setCookies || []) {
    const [pair] = String(rawCookie).split(";");
    const separator = pair.indexOf("=");
    if (separator > 0) {
      jar.set(pair.slice(0, separator), pair);
    }
  }
  state.cookies = [...jar.values()];
}

function getSetCookies(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }
  const header = response.headers.get("set-cookie");
  return header ? [header] : [];
}

async function neteaseRequest(
  pathname,
  { useCookies = true, timeout = 30000 } = {},
) {
  assertReadOnlyNeteaseEndpoint(pathname);
  const headers = { ...BASE_HEADERS };
  if (useCookies && state.cookies.length > 0) {
    headers.Cookie = cookieHeader();
  }

  const response = await fetch(`${API_BASE}${pathname}`, {
    method: "GET",
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { response, text, data };
}

async function fetchProfile() {
  const { data } = await neteaseRequest("/api/nuser/account/get");
  if (!data || data.code !== 200 || !data.profile) {
    return null;
  }
  return {
    userId: data.profile.userId,
    nickname: data.profile.nickname,
    avatarUrl: data.profile.avatarUrl,
  };
}

async function startLogin() {
  state.cookies = [];
  state.profile = null;
  state.playlists = [...state.publicPlaylists.values()];
  state.playlistCache.clear();
  state.loginStatus = "starting";

  const { data } = await neteaseRequest(
    "/api/login/qrcode/unikey?type=1",
    { useCookies: false },
  );
  if (!data || data.code !== 200 || !data.unikey) {
    throw new Error("无法创建扫码登录会话，请稍后重试。");
  }

  state.loginKey = data.unikey;
  state.loginStatus = "waiting";
  return {
    key: data.unikey,
    url: `https://music.163.com/login?codekey=${encodeURIComponent(data.unikey)}`,
  };
}

async function pollLogin() {
  if (!state.loginKey) {
    return { code: 800, state: "expired", message: "登录会话已失效，请重新获取二维码。" };
  }

  const { response, data } = await neteaseRequest(
    `/api/login/qrcode/client/login?key=${encodeURIComponent(state.loginKey)}&type=1`,
    { useCookies: false },
  );
  const code = data && Number(data.code);

  if (code === 803) {
    mergeSetCookies(getSetCookies(response));
    const profile = await fetchProfile();
    if (!profile) {
      state.loginStatus = "error";
      throw new Error("扫码成功，但没有读取到账号信息，请重新登录。");
    }
    state.profile = profile;
    state.loginStatus = "success";
    state.loginKey = "";
    return { code, state: "success", profile };
  }

  if (code === 802) {
    state.loginStatus = "confirming";
    return { code, state: "confirming", message: "已扫码，请在手机上确认登录。" };
  }

  if (code === 800) {
    state.loginStatus = "expired";
    state.loginKey = "";
    return { code, state: "expired", message: "二维码已过期，请重新获取。" };
  }

  state.loginStatus = "waiting";
  return { code: code || 801, state: "waiting", message: "等待扫码。" };
}

async function fetchPlaylists() {
  requireLogin();
  const userId = state.profile.userId;
  const collected = [];
  let offset = 0;
  const limit = 1000;

  while (offset < 10000) {
    const { data } = await neteaseRequest(
      `/api/user/playlist/?uid=${encodeURIComponent(userId)}&offset=${offset}&limit=${limit}`,
    );
    if (!data || data.code !== 200 || !Array.isArray(data.playlist)) {
      throw new Error("拉取歌单失败，登录状态可能已失效。");
    }
    collected.push(...data.playlist);
    if (!data.more || data.playlist.length === 0) {
      break;
    }
    offset += data.playlist.length;
  }

  const rank = (playlist) => {
    if (playlist.specialType === 5) {
      return 0;
    }
    if (Number(playlist.userId) === Number(userId)) {
      return 1;
    }
    return 2;
  };

  const accountPlaylists = collected
    .map((playlist) => ({
      id: Number(playlist.id),
      name: String(playlist.name || "未命名歌单"),
      trackCount: Number(playlist.trackCount || 0),
      coverUrl: String(playlist.coverImgUrl || ""),
      specialType: Number(playlist.specialType || 0),
      userId: Number(playlist.userId || 0),
      owned: Number(playlist.userId) === Number(userId),
      creator: String((playlist.creator && playlist.creator.nickname) || ""),
      updateTime: Number(playlist.updateTime || playlist.trackUpdateTime || 0),
    }))
    .sort((left, right) => {
      const rankDiff = rank(left) - rank(right);
      if (rankDiff !== 0) {
        return rankDiff;
      }
      if (right.updateTime !== left.updateTime) {
        return right.updateTime - left.updateTime;
      }
      return left.name.localeCompare(right.name, "zh-CN");
    });
  state.playlists = [
    ...state.publicPlaylists.values(),
    ...accountPlaylists.filter(
      (playlist) =>
        ![...state.publicPlaylists.keys()].some(
          (publicId) => Number(publicId) === playlist.id,
        ),
    ),
  ];

  return state.playlists;
}

async function getPlaylistOrder(playlistId, forceRefresh = false) {
  const key = String(playlistId);
  if (!forceRefresh && state.playlistCache.has(key)) {
    return state.playlistCache.get(key);
  }

  const { data } = await neteaseRequest(
    `/api/v6/playlist/detail?id=${encodeURIComponent(playlistId)}&n=1&s=0`,
  );
  if (!data || data.code !== 200 || !data.playlist) {
    throw new Error("读取歌单失败，歌单可能已删除或没有访问权限。");
  }

  const rawTrackIds =
    Array.isArray(data.playlist.trackIds) && data.playlist.trackIds.length > 0
      ? data.playlist.trackIds
      : data.playlist.tracks;
  const order = sortTrackIdsByAdded(rawTrackIds);
  const result = {
    id: Number(data.playlist.id),
    name: String(data.playlist.name || "未命名歌单"),
    trackCount: order.length,
    coverUrl: String(data.playlist.coverImgUrl || ""),
    orderedTracks: order,
  };
  state.playlistCache.set(key, result);
  return result;
}

async function addPublicPlaylist(input) {
  const playlistId = parsePlaylistId(input);
  const playlist = await getPlaylistOrder(playlistId, true);
  const item = {
    id: playlist.id,
    name: playlist.name,
    trackCount: playlist.trackCount,
    coverUrl: playlist.coverUrl,
    specialType: 0,
    userId: 0,
    owned: false,
    creator: "公开歌单",
    updateTime: 0,
    public: true,
  };
  state.publicPlaylists.set(String(playlist.id), item);
  state.playlists = [
    item,
    ...state.playlists.filter((existing) => existing.id !== item.id),
  ];
  return item;
}

async function fetchSongDetails(ids) {
  const songs = new Map();
  const uniqueIds = [...new Set(ids.map(Number).filter((id) => id > 0))];
  const chunkSize = 50;

  for (let index = 0; index < uniqueIds.length; index += chunkSize) {
    const chunk = uniqueIds.slice(index, index + chunkSize);
    const encodedIds = encodeURIComponent(JSON.stringify(chunk));
    const { data } = await neteaseRequest(
      `/api/song/detail/?ids=${encodedIds}`,
    );
    if (!data || data.code !== 200 || !Array.isArray(data.songs)) {
      throw new Error("读取歌曲信息失败，请稍后重试。");
    }
    for (const song of data.songs) {
      songs.set(Number(song.id), song);
    }
  }
  return songs;
}

function addJobLog(job, level, message) {
  job.logs.push({
    time: Date.now(),
    level,
    message: String(message),
  });
  if (job.logs.length > 200) {
    job.logs.splice(0, job.logs.length - 200);
  }
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    total: job.total,
    completed: job.completed,
    success: job.success,
    skipped: job.skipped,
    failed: job.failed,
    current: job.current,
    downloadDir: job.downloadDir,
    cancelRequested: job.cancelRequested,
    logs: job.logs,
  };
}

async function resolveOutputDirectory(requested, playlistName) {
  const fallback = path.join(
    __dirname,
    "downloads",
    `${sanitizeFileName(playlistName, "网易云歌单")}_封面`,
  );
  const value = String(requested || "").trim();
  if (!value) {
    return path.resolve(fallback);
  }
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(__dirname, value);
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function extensionForImageType(contentType, buffer) {
  if (
    buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return ".png";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return ".jpg";
  }
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return ".webp";
  }
  if (buffer.subarray(0, 3).toString("ascii") === "GIF") {
    return ".gif";
  }
  if (buffer.subarray(0, 2).toString("ascii") === "BM") {
    return ".bmp";
  }
  if (buffer.subarray(4, 12).toString("ascii").includes("ftypavif")) {
    return ".avif";
  }

  const normalized = String(contentType).split(";")[0].trim().toLowerCase();
  const extensions = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/bmp": ".bmp",
    "image/avif": ".avif",
  };
  return extensions[normalized] || ".jpg";
}

async function downloadImage(url, targetPath, overwrite) {
  const targetExtension = path.extname(targetPath);
  const targetStem = targetExtension
    ? targetPath.slice(0, -targetExtension.length)
    : targetPath;
  const possiblePaths = [".jpg", ".png", ".webp", ".gif", ".bmp", ".avif"].map(
    (extension) => `${targetStem}${extension}`,
  );

  if (!overwrite) {
    for (const filePath of possiblePaths) {
      if (await fileExists(filePath)) {
        return { outcome: "skipped", filePath };
      }
    }
  }

  const response = await fetch(url, {
    headers: BASE_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok) {
    throw new Error(`图片请求失败（HTTP ${response.status}）`);
  }
  const contentType = String(response.headers.get("content-type") || "");
  if (!contentType.startsWith("image/")) {
    throw new Error(`返回内容不是图片（${contentType || "未知类型"}）`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 100) {
    throw new Error("图片数据异常。");
  }

  const finalPath = `${targetStem}${extensionForImageType(contentType, buffer)}`;
  const tempPath = `${finalPath}.part-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tempPath, buffer);
  if (overwrite) {
    await Promise.all(
      possiblePaths
        .filter((filePath) => filePath !== finalPath)
        .map((filePath) => fsp.rm(filePath, { force: true })),
    );
  }
  await fsp.rm(finalPath, { force: true });
  await fsp.rename(tempPath, finalPath);
  return { outcome: "success", filePath: finalPath };
}

async function runDownloadJob(job) {
  job.status = "running";
  addJobLog(job, "info", "正在读取歌单并计算最新加入顺序...");

  const playlist = await getPlaylistOrder(job.playlistId);
  const selectedIndices = parseSelection(job.selection, playlist.orderedTracks.length);
  job.total = selectedIndices.length;
  const selectedTracks = selectedIndices.map((index) => {
    const item = playlist.orderedTracks[index - 1];
    return { index, id: item.id, addedAt: item.addedAt };
  });

  addJobLog(
    job,
    "info",
    `已选择 ${selectedTracks.length} 首歌曲，准备读取歌曲信息。`,
  );

  const songs = await fetchSongDetails(selectedTracks.map((track) => track.id));
  let cursor = 0;
  const workerCount = Math.min(4, selectedTracks.length);

  const worker = async () => {
    while (!job.cancelRequested) {
      const position = cursor;
      cursor += 1;
      if (position >= selectedTracks.length) {
        return;
      }

      const item = selectedTracks[position];
      const song = songs.get(Number(item.id));
      job.current = `${item.index}. ${song ? song.name : `歌曲 ${item.id}`}`;

      if (!song) {
        job.failed += 1;
        job.completed += 1;
        addJobLog(job, "error", `${item.index}: 没有读取到歌曲信息。`);
        continue;
      }

      const picUrl =
        (song.al && song.al.picUrl) ||
        (song.album && song.album.picUrl) ||
        "";
      if (!picUrl) {
        job.failed += 1;
        job.completed += 1;
        addJobLog(job, "error", `${item.index}: ${song.name} 没有可用的封面。`);
        continue;
      }

      const fileName = formatFileName(item.index, {
        name: song.name,
        artists: song.ar || song.artists || [],
      });
      const targetPath = path.join(job.downloadDir, fileName);

      try {
        const result = await downloadImage(
          buildCoverUrl(picUrl, job.imageSize),
          targetPath,
          job.overwrite,
        );
        const savedName = path.basename(result.filePath);
        if (result.outcome === "skipped") {
          job.skipped += 1;
          addJobLog(job, "muted", `${savedName} 已存在，已跳过。`);
        } else {
          job.success += 1;
          addJobLog(job, "success", `${savedName} 下载完成。`);
        }
      } catch (error) {
        job.failed += 1;
        addJobLog(job, "error", `${fileName} 下载失败：${error.message}`);
      } finally {
        job.completed += 1;
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (job.cancelRequested) {
    job.status = "cancelled";
    job.current = "";
    addJobLog(job, "warning", "任务已取消。");
    return;
  }

  job.status = "completed";
  job.current = "";
  addJobLog(
    job,
    job.failed > 0 ? "warning" : "success",
    `处理完成：成功 ${job.success}，跳过 ${job.skipped}，失败 ${job.failed}。`,
  );
}

async function createDownloadJob(input) {
  const playlistId = Number(input.playlistId);
  if (!Number.isFinite(playlistId) || playlistId <= 0) {
    throw new Error("请选择要下载的歌单。");
  }

  const playlist = await getPlaylistOrder(playlistId);
  const downloadDir = await resolveOutputDirectory(input.outputDir, playlist.name);
  await fsp.mkdir(downloadDir, { recursive: true });

  const job = {
    id: crypto.randomUUID(),
    playlistId,
    selection: {
      mode: input.mode === "range" ? "range" : "indices",
      start: input.start,
      end: input.end,
      selection: input.selection,
    },
    imageSize: ["640", "1080", "original"].includes(String(input.imageSize))
      ? String(input.imageSize)
      : "1080",
    overwrite: Boolean(input.overwrite),
    downloadDir,
    status: "queued",
    total: 0,
    completed: 0,
    success: 0,
    skipped: 0,
    failed: 0,
    current: "",
    cancelRequested: false,
    logs: [],
  };
  state.jobs.set(job.id, job);
  runDownloadJob(job).catch((error) => {
    job.status = "failed";
    job.current = "";
    addJobLog(job, "error", `任务失败：${error.message}`);
  });
  return job;
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      const error = new Error("请求内容过大。");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("请求格式不正确。");
    error.statusCode = 400;
    throw error;
  }
}

const MIME_TYPES = {
  ".css": "text/css",
  ".html": "text/html",
  ".ico": "image/x-icon",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

async function serveStatic(requestPath, response) {
  const relativePath = requestPath === "/" ? "index.html" : requestPath.slice(1);
  const filePath = path.resolve(PUBLIC_DIR, relativePath);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && filePath !== PUBLIC_DIR) {
    textResponse(response, 403, "Forbidden");
    return;
  }

  try {
    const data = await fsp.readFile(filePath);
    const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    response.writeHead(200, {
      "Content-Type": `${contentType}; charset=utf-8`,
      "Content-Length": data.length,
      "Cache-Control": "no-cache",
    });
    response.end(data);
  } catch (error) {
    if (error.code === "ENOENT") {
      textResponse(response, 404, "Not Found");
      return;
    }
    throw error;
  }
}

async function handleApi(request, response, pathname) {
  if (request.method === "GET" && pathname === "/api/health") {
    jsonResponse(response, 200, { ok: true, node: process.versions.node });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/session") {
    jsonResponse(response, 200, {
      loggedIn: Boolean(state.profile),
      profile: state.profile,
      loginStatus: state.loginStatus,
      playlistCount: state.playlists.length,
      readOnly: true,
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/login/start") {
    jsonResponse(response, 200, await startLogin());
    return true;
  }

  if (request.method === "GET" && pathname === "/api/login/poll") {
    jsonResponse(response, 200, await pollLogin());
    return true;
  }

  if (request.method === "POST" && pathname === "/api/logout") {
    state.cookies = [];
    state.profile = null;
    state.playlists = [...state.publicPlaylists.values()];
    state.playlistCache.clear();
    state.loginKey = "";
    state.loginStatus = "idle";
    jsonResponse(response, 200, { ok: true });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/playlists") {
    const playlists =
      state.playlists.length > 0 ? state.playlists : await fetchPlaylists();
    jsonResponse(response, 200, { playlists });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/public-playlist") {
    const body = await readJsonBody(request);
    const playlist = await addPublicPlaylist(body.input);
    jsonResponse(response, 200, { playlist });
    return true;
  }

  const previewMatch = /^\/api\/playlists\/(\d+)\/preview$/.exec(pathname);
  if (request.method === "GET" && previewMatch) {
    const playlist = await getPlaylistOrder(Number(previewMatch[1]), true);
    const previewCount = Math.min(
      Math.max(Number(new URL(request.url, "http://localhost").searchParams.get("count")) || 20, 1),
      100,
    );
    const previewTracks = playlist.orderedTracks.slice(0, previewCount);
    const songs = await fetchSongDetails(previewTracks.map((track) => track.id));
    jsonResponse(response, 200, {
      id: playlist.id,
      name: playlist.name,
      trackCount: playlist.trackCount,
      coverUrl: playlist.coverUrl,
      preview: previewTracks.map((track) => {
        const song = songs.get(Number(track.id));
        return {
          index: track.index,
          id: track.id,
          addedAt: track.addedAt,
          name: song ? song.name : `歌曲 ${track.id}`,
          artists: song
            ? (song.ar || song.artists || []).map((artist) => artist.name).filter(Boolean)
            : [],
          album: song && song.al ? song.al.name : "",
        };
      }),
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/download") {
    const body = await readJsonBody(request);
    const job = await createDownloadJob(body);
    jsonResponse(response, 202, publicJob(job));
    return true;
  }

  const jobMatch = /^\/api\/download\/([a-f0-9-]+)$/.exec(pathname);
  if (request.method === "GET" && jobMatch) {
    const job = state.jobs.get(jobMatch[1]);
    if (!job) {
      jsonResponse(response, 404, { error: "下载任务不存在。" });
      return true;
    }
    jsonResponse(response, 200, publicJob(job));
    return true;
  }

  const cancelMatch = /^\/api\/download\/([a-f0-9-]+)\/cancel$/.exec(pathname);
  if (request.method === "POST" && cancelMatch) {
    const job = state.jobs.get(cancelMatch[1]);
    if (!job) {
      jsonResponse(response, 404, { error: "下载任务不存在。" });
      return true;
    }
    job.cancelRequested = true;
    jsonResponse(response, 200, publicJob(job));
    return true;
  }

  if (request.method === "POST" && pathname === "/api/reveal") {
    const body = await readJsonBody(request);
    const target = path.resolve(String(body.path || ""));
    if (!target) {
      throw new Error("没有可打开的文件夹。");
    }
    if (process.platform === "win32") {
      spawn("explorer.exe", [target], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [target], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [target], { detached: true, stdio: "ignore" }).unref();
    }
    jsonResponse(response, 200, { ok: true });
    return true;
  }

  return false;
}

async function requestHandler(request, response) {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(request, response, url.pathname);
      if (!handled) {
        jsonResponse(response, 404, { error: "接口不存在。" });
      }
      return;
    }
    await serveStatic(url.pathname, response);
  } catch (error) {
    const statusCode = error.statusCode || 500;
    const message = error.message || "服务器内部错误。";
    if (!response.headersSent) {
      jsonResponse(response, statusCode, { error: message });
    } else {
      response.end();
    }
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function startServer() {
  const portArgumentIndex = process.argv.indexOf("--port");
  const requestedPort =
    portArgumentIndex >= 0 ? Number(process.argv[portArgumentIndex + 1]) : 38471;
  const firstPort = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 38471;
  const server = http.createServer(requestHandler);
  let activePort = firstPort;

  for (let offset = 0; offset < 30; offset += 1) {
    activePort = firstPort + offset;
    try {
      await listen(server, activePort);
      break;
    } catch (error) {
      if (error.code !== "EADDRINUSE" || offset === 29) {
        throw error;
      }
    }
  }

  const url = `http://127.0.0.1:${activePort}`;
  console.log(`网易云封面下载器已启动：${url}`);
  console.log("按 Ctrl+C 可以关闭程序。");

  if (process.argv.includes("--open")) {
    if (process.platform === "win32") {
      spawn("cmd.exe", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  }
}

startServer().catch((error) => {
  console.error(`启动失败：${error.message}`);
  process.exitCode = 1;
});
