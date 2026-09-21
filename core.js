"use strict";

const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

const NETEASE_READ_ONLY_ENDPOINTS = new Set([
  "/api/v6/playlist/detail",
  "/api/song/detail/",
  "/api/v3/song/detail",
]);

function assertReadOnlyNeteaseEndpoint(pathname) {
  const pathOnly = String(pathname).split("?")[0];
  if (!NETEASE_READ_ONLY_ENDPOINTS.has(pathOnly)) {
    throw new Error(`安全限制：拒绝访问非只读网易云端点 ${pathOnly}`);
  }
}

function sortTrackIdsByAdded(trackIds) {
  const normalized = (Array.isArray(trackIds) ? trackIds : [])
    .map((item, originalIndex) => {
      const normalized =
        typeof item === "object" && item !== null ? item : { id: item };
      const addedAt = Number(normalized.at);
      return {
        id: Number(normalized.id),
        addedAt: Number.isFinite(addedAt) && addedAt > 0 ? addedAt : 0,
        originalIndex,
      };
    })
    .filter((item) => Number.isFinite(item.id) && item.id > 0);

  const dated = normalized
    .filter((item) => item.addedAt > 0)
    .sort((left, right) => {
      if (left.addedAt !== right.addedAt) {
        return left.addedAt - right.addedAt;
      }
      return left.originalIndex - right.originalIndex;
    });
  const undated = normalized.filter((item) => item.addedAt === 0);

  return [...dated, ...undated].map((item, sortIndex) => ({
      id: item.id,
      addedAt: item.addedAt || null,
      index: sortIndex + 1,
    }));
}

function parseSelection(input, total) {
  const count = Number(total);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("歌单里没有可下载的歌曲。");
  }

  const mode = input && input.mode === "range" ? "range" : "indices";
  let values = [];

  if (mode === "range") {
    const start = Number(input.start);
    const end = Number(input.end);
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new Error("请填写有效的起止序号。");
    }
    if (start < 1 || end < 1) {
      throw new Error("序号必须从 1 开始。");
    }
    if (start > end) {
      throw new Error("起始序号不能大于结束序号。");
    }
    if (start > count || end > count) {
      throw new Error(`序号不能超过当前歌单的歌曲总数（${count}）。`);
    }
    for (let value = start; value <= end; value += 1) {
      values.push(value);
    }
  } else {
    const text = String(input && input.selection ? input.selection : "")
      .replace(/[，、；;\s]+/g, ",")
      .trim();
    if (!text) {
      throw new Error("请填写要下载的序号，例如 1,3,8-12。");
    }

    const tokens = text.split(",").filter(Boolean);
    for (const token of tokens) {
      const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(token);
      if (rangeMatch) {
        const start = Number(rangeMatch[1]);
        const end = Number(rangeMatch[2]);
        if (start < 1 || end < 1 || start > end) {
          throw new Error(`无效的序号范围：${token}`);
        }
        for (let value = start; value <= end; value += 1) {
          values.push(value);
        }
        continue;
      }

      if (!/^\d+$/.test(token)) {
        throw new Error(`无法识别序号：${token}`);
      }
      values.push(Number(token));
    }

    const outOfRange = values.filter((value) => value > count);
    if (outOfRange.length > 0) {
      throw new Error(
        `序号 ${outOfRange.join(", ")} 超出当前歌单的歌曲总数（${count}）。`,
      );
    }
  }

  const unique = [...new Set(values)].sort((left, right) => left - right);
  if (unique.length === 0) {
    throw new Error("没有选中任何歌曲。");
  }
  return unique;
}

function sanitizeFileName(value, fallback = "未知") {
  let name = String(value == null ? "" : value)
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();

  if (!name) {
    name = fallback;
  }
  if (WINDOWS_RESERVED_NAMES.has(name.toUpperCase())) {
    name = `_${name}`;
  }
  return name.slice(0, 100);
}

function normalizeOutputPathInput(value) {
  let text = String(value == null ? "" : value).trim();
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'")))
  ) {
    text = text.slice(1, -1).trim();
  }
  text = text.replace(/%([^%]+)%/g, (match, name) => process.env[name] || match);
  if (text === "~") {
    text = process.env.USERPROFILE || process.env.HOME || text;
  } else if (text.startsWith("~/") || text.startsWith("~\\")) {
    const home = process.env.USERPROFILE || process.env.HOME;
    if (home) {
      text = path.join(home, text.slice(2));
    }
  }
  return text;
}

function buildCoverUrl(picUrl, size) {
  const url = String(picUrl || "").trim();
  if (!url) {
    return "";
  }

  let normalized = url.replace(/^http:\/\//i, "https://");
  const normalizedSize = String(size || "1080");
  if (normalizedSize === "original") {
    return normalized;
  }

  const dimension = /^\d{3,4}$/.test(normalizedSize) ? normalizedSize : "1080";
  const separator = normalized.includes("?") ? "&" : "?";
  if (/[?&]param=/.test(normalized)) {
    return normalized;
  }
  return `${normalized}${separator}param=${dimension}y${dimension}`;
}

function buildAppleCoverUrl(picUrl, size) {
  const url = String(picUrl || "").trim();
  if (!url) {
    return "";
  }
  const dimension =
    size === "original"
      ? "3000"
      : /^\d{3,4}$/.test(String(size))
        ? String(size)
        : "3000";
  return url.replace(
    /\/\d+x\d+bb\.(jpg|jpeg|png|webp)$/i,
    `/${dimension}x${dimension}bb.$1`,
  );
}

function formatFileName(index, song) {
  const number = String(index).padStart(4, "0");
  const title = sanitizeFileName(song && song.name, "未知歌曲");
  const artists = Array.isArray(song && song.artists)
    ? song.artists.map((artist) => artist && artist.name).filter(Boolean)
    : [];
  const artist = sanitizeFileName(artists.join("、") || "未知歌手");
  return `${number} - ${title} - ${artist}.jpg`;
}

function parsePlaylistId(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text) {
    throw new Error("请输入公开歌单链接或歌单 ID。");
  }
  if (/^\d{5,15}$/.test(text)) {
    return Number(text);
  }

  const idMatch = /[?&#]id=(\d{5,15})(?:&|$)/.exec(text);
  if (idMatch) {
    return Number(idMatch[1]);
  }

  const playlistPathMatch = /\/playlist\/(\d{5,15})(?:[/?#]|$)/.exec(text);
  if (playlistPathMatch) {
    return Number(playlistPathMatch[1]);
  }

  throw new Error("没有识别到歌单 ID，请粘贴网易云歌单链接或纯数字 ID。");
}

function parseQqPlaylistId(value) {
  const text = String(value == null ? "" : value).trim();
  const pathMatch = /\/playlist\/(\d{5,15})(?:[/?#]|$)/.exec(text);
  if (pathMatch) {
    return Number(pathMatch[1]);
  }
  const queryMatch = /[?&#](?:id|disstid)=(\d{5,15})(?:&|$)/.exec(text);
  if (queryMatch) {
    return Number(queryMatch[1]);
  }
  return null;
}

function parseApplePlaylistId(value) {
  const text = String(value == null ? "" : value).trim();
  const match = /\/playlist\/[^/?#]+\/(pl\.[A-Za-z0-9.-]+)(?:[/?#]|$)/.exec(text);
  return match ? match[1] : null;
}

function detectPlaylistProvider(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text) {
    throw new Error("请粘贴网易云音乐、QQ 音乐或 Apple Music 的公开歌单分享链接。");
  }
  if (/^\d{5,15}$/.test(text)) {
    return { provider: "netease", id: Number(text), url: "" };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(text);
  } catch {
    throw new Error("没有识别到歌单链接，请粘贴完整的分享地址。");
  }
  const hostname = parsedUrl.hostname.toLowerCase();

  if (hostname === "qq.com" || hostname.endsWith(".qq.com")) {
    return {
      provider: "qq",
      id: parseQqPlaylistId(text),
      url: text,
    };
  }
  if (hostname === "music.apple.com" || hostname.endsWith(".music.apple.com")) {
    const id = parseApplePlaylistId(text);
    if (!id) {
      throw new Error("没有识别到 Apple Music 歌单 ID。");
    }
    return {
      provider: "apple",
      id,
      url: text,
    };
  }
  if (hostname === "music.163.com" || hostname.endsWith(".music.163.com")) {
    return {
      provider: "netease",
      id: parsePlaylistId(text),
      url: text,
    };
  }

  throw new Error("目前只支持网易云音乐、QQ 音乐和 Apple Music 的公开歌单分享链接。");
}

module.exports = {
  assertReadOnlyNeteaseEndpoint,
  buildAppleCoverUrl,
  buildCoverUrl,
  detectPlaylistProvider,
  formatFileName,
  normalizeOutputPathInput,
  parseApplePlaylistId,
  parsePlaylistId,
  parseQqPlaylistId,
  parseSelection,
  sanitizeFileName,
  sortTrackIdsByAdded,
};
