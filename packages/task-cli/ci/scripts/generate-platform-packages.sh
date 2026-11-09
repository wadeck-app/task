#!/usr/bin/env bash
# Generates platform package directories for npm publish.
# Called by CI before copy-binaries.sh. Not needed locally.
#
# Usage:
#   bash ci/scripts/generate-platform-packages.sh <cli[:extra-file1[:extra-file2]]>...
#
# Examples:
#   bash ci/scripts/generate-platform-packages.sh flow:worker.cjs task
#   bash ci/scripts/generate-platform-packages.sh my-cli
#   bash ci/scripts/generate-platform-packages.sh a:extra1.cjs:extra2.cjs b
#
# Each argument is a CLI name optionally followed by extra filenames separated by ':'.
# Extra filenames are added to the "files" array in the dist package.json (e.g. "worker.cjs").
#
# Environment variables:
#   TEMPLATES_DIR   Path to the templates directory containing bin-launcher.js.tmpl.
#                   Defaults to <script-dir>/../templates.
#   REGISTRY        npm registry URL (default: https://npm.pkg.github.com/).
#   PKG_SCOPE       npm scope without leading '@' (default: wadeck-app).
#   PLATFORMS       Comma list of platforms to generate and support, among win32-x64, darwin-arm64, darwin-x64
#                   (default: all three). The same list is baked into the shim as {{PLATFORMS}}: any other host
#                   is refused by the shim with "unsupported platform". Set it explicitly in every consumer.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATES_DIR="${TEMPLATES_DIR:-${SCRIPT_DIR}/../templates}"
REGISTRY="${REGISTRY:-https://npm.pkg.github.com/}"
PKG_SCOPE="${PKG_SCOPE:-wadeck-app}"
PLATFORMS="${PLATFORMS:-win32-x64,darwin-arm64,darwin-x64}"

# platform_os_cpu <key>: prints "<os> <cpu>" for a supported platform key, fails loudly otherwise.
platform_os_cpu() {
  case "$1" in
    win32-x64)    echo "win32 x64" ;;
    darwin-arm64) echo "darwin arm64" ;;
    darwin-x64)   echo "darwin x64" ;;
    *)
      echo "Error: unsupported platform '$1' in PLATFORMS='${PLATFORMS}'. Allowed: win32-x64, darwin-arm64, darwin-x64." >&2
      return 1
      ;;
  esac
}

IFS=',' read -ra PLATFORM_LIST <<< "$PLATFORMS"
if [[ ${#PLATFORM_LIST[@]} -eq 0 || -z "${PLATFORM_LIST[0]}" ]]; then
  echo "Error: PLATFORMS is empty. Set it to a comma list, e.g. PLATFORMS=win32-x64,darwin-arm64." >&2
  exit 1
fi
for p in "${PLATFORM_LIST[@]}"; do platform_os_cpu "$p" > /dev/null; done

if [[ $# -eq 0 ]]; then
  echo "Error: no CLI names provided." >&2
  echo "Usage: $0 <cli[:extra-file1[:extra-file2]]>..." >&2
  exit 1
fi

BIN_LAUNCHER_TMPL="${TEMPLATES_DIR}/bin-launcher.js.tmpl"
if [[ ! -f "$BIN_LAUNCHER_TMPL" ]]; then
  echo "Error: template not found: $BIN_LAUNCHER_TMPL" >&2
  echo "Set TEMPLATES_DIR to the directory containing bin-launcher.js.tmpl." >&2
  exit 1
fi

# generate <package-name> <os> <cpu> <bin-file>
# Creates packages/<package-name>/package.json for a platform-specific binary package.
generate() {
  local name="$1" os="$2" cpu="$3" bin_file="$4"
  local dir="packages/${name}"
  mkdir -p "$dir"
  cat > "$dir/package.json" <<EOF
{
  "name": "@${PKG_SCOPE}/${name}",
  "version": "0.0.0",
  "os": ["${os}"],
  "cpu": ["${cpu}"],
  "files": ["${bin_file}"],
  "publishConfig": {
    "registry": "${REGISTRY}"
  }
}
EOF
  echo "generated packages/${name}/package.json"
}

# generate_dist <cli> [extra-file1 extra-file2 ...]
# Creates packages/<cli>-cli-dist/ with bin launcher and package.json.
# Extra args (2+): additional filenames to include in the files array (e.g. "worker.cjs").
generate_dist() {
  local cli="$1"
  shift
  # Build extra_files_json from remaining args: '"foo.cjs",' for each
  local extra_files_json=""
  for f in "$@"; do
    extra_files_json+="		\"${f}\","$'\n'
  done
  local optional_json="" sep=""
  for p in "${PLATFORM_LIST[@]}"; do
    optional_json+="${sep}"$'\n'"		\"@${PKG_SCOPE}/${cli}-cli-${p}\": \">=0.0.0-0\""
    sep=","
  done
  local dir="packages/${cli}-cli-dist"
  mkdir -p "$dir/bin"

  # Generate bin/${cli}.js from template
  sed -e "s/{{CLI_NAME}}/${cli}/g" -e "s/{{PKG_PREFIX}}/${cli}-cli/g" -e "s/{{PLATFORMS}}/${PLATFORMS}/g" \
      "${BIN_LAUNCHER_TMPL}" > "$dir/bin/${cli}.js"
  chmod +x "$dir/bin/${cli}.js"
  echo "generated $dir/bin/${cli}.js"

  # Generate package.json (preserves optionalDependencies, files, publishConfig)
  cat > "$dir/package.json" <<EOF
{
	"name": "@${PKG_SCOPE}/${cli}-cli",
	"version": "0.0.0",
	"private": false,
	"type": "commonjs",
	"bin": {
		"${cli}": "./bin/${cli}.js"
	},
	"files": [
		"bin/",
		"${cli}.cjs",
		"${cli}-updater.cjs",
${extra_files_json}		"package.json"
	],
	"optionalDependencies": {${optional_json}
	},
	"publishConfig": {
		"registry": "${REGISTRY}"
	}
}
EOF
  echo "generated $dir/package.json"
}

for arg in "$@"; do
  # Split on ':' — first field is the CLI name, remaining fields are extra files
  IFS=':' read -ra parts <<< "$arg"
  cli="${parts[0]}"
  extra_files=("${parts[@]:1}")

  for p in "${PLATFORM_LIST[@]}"; do
    read -r os cpu <<< "$(platform_os_cpu "$p")"
    bin_file="${cli}"
    [[ "$os" == "win32" ]] && bin_file="${cli}.exe"
    generate "${cli}-cli-${p}" "$os" "$cpu" "$bin_file"
  done
  generate_dist "${cli}" "${extra_files[@]+"${extra_files[@]}"}"
done
