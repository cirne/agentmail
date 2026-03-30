#!/usr/bin/env bash
# Install zmail Rust binary (dev / CI). Build with: cargo build --release
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
BIN="${ROOT}/target/release/zmail"
if [[ ! -f "$BIN" ]]; then
  echo "Run: (cd \"$ROOT\" && cargo build --release)" >&2
  exit 1
fi
DEST="${INSTALL_PREFIX:-/usr/local/bin}/zmail"
install -m 0755 "$BIN" "$DEST"
echo "Installed $DEST"
