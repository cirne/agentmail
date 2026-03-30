#!/usr/bin/env bash
set -euo pipefail
# Thin wrapper so `curl .../main/install.sh | bash` stays stable.
# Implementation lives in node/ (npm global install of @cirne/zmail).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$ROOT/node/install.sh" "$@"
