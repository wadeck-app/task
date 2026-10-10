#!/usr/bin/env bash
# Copies Go launcher binaries and esbuild bundles into platform packages and dist packages.
# Usage: bash ci/scripts/copy-binaries.sh
set -euo pipefail

TASK_LAUNCHER_DIST="launcher-go/dist"

cp "$TASK_LAUNCHER_DIST/task_windows_release.exe"  packages/task-cli-win32-x64/task.exe
cp "$TASK_LAUNCHER_DIST/task_darwin_arm64_release"  packages/task-cli-darwin-arm64/task
cp "$TASK_LAUNCHER_DIST/task_darwin_amd64_release"  packages/task-cli-darwin-x64/task
chmod +x packages/task-cli-darwin-arm64/task packages/task-cli-darwin-x64/task
cp dist-bundle/task.cjs           packages/task-cli-dist/task.cjs
cp dist-bundle/task-updater.cjs   packages/task-cli-dist/task-updater.cjs
echo "task artifacts copied"
