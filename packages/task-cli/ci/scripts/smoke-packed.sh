#!/usr/bin/env bash
# Smoke test of the PACKED CLI on the machine it runs on (CI: macOS and Linux runners). Nothing is published and the real
# global npm is never touched: the packages are `npm pack`ed, installed into a throwaway prefix, and run from there.
# Fails loudly (full output) when a tarball loses the exec bit, or a command exits non-zero, prints nothing on stdout,
# or does not show the version. Registry errors on stderr are expected (the registry is a dead loopback port) and
# are not asserted on.
#
# Usage: bash smoke-packed.sh <packages dir> <cli> <expected version> <platforms>
#   <packages dir>  holds <cli>-cli-dist and <cli>-cli-<platform> (the build job's artifact, exec bits restored).
#   <platforms>     the same comma list as PLATFORMS of generate-platform-packages.sh; the host must be one of them.
set -euo pipefail

USAGE="usage: smoke-packed.sh <packages dir> <cli> <expected version> <platforms>"
PACKAGES_DIR="${1:?$USAGE}"
CLI="${2:?$USAGE}"
VERSION="${3:?$USAGE}"
PLATFORMS="${4:?$USAGE}"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  PLATFORM="darwin-arm64" ;;
  Darwin-x86_64) PLATFORM="darwin-x64" ;;
  Linux-x86_64)  PLATFORM="linux-x64" ;;
  *) echo "smoke-packed: unsupported host $(uname -s)-$(uname -m): this script runs on macOS (darwin-arm64, darwin-x64) or Linux (linux-x64)" >&2; exit 1 ;;
esac
case ",$PLATFORMS," in
  *",$PLATFORM,"*) ;;
  *) echo "smoke-packed: host platform $PLATFORM is not in PLATFORMS='$PLATFORMS': run it on a supported runner" >&2; exit 1 ;;
esac

WORK="$(mktemp -d)"
# task-specific (not in the ci-templates copy): the CLI schedules a detached background updater that may still be writing
# into the npm cache when the checks end, so `rm -rf` can fail with "Directory not empty" (run 43522571279: every check
# passed, the script exited 1 on that alone). A failed cleanup of a throwaway directory is a warning, never a failure of
# the smoke, and never changes the exit code of the checks.
cleanup() {
  local code=$?
  rm -rf "$WORK" 2>/dev/null || { sleep 2; rm -rf "$WORK" 2>/dev/null; } || echo "smoke-packed: warning: could not remove $WORK (a background process of the CLI is still writing there)" >&2
  exit "$code"
}
trap cleanup EXIT
TGZ="$WORK/tgz"
PREFIX="$WORK/prefix"
HOME_DIR="$WORK/home"
mkdir -p "$TGZ" "$PREFIX" "$HOME_DIR/.config"

for pkg in "${CLI}-cli-dist" "${CLI}-cli-$PLATFORM"; do
  [ -d "$PACKAGES_DIR/$pkg" ] || { echo "smoke-packed: $PACKAGES_DIR/$pkg is missing (artifact incomplete)" >&2; exit 1; }
  (cd "$PACKAGES_DIR/$pkg" && npm pack --silent --pack-destination "$TGZ" >/dev/null)
done

# The published tarball must carry the exec bit on the launcher and the shim: this is the regression being guarded.
echo "--- tarball entries (mode, size, name)"
failures=0
for t in "$TGZ"/*.tgz; do
  echo "$(basename "$t")"
  entries="$(tar -tvzf "$t" | grep -E "package/(${CLI}|bin/${CLI}\.js)$" || true)"
  echo "$entries"
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    if [[ "${line:0:10}" != *x*x*x* ]]; then
      failures=$((failures + 1))
      echo "FAIL tarball entry without the exec bit: $line (restore-exec-bits.sh was not run, or npm pack dropped it)" >&2
    fi
  done <<< "$entries"
done

# Throwaway npm and home: no real config, no real registry (the background updater of the CLI must not find one either).
export HOME="$HOME_DIR" XDG_CONFIG_HOME="$HOME_DIR/.config" USERPROFILE="$HOME_DIR"
export NPM_CONFIG_PREFIX="$PREFIX" NPM_CONFIG_CACHE="$WORK/npm-cache" NPM_CONFIG_USERCONFIG="$WORK/npmrc"
export NPM_CONFIG_REGISTRY="http://127.0.0.1:9/"
printf 'registry=http://127.0.0.1:9/\n@wadeck-app:registry=http://127.0.0.1:9/\nfetch-retries=0\nfetch-timeout=3000\n' > "$WORK/npmrc"
# Away from the repository: a project .npmrc there could name the real registry.
cd "$WORK"

# --omit=optional: the other platform packages of optionalDependencies are not in these tarballs.
npm install -g --prefix "$PREFIX" --omit=optional --no-audit --no-fund "$TGZ"/wadeck-app-"${CLI}"-cli-*.tgz

BIN="$PREFIX/bin/$CLI"
[ -e "$BIN" ] || { echo "smoke-packed: $BIN was not created by the install" >&2; exit 1; }
# task-specific (not in the ci-templates copy): --omit=optional above hides a dependency problem a real install has. A
# prerelease version (edge builds YYYY.MM.DD-NNN-sha8) does not satisfy a range such as ">=0.0.0-0", so npm would install
# NO platform package: every optionalDependency of the dist package must be pinned to the exact build version.
DIST_JSON="$PREFIX/lib/node_modules/@wadeck-app/${CLI}-cli/package.json"
[ -f "$DIST_JSON" ] || { echo "smoke-packed: $DIST_JSON not found" >&2; exit 1; }
if ! grep -q "\"@wadeck-app/${CLI}-cli-$PLATFORM\": \"$VERSION\"" "$DIST_JSON"; then
  echo "smoke-packed: optionalDependencies of $DIST_JSON do not pin @wadeck-app/${CLI}-cli-$PLATFORM to $VERSION (a range a prerelease does not satisfy makes npm install no platform package):" >&2
  grep -n "optionalDependencies" -A5 "$DIST_JSON" >&2 || true
  exit 1
fi
PLATFORM_DIR="$PREFIX/lib/node_modules/@wadeck-app/${CLI}-cli-$PLATFORM"
[ -d "$PLATFORM_DIR" ] || { echo "smoke-packed: platform package $PLATFORM_DIR not installed" >&2; exit 1; }
echo "--- installed launcher"
ls -l "$PLATFORM_DIR"
file "$PLATFORM_DIR/$CLI" || true

# check <label> <output must contain (may be empty)> <args...>
# COMBINE=1 judges stdout and stderr together (a command whose only output, on purpose, is an error line on stderr).
check() {
  local label="$1" needle="$2"
  shift 2
  local out err code
  err="$WORK/stderr"
  set +e
  out="$("$BIN" "$@" 2> "$err")"
  code=$?
  set -e
  if [ "${COMBINE:-0}" = "1" ]; then out="$out$(cat "$err")"; fi
  if [ "$code" -ne 0 ] || [ -z "$out" ] || { [ -n "$needle" ] && [[ "$out" != *"$needle"* ]]; }; then
    failures=$((failures + 1))
    echo "FAIL [$label] $CLI $* -> exit $code, stdout (${#out} chars):" >&2
    echo "$out" >&2
    echo "--- stderr:" >&2
    cat "$err" >&2
  else
    echo "ok   [$label] $CLI $* -> exit 0, ${#out} chars"
  fi
}

run_all() {
  local label="$1"
  check "$label" "$VERSION" --version
  # task-specific (not in the ci-templates copy): `cli version` goes through the CLI's own command tree.
  # The registry is unreachable on purpose here, so shared-cli prints only "Failed to fetch latest version for <package>"
  # on stderr (exit 0, nothing on stdout): what is checked is that the command runs and answers something naming the package.
  COMBINE=1 check "$label" "@wadeck-app/${CLI}-cli" cli version
  check "$label" "" --help
}

run_all "platform package present"

# The platform package (Go launcher) is only needed by `start`: without it every other command must still work, and
# the shim must not go installing it behind the user's back.
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
