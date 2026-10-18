#!/usr/bin/env bash
# Generates platform package directories for npm publish.
# Called by CI before copy-binaries.sh. Not needed locally.
# Usage: bash packages/task-cli/ci/scripts/generate-platform-packages.sh (run from repo root)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATES_DIR="$SCRIPT_DIR/../templates"
REGISTRY="https://npm.pkg.github.com/"

generate() {
  local name="$1" os="$2" cpu="$3" bin_file="$4"
  local dir="packages/${name}"
  mkdir -p "$dir"
  cat > "$dir/package.json" <<EOF
{
  "name": "@wadeck-app/${name}",
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

generate "task-cli-win32-x64"    "win32"  "x64"   "task.exe"
generate "task-cli-darwin-arm64" "darwin" "arm64" "task"
generate "task-cli-darwin-x64"   "darwin" "x64"   "task"

# Generates the -dist wrapper package (bin launcher + package.json) for a CLI.
# The .cjs bundles are copied by copy-binaries.sh; this only creates the scaffolding.
# Extra args (3+): additional filenames to include in the files array (e.g. "worker.cjs").
generate_dist() {
  local cli="$1"
  shift
  # Build extra_files_json from remaining args: '"foo.cjs",' for each
  local extra_files_json=""
  for f in "$@"; do
    extra_files_json+="		\"${f}\","$'\n'
  done
  local dir="packages/${cli}-cli-dist"
  mkdir -p "$dir/bin"

  # Generate bin/${cli}.js from template
  sed -e "s/{{CLI_NAME}}/${cli}/g" -e "s/{{PKG_PREFIX}}/${cli}-cli/g" "$TEMPLATES_DIR/bin-launcher.js.tmpl" > "$dir/bin/${cli}.js"
  chmod +x "$dir/bin/${cli}.js"
  echo "generated $dir/bin/${cli}.js"

  # Generate package.json (preserves optionalDependencies, files, publishConfig)
  cat > "$dir/package.json" <<EOF
{
	"name": "@wadeck-app/${cli}-cli",
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
	"optionalDependencies": {
		"@wadeck-app/${cli}-cli-win32-x64": ">=0.0.0-0",
		"@wadeck-app/${cli}-cli-darwin-arm64": ">=0.0.0-0",
		"@wadeck-app/${cli}-cli-darwin-x64": ">=0.0.0-0"
	},
	"publishConfig": {
		"registry": "${REGISTRY}"
	}
}
EOF
  echo "generated $dir/package.json"
}

generate_dist "task" "app-module/"
