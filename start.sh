#!/usr/bin/env sh
set -eu

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' "Node.js 18 or newer is required."
  printf '%s\n' "Download it from https://nodejs.org/"
  exit 1
fi

cd "$(dirname "$0")"
node server.js --open
