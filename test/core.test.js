"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assertReadOnlyNeteaseEndpoint,
  buildCoverUrl,
  detectPlaylistProvider,
  formatFileName,
  normalizeOutputPathInput,
  parsePlaylistId,
  parseSelection,
  sanitizeFileName,
  sortTrackIdsByAdded,
} = require("../core");

test("allows only the read-only NetEase endpoints", () => {
  assert.doesNotThrow(() =>
    assertReadOnlyNeteaseEndpoint("/api/v6/playlist/detail?id=3778678"),
  );
  assert.doesNotThrow(() =>
    assertReadOnlyNeteaseEndpoint("/api/song/detail/?ids=%5B1%5D"),
  );
  assert.doesNotThrow(() =>
    assertReadOnlyNeteaseEndpoint("/api/v3/song/detail?c=%5B%7B%22id%22%3A1%7D%5D"),
  );
  assert.throws(
    () =>
      assertReadOnlyNeteaseEndpoint(
        "/api/playlist/manipulate/tracks?pid=3778678",
      ),
    /只读/,
  );
});

test("sorts tracks by added time ascending with unknown dates last", () => {
  const sorted = sortTrackIdsByAdded([
    { id: 11, at: 100 },
    { id: 22, at: 300 },
    { id: 33 },
    { id: 44, at: 300 },
    { id: 55, at: 200 },
  ]);

  assert.deepEqual(
    sorted.map((item) => item.id),
    [11, 55, 22, 44, 33],
  );
  assert.deepEqual(
    sorted.map((item) => item.index),
    [1, 2, 3, 4, 5],
  );
});

test("parses range selection", () => {
  assert.deepEqual(
    parseSelection({ mode: "range", start: 2, end: 5 }, 8),
    [2, 3, 4, 5],
  );
});

test("parses individual indexes and removes duplicates", () => {
  assert.deepEqual(
    parseSelection({ mode: "indices", selection: "1, 3,5-7,6，8" }, 10),
    [1, 3, 5, 6, 7, 8],
  );
});

test("rejects indexes beyond playlist size", () => {
  assert.throws(
    () => parseSelection({ mode: "indices", selection: "1,20" }, 10),
    /超出/,
  );
});

test("sanitizes Windows file names", () => {
  assert.equal(sanitizeFileName('AC/DC: Back? <Live>'), "AC_DC_ Back_ _Live_");
  assert.equal(sanitizeFileName("CON"), "_CON");
  assert.equal(sanitizeFileName(""), "未知");
});

test("normalizes quoted output paths and environment variables", () => {
  assert.equal(
    normalizeOutputPathInput('"C:\\Users\\ASUS\\Desktop\\新建文件夹"'),
    "C:\\Users\\ASUS\\Desktop\\新建文件夹",
  );
  process.env.MUSIC_COVER_TEST_PATH = "D:\\Covers";
  assert.equal(
    normalizeOutputPathInput("%MUSIC_COVER_TEST_PATH%\\Album"),
    "D:\\Covers\\Album",
  );
  delete process.env.MUSIC_COVER_TEST_PATH;
});

test("builds cover URL with requested size", () => {
  assert.equal(
    buildCoverUrl("http://p1.music.126.net/example.jpg", "1080"),
    "https://p1.music.126.net/example.jpg?param=1080y1080",
  );
  assert.equal(
    buildCoverUrl("https://p1.music.126.net/example.jpg?param=640y640", "1080"),
    "https://p1.music.126.net/example.jpg?param=640y640",
  );
});

test("formats cover file name with playlist index", () => {
  assert.equal(
    formatFileName(7, {
      name: "夜曲",
      artists: [{ name: "周杰伦" }],
    }),
    "0007 - 夜曲 - 周杰伦.jpg",
  );
});

test("parses playlist ID from raw ID and common NetEase URLs", () => {
  assert.equal(parsePlaylistId("3778678"), 3778678);
  assert.equal(
    parsePlaylistId("https://music.163.com/#/playlist?id=3778678"),
    3778678,
  );
  assert.equal(
    parsePlaylistId("https://music.163.com/playlist/3778678/123/"),
    3778678,
  );
});

test("detects NetEase and QQ Music playlist share links", () => {
  assert.deepEqual(
    detectPlaylistProvider("https://music.163.com/#/playlist?id=3778678"),
    { provider: "netease", id: 3778678, url: "https://music.163.com/#/playlist?id=3778678" },
  );
  assert.deepEqual(
    detectPlaylistProvider("https://y.qq.com/n/ryqq/playlist/7283765288"),
    { provider: "qq", id: 7283765288, url: "https://y.qq.com/n/ryqq/playlist/7283765288" },
  );
  assert.deepEqual(detectPlaylistProvider("3778678"), {
    provider: "netease",
    id: 3778678,
    url: "",
  });
});
