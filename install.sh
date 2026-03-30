#!/usr/bin/env bash
# install.sh — Rust binary installer (rev 2026-03-30; invalidates stale raw.githubusercontent caches)
# Install prebuilt zmail (Rust) from GitHub Releases — no Node/npm.
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/cirne/zmail/main/install.sh | bash
#   bash install.sh [--nightly] [--version v1.2.3]
# Env: INSTALL_PREFIX (default: ~/.local/bin), ZMAIL_VERSION, ZMAIL_CHANNEL=nightly, ZMAIL_GITHUB_REPO
# Note: no `set -u` here — when this script is read from stdin (`curl | bash`),
# BASH_SOURCE is unset in some bash versions; keep the wrapper minimal.
set -eo pipefail
if ! command -v python3 >/dev/null 2>&1; then
  echo "zmail install: python3 is required (macOS and most Linux systems include it)." >&2
  exit 1
fi
exec python3 - "$@" <<'INSTALLER'
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import ssl
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

REPO = os.environ.get("ZMAIL_GITHUB_REPO", "cirne/zmail")
API = f"https://api.github.com/repos/{REPO}"
UA = "zmail-install.sh (https://github.com/cirne/zmail)"


def http_json(url: str) -> Any:
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": UA,
        },
    )
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=120, context=ctx) as r:
        return json.load(r)


def http_bytes(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=300, context=ctx) as r:
        return r.read()


def detect_triple() -> Tuple[str, str]:
    import platform

    sys_n = platform.system().lower()
    mach = platform.machine().lower()
    if sys_n == "linux" and mach in ("x86_64", "amd64"):
        return "x86_64-unknown-linux-gnu", "tar.gz"
    if sys_n == "darwin" and mach == "arm64":
        return "aarch64-apple-darwin", "tar.gz"
    if sys_n == "darwin" and mach in ("x86_64", "i386"):
        print(
            "No prebuilt zmail for Intel Mac (CI ships Apple Silicon only).\n"
            "  Build from source: cargo build --release && ./install-rust-binary.sh\n"
            "  See https://github.com/cirne/zmail/blob/main/AGENTS.md",
            file=sys.stderr,
        )
        sys.exit(1)
    if sys_n == "windows":
        print(
            "This shell installer is for macOS/Linux.\n"
            "  On Windows, download the .zip for your arch from:\n"
            f"  https://github.com/{REPO}/releases",
            file=sys.stderr,
        )
        sys.exit(1)
    print(f"Unsupported platform: {sys_n}-{mach}", file=sys.stderr)
    sys.exit(1)


def pick_stable_asset(
    assets: List[Dict[str, Any]], tag_name: str, triple: str, ext: str
) -> Optional[Dict[str, Any]]:
    want = f"zmail-{tag_name}-{triple}.{ext}"
    for a in assets:
        if a.get("name") == want:
            return a
    return None


def pick_nightly_asset(
    assets: List[Dict[str, Any]], triple: str, ext: str
) -> Optional[Dict[str, Any]]:
    pat = re.compile(rf"^zmail-nightly-.+-{re.escape(triple)}\.{re.escape(ext)}$")
    cands = [a for a in assets if pat.match(a.get("name", ""))]
    if not cands:
        return None
    cands.sort(key=lambda x: x["name"], reverse=True)
    return cands[0]


def find_sums_asset(assets: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    for a in assets:
        if a.get("name") == "SHA256SUMS":
            return a
    return None


def verify_sums(sums_text: str, archive_name: str, archive_path: Path) -> None:
    want_line = None
    for line in sums_text.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        name = parts[-1].lstrip("*")
        if name == archive_name or name.endswith("/" + archive_name):
            want_line = parts[0]
            break
    if not want_line:
        print(
            f"Warning: {archive_name} not listed in SHA256SUMS; skipping checksum verify.",
            file=sys.stderr,
        )
        return
    h = hashlib.sha256()
    with open(archive_path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    got = h.hexdigest()
    if got != want_line:
        print(f"SHA256 mismatch: expected {want_line}, got {got}", file=sys.stderr)
        sys.exit(1)


def extract_zmail(archive: Path, triple: str, ext: str, dest_bin: Path) -> None:
    if ext == "tar.gz":
        with tarfile.open(archive, "r:gz") as tf:
            names = tf.getnames()
            member_name = None
            for n in names:
                if n.rstrip("/") == "zmail" or n.endswith("/zmail"):
                    member_name = n
                    break
            if not member_name:
                print("Archive missing zmail binary", file=sys.stderr)
                sys.exit(1)
            m = tf.getmember(member_name)
            with tempfile.TemporaryDirectory() as tmp:
                tmp = Path(tmp)
                # tarfile.extract filter= added in 3.12
                try:
                    tf.extract(m, path=tmp, filter="data")
                except TypeError:
                    tf.extract(m, path=tmp)
                src = tmp / member_name.split("/")[-1]
                if not src.is_file():
                    src = tmp / "zmail"
                shutil.copyfile(src, dest_bin)
    else:
        print(f"Unexpected archive type: {ext}", file=sys.stderr)
        sys.exit(1)

    dest_bin.chmod(0o755)


def main() -> None:
    ap = argparse.ArgumentParser(description="Install zmail from GitHub Releases")
    ap.add_argument(
        "--nightly",
        action="store_true",
        help="Install from the nightly prerelease (latest matching asset)",
    )
    ap.add_argument(
        "--version",
        dest="version",
        metavar="TAG",
        help="Exact release tag (e.g. v0.2.0). Overrides ZMAIL_VERSION.",
    )
    args = ap.parse_args()

    nightly = args.nightly or os.environ.get("ZMAIL_CHANNEL", "").lower() == "nightly"
    version = args.version or os.environ.get("ZMAIL_VERSION")
    fallback_nightly = False

    triple, ext = detect_triple()

    try:
        if nightly:
            rel = http_json(f"{API}/releases/tags/nightly")
        elif version:
            rel = http_json(f"{API}/releases/tags/{version}")
        else:
            try:
                rel = http_json(f"{API}/releases/latest")
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    # No semver release yet — use nightly so install.sh is testable without a tag.
                    print(
                        "No stable GitHub Release yet; installing from the nightly prerelease.",
                        file=sys.stderr,
                    )
                    rel = http_json(f"{API}/releases/tags/nightly")
                    fallback_nightly = True
                else:
                    raise
    except urllib.error.HTTPError as e:
        print(f"GitHub API error: {e.code} {e.reason}", file=sys.stderr)
        sys.exit(1)

    assets = rel.get("assets") or []
    tag_name = rel.get("tag_name") or ""

    if nightly or fallback_nightly:
        asset = pick_nightly_asset(assets, triple, ext)
    else:
        asset = pick_stable_asset(assets, tag_name, triple, ext)

    if not asset:
        print(
            f"No download asset for {triple} on release {tag_name or 'nightly'}.\n"
            f"  See https://github.com/{REPO}/releases",
            file=sys.stderr,
        )
        sys.exit(1)

    sums_a = find_sums_asset(assets)
    url = asset["browser_download_url"]
    name = asset["name"]

    prefix = os.environ.get("INSTALL_PREFIX", str(Path.home() / ".local/bin"))
    dest_dir = Path(prefix).expanduser()
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_bin = dest_dir / "zmail"

    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        arc_path = td_path / name
        arc_path.write_bytes(http_bytes(url))
        if sums_a:
            sums_path = td_path / "SHA256SUMS"
            sums_path.write_bytes(http_bytes(sums_a["browser_download_url"]))
            verify_sums(sums_path.read_text(), name, arc_path)
        extract_zmail(arc_path, triple, ext, dest_bin)

    print(f"Installed zmail -> {dest_bin}")
    if str(dest_dir) not in os.environ.get("PATH", ""):
        print(
            f"Add to PATH if needed:\n  export PATH=\"{dest_dir}:$PATH\"",
            file=sys.stderr,
        )
    print("Run: zmail setup   (or zmail wizard)")


if __name__ == "__main__":
    main()
INSTALLER
