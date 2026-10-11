#!/usr/bin/env bash
# Copies Go launcher binaries and esbuild bundles into platform packages and dist packages.
# Usage: bash packages/task-cli/ci/scripts/copy-binaries.sh (run from repo root)
set -euo pipefail

TASK_LAUNCHER_DIST="packages/task-cli/launcher-go/dist"
TASK_DIST_BUNDLE="packages/task-cli/dist-bundle"

cp "$TASK_LAUNCHER_DIST/task_windows_release.exe"  packages/task-cli-win32-x64/task.exe
cp "$TASK_LAUNCHER_DIST/task_darwin_arm64_release"  packages/task-cli-darwin-arm64/task
cp "$TASK_LAUNCHER_DIST/task_darwin_amd64_release"  packages/task-cli-darwin-x64/task
chmod +x packages/task-cli-darwin-arm64/task packages/task-cli-darwin-x64/task
cp "$TASK_DIST_BUNDLE/task.cjs"           packages/task-cli-dist/task.cjs
cp "$TASK_DIST_BUNDLE/task-updater.cjs"   packages/task-cli-dist/task-updater.cjs
echo "task artifacts copied"
