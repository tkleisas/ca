#!/usr/bin/env bash
# ─── YAWN VST3 Build Script ──────────────────────────
# Clones dependencies and builds the plugin.

set -euo pipefail
cd "$(dirname "$0")"

echo "=== YAWN VST3 Build ==="

# Clone VST3 SDK if missing
if [ ! -d deps/vst3sdk ]; then
    echo ">>> Cloning VST3 SDK..."
    git clone --depth 1 --recursive \
        https://github.com/steinbergmedia/vst3sdk.git deps/vst3sdk
fi

# Configure
echo ">>> Configuring..."
cmake -B build -DCMAKE_BUILD_TYPE=Release

# Build
echo ">>> Building..."
cmake --build build -j$(nproc)

echo ""
echo "=== Build complete ==="
echo "Plugin: build/VST3/yawn.vst3/"
echo ""
echo "Install: cp -r build/VST3/yawn.vst3 ~/.vst3/"
