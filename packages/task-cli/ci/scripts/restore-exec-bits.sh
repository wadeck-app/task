#!/usr/bin/env bash
# actions/upload-artifact + download-artifact drop file modes: the Go launchers of the platform packages come back
# 0644, and npm publishes (and installs) them as such, so the launcher cannot be executed on macOS (EACCES).
# Restores the exec bit right before `npm pack` / `npm publish`. Fails when an expected file is missing.
#
# Usage: bash restore-exec-bits.sh <packages dir> <cli> <platforms>
#   <platforms>  the same comma list as PLATFORMS of generate-platform-packages.sh (win32 binaries are skipped).
set -euo pipefail

DIR="${1:?usage: restore-exec-bits.sh <packages dir> <cli> <platforms>}"
CLI="${2:?usage: restore-exec-bits.sh <packages dir> <cli> <platforms>}"
PLATFORMS="${3:?usage: restore-exec-bits.sh <packages dir> <cli> <platforms>}"

IFS=',' read -ra PLATFORM_LIST <<< "$PLATFORMS"
files=("$DIR/${CLI}-cli-dist/bin/${CLI}.js")
for p in "${PLATFORM_LIST[@]}"; do
  [[ "$p" == win32-* ]] || files+=("$DIR/${CLI}-cli-${p}/${CLI}")
done

for f in "${files[@]}"; do
  [ -f "$f" ] || { echo "restore-exec-bits: $f is missing (artifact incomplete)" >&2; exit 1; }
  chmod +x "$f"
  echo "chmod +x $f"
done
