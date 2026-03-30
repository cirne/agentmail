#!/usr/bin/env bash
set -eo pipefail
# Thin wrapper: use the Rust binary installer at the repository root.
# BASH_SOURCE is unset when this file is piped (`curl | bash`); only use it when set.
_script="${BASH_SOURCE[0]:-}"
if [[ -n "$_script" ]]; then
  ROOT="$(cd "$(dirname "$_script")/.." && pwd)"
else
  ROOT="$(pwd)"
fi
exec bash "$ROOT/install.sh" "$@"
