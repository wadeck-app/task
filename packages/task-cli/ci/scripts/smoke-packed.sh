#!/usr/bin/env bash
# Smoke test of the PACKED task CLI on the machine it runs on (CI: macOS runners). Nothing is published and the real
# global npm is never touched: the packages are `npm pack`ed, installed into a throwaway prefix, and run from there.
# Fails loudly (full output) when a command prints nothing, exits non-zero, or does not show the version.
#
# Usage: bash packages/task-cli/ci/scripts/smoke-packed.sh <packages dir> <expected version>
#   <packages dir> holds task-cli-dist and task-cli-<os>-<arch> (the build job's artifact).
set -euo pipefail

PACKAGES_DIR="${1:?usage: smoke-packed.sh <packages dir> <expected version>}"
VERSION="${2:?usage: smoke-packed.sh <packages dir> <expected version>}"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  PLATFORM="darwin-arm64" ;;
  *) echo "smoke-packed: unsupported host $(uname -s)-$(uname -m): run it on Apple silicon macOS (darwin-arm64); Intel Macs are not supported" >&2; exit 1 ;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
TGZ="$WORK/tgz"
PREFIX="$WORK/prefix"
HOME_DIR="$WORK/home"
mkdir -p "$TGZ" "$PREFIX" "$HOME_DIR/.config"

for pkg in task-cli-dist "task-cli-$PLATFORM"; do
  [ -d "$PACKAGES_DIR/$pkg" ] || { echo "smoke-packed: $PACKAGES_DIR/$pkg is missing (artifact incomplete)" >&2; exit 1; }
  (cd "$PACKAGES_DIR/$pkg" && npm pack --silent --pack-destination "$TGZ" >/dev/null)
done

echo "--- tarball entries (mode, size, name)"
for t in "$TGZ"/*.tgz; do echo "$(basename "$t")"; tar -tvzf "$t" | grep -E 'package/(task|bin/task\.js|task\.cjs)$' || true; done

# Throwaway npm and home: no real config, no real registry (the background updater of the CLI must not find one either).
export HOME="$HOME_DIR" XDG_CONFIG_HOME="$HOME_DIR/.config" USERPROFILE="$HOME_DIR"
export NPM_CONFIG_PREFIX="$PREFIX" NPM_CONFIG_CACHE="$WORK/npm-cache" NPM_CONFIG_USERCONFIG="$WORK/npmrc"
export NPM_CONFIG_REGISTRY="http://127.0.0.1:9/"
printf 'registry=http://127.0.0.1:9/\n@wadeck-app:registry=http://127.0.0.1:9/\nfetch-retries=0\nfetch-timeout=3000\n' > "$WORK/npmrc"
# Away from the repository: a project .npmrc there could name the real registry.
cd "$WORK"

# --omit=optional: the other platform packages of optionalDependencies are not in these tarballs.
npm install -g --prefix "$PREFIX" --omit=optional --no-audit --no-fund "$TGZ"/wadeck-app-task-cli-*.tgz

TASK="$PREFIX/bin/task"
[ -e "$TASK" ] || { echo "smoke-packed: $TASK was not created by the install" >&2; exit 1; }
PLATFORM_DIR="$PREFIX/lib/node_modules/@wadeck-app/task-cli-$PLATFORM"
[ -d "$PLATFORM_DIR" ] || { echo "smoke-packed: platform package $PLATFORM_DIR not installed" >&2; exit 1; }
echo "--- installed launcher"
ls -l "$PLATFORM_DIR"
file "$PLATFORM_DIR/task" || true

failures=0
# check <label> <must contain> <args...>
check() {
  local label="$1" needle="$2"
  shift 2
  local out code
  set +e
  out="$("$TASK" "$@" 2>&1)"
  code=$?
  set -e
  if [ "$code" -ne 0 ] || [ -z "$out" ] || { [ -n "$needle" ] && [[ "$out" != *"$needle"* ]]; }; then
    failures=$((failures + 1))
    echo "FAIL [$label] task $* -> exit $code, output (${#out} chars):" >&2
    echo "$out" >&2
  else
    echo "ok   [$label] task $* -> exit 0, ${#out} chars"
  fi
}

run_all() {
  local label="$1"
  check "$label" "$VERSION" --version
  check "$label" "$VERSION" cli version
  check "$label" "" --help
}

run_all "platform package present"

# The platform package (Go launcher) is only needed by `start`: without it every other command must still work, and the
# shim must not go installing it behind the user's back.
rm -rf "$PLATFORM_DIR"
run_all "platform package absent"
if [ -e "$PLATFORM_DIR" ]; then
  failures=$((failures + 1))
  echo "FAIL [platform package absent] $PLATFORM_DIR was recreated: a command installed it" >&2
fi

if [ "$failures" -ne 0 ]; then
  echo "smoke-packed: $failures check(s) failed" >&2
  exit 1
fi
echo "smoke-packed: all checks passed on $(uname -s)-$(uname -m) (version $VERSION)"
