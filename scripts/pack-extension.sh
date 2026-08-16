#!/bin/bash
# Packs extension/ into dist/opencode-chrome-<version>.zip for CWS upload.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p "require('./package.json').version")
mkdir -p dist
rm -f "dist/opencode-chrome-$version.zip"
zip -qr "dist/opencode-chrome-$version.zip" extension/ -x '*.DS_Store'
echo "dist/opencode-chrome-$version.zip"
