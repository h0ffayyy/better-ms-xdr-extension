#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_ROOT/src"
DIST="$REPO_ROOT/dist"

SHARED_FILES=(content.js content.css popup.html popup.css popup.js theme-bridge.js)

build_target() {
  local browser="$1"
  local out="$DIST/$browser"
  echo "Building $browser -> $out"
  rm -rf "$out"
  mkdir -p "$out/icons"
  for f in "${SHARED_FILES[@]}"; do
    cp "$SRC/shared/$f" "$out/$f"
  done
  cp "$SRC/$browser/manifest.json" "$out/manifest.json"
  cp "$SRC/$browser/icons/"* "$out/icons/"
  echo "  done."
}

build_target firefox
build_target chrome
echo "Build complete: $DIST/firefox/  $DIST/chrome/"
