# NetEase Cloud Music Cover Downloader

A dependency-free local web tool that downloads album covers from NetEase Cloud Music playlists.

## Features

- QR-code login with the official NetEase Cloud Music login page.
- Public playlist mode without login.
- Sorts tracks by their `at` added timestamp; the newest track is index `1`.
- Supports ranges such as `1-100` or selections such as `1,3,5-8`.
- Supports 640px, 1080px, and original cover sizes.
- Read-only NetEase API allowlist and `GET`-only requests.

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

The tool only calls the official login status, account profile, playlist, playlist detail, and song detail endpoints. It does not add, delete, edit, favorite, follow, or otherwise modify account data.

See `SECURITY.md` and `docs/architecture.md` for details.

## License

MIT
