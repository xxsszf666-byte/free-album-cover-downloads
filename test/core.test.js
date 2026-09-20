"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assertReadOnlyNeteaseEndpoint,
  buildCoverUrl,
  formatFileName,
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
  assert.throws(
    () =>
      assertReadOnlyNeteaseEndpoint(
        "/api/playlist/manipulate/tracks?pid=3778678",
      ),
    /只读/,
  );
});

test("sorts tracks by added time descending with stable fallback order", () => {
  const sorted = sortTrackIdsByAdded([
    { id: 11, at: 100 },
    { id: 22, at: 300 },
    { id: 33 },
    { id: 44, at: 300 },
    { id: 55, at: 200 },
  ]);

  assert.deepEqual(
    sorted.map((item) => item.id),
    [22, 44, 55, 11, 33],
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
