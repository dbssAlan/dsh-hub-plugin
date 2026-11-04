#!/usr/bin/env sh
# Unix wrapper for the standalone hub CLI (macOS / Linux).
set -e
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$DIR/lib/hub-cli.mjs" "$@"
