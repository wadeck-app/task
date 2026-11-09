#!/usr/bin/env bash
# actions/upload-artifact + download-artifact drop file modes: the Go launchers of the platform packages come back
# 0644, and npm publishes (and installs) them as such, so the launcher cannot be executed on macOS (EACCES).
# Restores the exec bit right before `npm pack` / `npm publish`.
# Usage (repo root): bash packages/task-cli/ci/scripts/restore-exec-bits.sh <packages dir>
set -euo pipefail
DIR="${1:?usage: restore-exec-bits.sh <packages dir>}"
for f in "$DIR"/task-cli-darwin-arm64/task "$DIR"/task-cli-dist/bin/task.js; do
  [ -f "$f" ] || { echo "restore-exec-bits: $f is missing (artifact incomplete)" >&2; exit 1; }
  chmod +x "$f"
  echo "chmod +x $f"
done
