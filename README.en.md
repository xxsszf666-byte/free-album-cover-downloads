# Music Cover Downloader

A dependency-free local web tool that downloads album covers from public NetEase Cloud Music and QQ Music playlist share links.

## Features

- Public playlist share links only; no account login and no cookies.
- NetEase Cloud Music tracks are sorted by their `at` timestamp, oldest first.
- QQ Music tracks follow the public playlist response order.
- Supports ranges such as `1-100` or selections such as `1,3,5-8`.
- Supports 640px, 1080px, and original cover sizes.
- NetEase read-only API allowlist and public QQ Music playlist endpoints.

Supported platforms:

| Platform | Playlist share link | Cover download | Audio download |
| --- | --- | --- | --- |
| NetEase Cloud Music | Yes | Yes | No |
| QQ Music | Yes | Yes | No |

Kugou, Kuwo, Migu, and other services are not implemented yet.

## Quick Start

Node.js 18 or newer is required.

```bash
npm start
```

On Windows, `start.cmd` and `start.ps1` are also available. On macOS or Linux, run:

```bash
sh start.sh
```

The local UI is served at `http://127.0.0.1:38471`.

## Read-Only Guarantee

The tool only calls public playlist and metadata endpoints. It does not log in, read cookies, add, delete, edit, favorite, follow, or otherwise modify account data.

See `SECURITY.md` and `docs/architecture.md` for details.

## License

MIT
