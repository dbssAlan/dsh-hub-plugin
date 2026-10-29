#!/usr/bin/env sh
# Unix wrapper for dsh-hub.mjs (macOS / Linux).
set -e
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$DIR/dsh-hub.mjs" "$@"
