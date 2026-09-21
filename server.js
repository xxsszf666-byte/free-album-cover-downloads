"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  assertReadOnlyNeteaseEndpoint,
  buildAppleCoverUrl,
  buildCoverUrl,
  detectPlaylistProvider,
  formatFileName,
  normalizeOutputPathInput,
  parseQqPlaylistId,
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
const QQ_HEADERS = {
  "User-Agent": BASE_HEADERS["User-Agent"],
  Referer: "https://y.qq.com/",
};
const APPLE_HEADERS = {
  "User-Agent": BASE_HEADERS["User-Agent"],
  Referer: "https://music.apple.com/",
};

const state = {
  playlists: [],
  publicPlaylists: new Map(),
  playlistCache: new Map(),
  songDetailCache: new Map(),
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

async function neteaseRequest(
  pathname,
  { timeout = 30000 } = {},
) {
  assertReadOnlyNeteaseEndpoint(pathname);
  const headers = { ...BASE_HEADERS };

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

async function getNeteasePlaylistOrder(playlistId) {
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
    provider: "netease",
    name: String(data.playlist.name || "未命名歌单"),
    trackCount: order.length,
    coverUrl: String(data.playlist.coverImgUrl || ""),
    orderedTracks: order,
  };
  return result;
}

async function resolveQqPlaylistId(url) {
  const response = await fetch(url, {
    headers: QQ_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
  });
  const candidates = [response.url, url];
  for (const candidate of candidates) {
    const id = parseQqPlaylistId(candidate);
    if (id) {
      return id;
    }
  }

  const text = await response.text();
  const patterns = [
    /["'](?:disstid|playlistId|id)["']\s*[:=]\s*["']?(\d{5,15})/i,
    /\/playlist\/(\d{5,15})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      return Number(match[1]);
    }
  }
  throw new Error("没有从 QQ 音乐分享链接中识别到歌单 ID。");
}

async function getQqPlaylistOrder(playlistId) {
  const apiUrl =
    "https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg" +
    `?type=1&json=1&utf8=1&onlysong=0&disstid=${encodeURIComponent(playlistId)}&format=json&g_tk=5381`;
  const response = await fetch(apiUrl, {
    headers: QQ_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    throw new Error(`读取 QQ 音乐歌单失败（HTTP ${response.status}）。`);
  }
  const data = await response.json();
  const playlist = data && Array.isArray(data.cdlist) ? data.cdlist[0] : null;
  if (!playlist || !Array.isArray(playlist.songlist)) {
    throw new Error("读取 QQ 音乐歌单失败，歌单可能已删除或没有公开访问权限。");
  }

  const orderedTracks = playlist.songlist.map((song, index) => {
    const albumMid = String(song.albummid || song.album?.mid || "");
    const coverUrl = albumMid
      ? `https://y.qq.com/music/photo_new/T002R800x800M000${albumMid}.jpg?max_age=2592000`
      : "";
    return {
      id: Number(song.songid || song.id || 0),
      addedAt: null,
      index: index + 1,
      metadata: {
        name: String(song.songname || song.name || `歌曲 ${index + 1}`),
        artists: Array.isArray(song.singer)
          ? song.singer.map((artist) => String(artist.name || "")).filter(Boolean)
          : [],
        album: String(song.albumname || song.album?.name || ""),
        coverUrl,
      },
    };
  });
  return {
    id: Number(playlist.disstid || playlistId),
    provider: "qq",
    name: String(playlist.dissname || "QQ 音乐歌单"),
    trackCount: orderedTracks.length,
    coverUrl:
      String(playlist.picurl || "") ||
      orderedTracks.find((track) => track.metadata.coverUrl)?.metadata.coverUrl ||
      "",
    orderedTracks,
  };
}

function extractApplePlaylist(html) {
  const matches = [
    ...String(html).matchAll(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ),
  ];
  for (const match of matches) {
    try {
      const data = JSON.parse(match[1]);
      if (
        data &&
        String(data["@type"] || "").includes("MusicPlaylist") &&
        Array.isArray(data.track)
      ) {
        return data;
      }
    } catch {
      // Ignore unrelated or malformed JSON-LD blocks.
    }
  }
  return null;
}

async function fetchAppleTrackLookup(ids, country) {
  const lookup = new Map();
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  const chunkSize = 50;
  for (let index = 0; index < uniqueIds.length; index += chunkSize) {
    const chunk = uniqueIds.slice(index, index + chunkSize);
    const url =
      "https://itunes.apple.com/lookup?entity=song" +
      `&country=${encodeURIComponent(country)}&id=${chunk.join(",")}`;
    try {
      const response = await fetch(url, {
        headers: APPLE_HEADERS,
        redirect: "follow",
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        continue;
      }
      const data = await response.json();
      for (const item of data.results || []) {
        if (item.trackId) {
          lookup.set(String(item.trackId), item);
        }
      }
    } catch {
      // Apple Music page data remains usable if lookup enrichment fails.
    }
    if (index + chunkSize < uniqueIds.length) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  return lookup;
}

async function getApplePlaylistOrder(source) {
  if (!source.url) {
    throw new Error("Apple Music 歌单地址缺失，请重新导入分享链接。");
  }
  const response = await fetch(source.url, {
    headers: APPLE_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    throw new Error(`读取 Apple Music 歌单失败（HTTP ${response.status}）。`);
  }
  const html = await response.text();
  const playlist = extractApplePlaylist(html);
  if (!playlist) {
    throw new Error("没有读取到 Apple Music 公开歌单数据，歌单可能需要登录或未公开。");
  }

  const storefrontMatch = /^\/([a-z]{2})(?:\/|$)/i.exec(new URL(response.url).pathname);
  const country = storefrontMatch ? storefrontMatch[1].toLowerCase() : "us";
  const rawTracks = playlist.track.map((track, index) => {
    const songIdMatch = /\/song\/[^/]+\/(\d+)/.exec(String(track.url || ""));
    return {
      index,
      songId: songIdMatch ? songIdMatch[1] : "",
      name: String(track.name || `歌曲 ${index + 1}`),
      coverUrl: String(
        (track.audio && track.audio.thumbnailUrl) || track.thumbnailUrl || "",
      ),
    };
  });
  const lookup = await fetchAppleTrackLookup(
    rawTracks.map((track) => track.songId),
    country,
  );
  const orderedTracks = rawTracks.map((track, index) => {
    const details = lookup.get(track.songId) || null;
    return {
      id: track.songId || `${source.id}:${index + 1}`,
      addedAt: null,
      index: index + 1,
      metadata: {
        name: String(details?.trackName || track.name),
        artists: details?.artistName ? [String(details.artistName)] : [],
        album: String(details?.collectionName || ""),
        coverUrl: String(details?.artworkUrl100 || track.coverUrl || ""),
      },
    };
  });
  return {
    id: source.id,
    provider: "apple",
    name: String(playlist.name || "Apple Music 歌单"),
    trackCount: Number(playlist.numTracks || orderedTracks.length),
    coverUrl: buildAppleCoverUrl(
      orderedTracks.find((track) => track.metadata.coverUrl)?.metadata.coverUrl,
      "original",
    ),
    orderedTracks,
  };
}

function reorderPlaylist(playlist, order) {
  if (order !== "desc") {
    return { ...playlist, sortOrder: "asc" };
  }
  return {
    ...playlist,
    sortOrder: "desc",
    orderedTracks: [...playlist.orderedTracks]
      .reverse()
      .map((track, index) => ({ ...track, index: index + 1 })),
  };
}

async function getPlaylistOrder(source, forceRefresh = false, order = "asc") {
  const provider = ["qq", "apple"].includes(source.provider)
    ? source.provider
    : "netease";
  const playlistId =
    provider === "apple" ? String(source.id || "") : Number(source.id);
  if (
    (provider === "apple" && !playlistId) ||
    (provider !== "apple" && (!Number.isFinite(playlistId) || playlistId <= 0))
  ) {
    throw new Error("歌单 ID 无效。");
  }

  const key = `${provider}:${playlistId}`;
  if (!forceRefresh && state.playlistCache.has(key)) {
    return reorderPlaylist(state.playlistCache.get(key), order);
  }
  const result =
    provider === "qq"
      ? await getQqPlaylistOrder(playlistId)
      : provider === "apple"
        ? await getApplePlaylistOrder(source)
        : await getNeteasePlaylistOrder(playlistId);
  state.playlistCache.set(key, result);
  return reorderPlaylist(result, order);
}

async function addPublicPlaylist(input) {
  const source = detectPlaylistProvider(input);
  if (source.provider === "qq" && !source.id) {
    source.id = await resolveQqPlaylistId(source.url);
  }
  const playlist = await getPlaylistOrder(source, true);
  const item = {
    id: playlist.id,
    provider: playlist.provider,
    name: playlist.name,
    trackCount: playlist.trackCount,
    coverUrl: playlist.coverUrl,
    specialType: 0,
    userId: 0,
    owned: false,
    creator:
      playlist.provider === "qq"
        ? "QQ 音乐公开歌单"
        : playlist.provider === "apple"
          ? "Apple Music 公开歌单"
          : "网易云公开歌单",
    sourceUrl: source.url || "",
    updateTime: 0,
    public: true,
  };
  state.publicPlaylists.set(`${item.provider}:${item.id}`, item);
  state.playlists = [
    item,
    ...state.playlists.filter(
      (existing) =>
        existing.id !== item.id || existing.provider !== item.provider,
    ),
  ];
  return item;
}

async function fetchSongDetails(ids) {
  const songs = new Map();
  const uniqueIds = [...new Set(ids.map(Number).filter((id) => id > 0))];
  const missingIds = [];
  for (const id of uniqueIds) {
    if (state.songDetailCache.has(id)) {
      songs.set(id, state.songDetailCache.get(id));
    } else {
      missingIds.push(id);
    }
  }
  if (missingIds.length === 0) {
    return songs;
  }

  const chunkSize = 200;
  const chunks = [];

  for (let index = 0; index < missingIds.length; index += chunkSize) {
    chunks.push(missingIds.slice(index, index + chunkSize));
  }

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];
    let lastMessage = "";
    let chunkSongs = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const encodedIds = encodeURIComponent(
        JSON.stringify(chunk.map((id) => ({ id }))),
      );
      const { data } = await neteaseRequest(
        `/api/v3/song/detail?c=${encodedIds}`,
      );
      if (data && data.code === 200 && Array.isArray(data.songs)) {
        const privileges = new Map(
          (data.privileges || []).map((item) => [Number(item.id), item]),
        );
        chunkSongs = data.songs.map((song) => ({
          ...song,
          privilege: privileges.get(Number(song.id)) || null,
        }));
        break;
      }
      lastMessage =
        (data && (data.message || data.msg)) ||
        (data && data.code ? `网易云返回代码 ${data.code}` : "响应格式异常");
      const waitMs = Math.min(1000 * 2 ** attempt, 6000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    if (!chunkSongs) {
      throw new Error(`读取歌曲信息失败：${lastMessage || "请稍后重试"}`);
    }
    for (const song of chunkSongs) {
      const songId = Number(song.id);
      songs.set(songId, song);
      state.songDetailCache.set(songId, song);
    }
    if (chunkIndex < chunks.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  for (const id of missingIds) {
    if (!songs.has(id) && state.songDetailCache.has(id)) {
      songs.set(id, state.songDetailCache.get(id));
    }
  }
  return songs;
}

function getSongCoverUrl(song) {
  return (
    (song && song.al && song.al.picUrl) ||
    (song && song.album && song.album.picUrl) ||
    ""
  );
}

function analyzeSongAvailability(song) {
  const status = Number(song && song.status != null ? song.status : 0);
  const fee = Number(song && song.fee != null ? song.fee : 0);
  const noCopyrightRcmd =
    song && song.noCopyrightRcmd && typeof song.noCopyrightRcmd === "object"
      ? song.noCopyrightRcmd
      : null;
  const privilege = song && song.privilege ? song.privilege : null;
  const privilegeStatus = Number(privilege && privilege.st);

  if (status !== 0 || noCopyrightRcmd || privilegeStatus < 0) {
    return {
      availability: "unavailable",
      availabilityLabel: "无版权/下架",
      availabilityReason:
        (noCopyrightRcmd && noCopyrightRcmd.typeDesc) ||
        "歌曲当前无法播放",
    };
  }
  if (fee > 0) {
    return {
      availability: "restricted",
      availabilityLabel: "VIP/付费",
      availabilityReason: "播放可能受账号权益限制",
    };
  }
  return {
    availability: "available",
    availabilityLabel: "正常",
    availabilityReason: "",
  };
}

function analyzeMetadataPlaylist(playlist) {
  const providerName = playlist.provider === "apple" ? "Apple Music" : "QQ 音乐";
  const tracks = playlist.orderedTracks.map((track) => ({
    index: track.index,
    id: track.id,
    addedAt: null,
    name: track.metadata.name,
    artists: track.metadata.artists,
    album: track.metadata.album,
    availability: track.metadata.coverUrl ? "available" : "unavailable",
    availabilityLabel: track.metadata.coverUrl ? "封面可下载" : "无封面",
    availabilityReason: `${providerName}公开歌单元数据，封面下载与音频权益无关`,
    canDownloadCover: Boolean(track.metadata.coverUrl),
  }));
  return {
    id: playlist.id,
    provider: playlist.provider,
    name: playlist.name,
    trackCount: playlist.trackCount,
    coverUrl: playlist.coverUrl,
    summary: {
      total: tracks.length,
      available: tracks.filter((track) => track.canDownloadCover).length,
      restricted: 0,
      unavailable: tracks.filter((track) => !track.canDownloadCover).length,
      missingCover: tracks.filter((track) => !track.canDownloadCover).length,
    },
    oldestAddedAt: null,
    newestAddedAt: null,
    tracks,
  };
}

async function analyzePlaylist(playlist) {
  if (playlist.provider === "qq" || playlist.provider === "apple") {
    return analyzeMetadataPlaylist(playlist);
  }
  const songs = await fetchSongDetails(
    playlist.orderedTracks.map((track) => track.id),
  );
  const tracks = playlist.orderedTracks.map((track) => {
    const song = songs.get(Number(track.id));
    const availability = analyzeSongAvailability(song);
    const coverUrl = getSongCoverUrl(song);
    return {
      index: track.index,
      id: track.id,
      addedAt: track.addedAt,
      name: song ? song.name : `歌曲 ${track.id}`,
      artists: song
        ? (song.ar || song.artists || []).map((artist) => artist.name).filter(Boolean)
        : [],
      album: song ? (song.al || song.album || {}).name || "" : "",
      ...availability,
      canDownloadCover: Boolean(coverUrl),
    };
  });

  const summary = {
    total: tracks.length,
    available: tracks.filter((track) => track.availability === "available").length,
    restricted: tracks.filter((track) => track.availability === "restricted").length,
    unavailable: tracks.filter((track) => track.availability === "unavailable").length,
    missingCover: tracks.filter((track) => !track.canDownloadCover).length,
  };
  const dated = tracks.filter((track) => track.addedAt);
  const oldestAddedAt =
    dated.length > 0
      ? Math.min(...dated.map((track) => Number(track.addedAt)))
      : null;
  const newestAddedAt =
    dated.length > 0
      ? Math.max(...dated.map((track) => Number(track.addedAt)))
      : null;

  return {
    id: playlist.id,
    name: playlist.name,
    trackCount: playlist.trackCount,
    coverUrl: playlist.coverUrl,
    summary,
    oldestAddedAt,
    newestAddedAt,
    tracks,
  };
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

function getDefaultOutputDirectory(playlistName) {
  return path.resolve(
    path.join(
      __dirname,
      "downloads",
      `${sanitizeFileName(playlistName, "音乐歌单")}_封面`,
    ),
  );
}

async function resolveOutputDirectory(requested, playlistName) {
  const fallback = getDefaultOutputDirectory(playlistName);
  const value = normalizeOutputPathInput(requested);
  if (!value) {
    return fallback;
  }
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(__dirname, value);
}

async function ensureWritableDirectory(directory) {
  await fsp.mkdir(directory, { recursive: true });
  const probePath = path.join(
    directory,
    `.music-cover-write-test-${process.pid}-${Date.now()}`,
  );
  try {
    await fsp.writeFile(probePath, "ok", { flag: "wx" });
  } catch {
    throw new Error(
      `保存目录没有写入权限：${directory}。请更换目录，或手动双击 start.cmd 以普通用户权限运行程序。`,
    );
  } finally {
    await fsp.rm(probePath, { force: true }).catch(() => {});
  }
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

async function downloadImage(url, targetPath, overwrite, headers = BASE_HEADERS) {
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
    headers,
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
  addJobLog(job, "info", "正在读取歌单并整理封面顺序...");

  const playlist = await getPlaylistOrder({
    provider: job.playlistProvider,
    id: job.playlistId,
    url: job.playlistUrl,
  }, false, job.sortOrder);
  const selectedIndices = parseSelection(job.selection, playlist.orderedTracks.length);
  job.total = selectedIndices.length;
  const selectedTracks = selectedIndices.map((index) => {
    const item = playlist.orderedTracks[index - 1];
    return { ...item, index };
  });

  addJobLog(
    job,
    "info",
    `已选择 ${selectedTracks.length} 首歌曲，准备读取歌曲信息。`,
  );

  const songs =
    playlist.provider === "netease"
      ? await fetchSongDetails(selectedTracks.map((track) => track.id))
      : new Map();
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
      const song =
        playlist.provider === "netease" ? songs.get(Number(item.id)) : null;
      const metadata =
        playlist.provider !== "netease"
          ? item.metadata
          : {
              name: song ? song.name : "",
              artists: song ? (song.ar || song.artists || []).map((artist) => artist.name) : [],
              album: song ? (song.al || song.album || {}).name || "" : "",
              coverUrl: song ? getSongCoverUrl(song) : "",
            };
      job.current = `${item.index}. ${metadata.name || `歌曲 ${item.id}`}`;

      if (!metadata.name) {
        job.failed += 1;
        job.completed += 1;
        addJobLog(job, "error", `${item.index}: 没有读取到歌曲信息。`);
        continue;
      }

      const picUrl = metadata.coverUrl;
      if (!picUrl) {
        job.failed += 1;
        job.completed += 1;
        addJobLog(job, "error", `${item.index}: ${metadata.name} 没有可用的封面。`);
        continue;
      }

      const fileName = formatFileName(item.index, {
        name: metadata.name,
        artists: metadata.artists.map((name) => ({ name })),
      });
      const targetPath = path.join(job.downloadDir, fileName);

      try {
        const result = await downloadImage(
          playlist.provider === "qq"
            ? picUrl
            : playlist.provider === "apple"
              ? buildAppleCoverUrl(picUrl, job.imageSize)
            : buildCoverUrl(picUrl, job.imageSize),
          targetPath,
          job.overwrite,
          playlist.provider === "qq"
            ? QQ_HEADERS
            : playlist.provider === "apple"
              ? APPLE_HEADERS
              : BASE_HEADERS,
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
  const rawPlaylistId = input.playlistId;
  const playlistProvider = ["qq", "apple"].includes(input.playlistProvider)
    ? input.playlistProvider
    : "netease";
  const playlistId =
    playlistProvider === "apple" ? String(rawPlaylistId || "") : Number(rawPlaylistId);
  const existingPlaylist = state.playlists.find(
    (playlist) =>
      playlist.provider === playlistProvider &&
      String(playlist.id) === String(input.playlistId),
  );
  const playlistUrl = String(input.playlistUrl || existingPlaylist?.sourceUrl || "");
  if (
    (playlistProvider === "apple" && !playlistId) ||
    (playlistProvider !== "apple" &&
      (!Number.isFinite(playlistId) || playlistId <= 0))
  ) {
    throw new Error("请选择要下载的歌单。");
  }

  const playlist = await getPlaylistOrder({
    provider: playlistProvider,
    id: playlistId,
    url: playlistUrl,
  }, false, input.sortOrder === "desc" ? "desc" : "asc");
  let downloadDir = await resolveOutputDirectory(input.outputDir, playlist.name);
  let fallbackUsed = false;
  try {
    await ensureWritableDirectory(downloadDir);
  } catch (error) {
    const fallback = getDefaultOutputDirectory(playlist.name);
    if (fallback === downloadDir) {
      throw error;
    }
    downloadDir = fallback;
    fallbackUsed = true;
    await ensureWritableDirectory(downloadDir);
  }

  const job = {
    id: crypto.randomUUID(),
    playlistId,
    playlistProvider,
    playlistUrl,
    sortOrder: input.sortOrder === "desc" ? "desc" : "asc",
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
    fallbackUsed,
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
  if (fallbackUsed) {
    addJobLog(
      job,
      "warning",
      `指定保存目录当前不可写（可能因为程序运行在受限环境，或目录受 Windows 受控文件夹保护），已自动改用 ${downloadDir}。如需保存到原目录，请关闭当前服务并手动双击 start.cmd 启动。`,
    );
  }
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
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
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
      "Cache-Control": "no-store, max-age=0",
      Pragma: "no-cache",
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
      playlistCount: state.playlists.length,
      readOnly: true,
    });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/playlists") {
    jsonResponse(response, 200, { playlists: state.playlists });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/public-playlist") {
    const body = await readJsonBody(request);
    const playlist = await addPublicPlaylist(body.input);
    jsonResponse(response, 200, { playlist });
    return true;
  }

  const previewMatch = /^\/api\/playlists\/(netease|qq|apple)\/([^/]+)\/preview$/.exec(pathname);
  if (request.method === "GET" && previewMatch) {
    const requestUrl = new URL(request.url, "http://localhost");
    const sortOrder = requestUrl.searchParams.get("order") === "desc" ? "desc" : "asc";
    const provider = previewMatch[1];
    const playlistId =
      provider === "apple"
        ? decodeURIComponent(previewMatch[2])
        : Number(previewMatch[2]);
    const existingPlaylist = state.playlists.find(
      (playlist) =>
        playlist.provider === provider &&
        String(playlist.id) === String(playlistId),
    );
    const playlist = await getPlaylistOrder(
      {
        provider,
        id: playlistId,
        url: existingPlaylist?.sourceUrl || "",
      },
      true,
      sortOrder,
    );
    const previewCount = Math.min(
      Math.max(Number(requestUrl.searchParams.get("count")) || 20, 1),
      100,
    );
    const analysis = await analyzePlaylist(playlist);
    jsonResponse(response, 200, {
      id: playlist.id,
      provider: playlist.provider,
      sortOrder,
      name: playlist.name,
      trackCount: playlist.trackCount,
      coverUrl: playlist.coverUrl,
      summary: analysis.summary,
      oldestAddedAt: analysis.oldestAddedAt,
      newestAddedAt: analysis.newestAddedAt,
      preview: analysis.tracks.slice(0, previewCount),
      unavailableTracks: analysis.tracks.filter(
        (track) => track.availability === "unavailable",
      ),
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

function findWindowsBrowser() {
  const candidates = [
    path.join(
      process.env["ProgramFiles(x86)"] || "",
      "Microsoft",
      "Edge",
      "Application",
      "msedge.exe",
    ),
    path.join(
      process.env.ProgramFiles || "",
      "Microsoft",
      "Edge",
      "Application",
      "msedge.exe",
    ),
    path.join(
      process.env.ProgramFiles || "",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    ),
    path.join(
      process.env["ProgramFiles(x86)"] || "",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    ),
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

function openBrowser(url) {
  if (process.platform === "win32") {
    const browser = findWindowsBrowser();
    if (browser) {
      const browserProfile = path.join(
        process.env.TEMP || __dirname,
        "netease-cover-downloader-browser",
      );
      spawn(
        browser,
        [
          "--no-first-run",
          "--no-default-browser-check",
          "--no-proxy-server",
          "--proxy-bypass-list=127.0.0.1;localhost",
          `--user-data-dir=${browserProfile}`,
          url,
        ],
        {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        },
      ).unref();
      return;
    }
    spawn("cmd.exe", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    return;
  }

  if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

function runPowerShell(script, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-STA", "-Command", script],
      {
        env: { ...process.env, ...extraEnv },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || "PowerShell 命令执行失败。"));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function showLegalPrompt() {
  if (
    process.platform !== "win32" ||
    process.env.NCD_SKIP_LEGAL_PROMPT === "1"
  ) {
    return true;
  }

  const legalText = [
    "本软件仅供用户本人在自己的设备上，进行个人学习、备份和低频研究使用。",
    "",
    "禁止公开部署、在线提供服务、批量分发、销售、商业使用，或以本软件实质性替代网易云音乐、QQ 音乐、Apple Music 等平台服务。",
    "",
    "本软件与网易云音乐、QQ 音乐、Apple Music 等平台官方无任何关联，不提供音频、VIP 内容或付费内容下载。",
    "",
    "继续使用即表示你理解并自行承担相关合规风险。",
    "",
    "是否确认仅用于个人本地合规用途并继续？",
  ].join("\n");
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
    "$result = [System.Windows.Forms.MessageBox]::Show($env:NCD_LEGAL_TEXT, '使用前须知 - 音乐封面下载器', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Warning, [System.Windows.Forms.MessageBoxDefaultButton]::Button2)",
    "if ($result -eq [System.Windows.Forms.DialogResult]::Yes) { [Console]::Out.Write('YES') } else { [Console]::Out.Write('NO') }",
  ].join("; ");
  const result = await runPowerShell(script, { NCD_LEGAL_TEXT: legalText });
  return result === "YES";
}

async function startServer() {
  const acceptedLegalNotice = await showLegalPrompt();
  if (!acceptedLegalNotice) {
    console.log("已取消启动：用户未确认个人本地合规使用边界。");
    return;
  }

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
  console.log(`音乐封面下载器已启动：${url}`);
  console.log("按 Ctrl+C 可以关闭程序。");

  if (process.argv.includes("--open")) {
    openBrowser(url);
  }
}

startServer().catch((error) => {
  console.error(`启动失败：${error.message}`);
  process.exitCode = 1;
});
