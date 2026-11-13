#!/usr/bin/env node

/**
 * Builds the Go launcher binaries for task-cli using the SDK build.sh script.
 * Usage: node ci/scripts/build-launcher.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.join(__dirname, '../..');
const CI_DIR = path.join(__dirname, '..');

// Resolve build.sh via require.resolve (handles workspace hoisting)
const require = createRequire(import.meta.url);
const sdkPkg = require.resolve('@wadeck-app/singleton-daemon-kit/package.json');
const SDK_DIR = path.dirname(sdkPkg);
const BUILD_SH = path.join(SDK_DIR, 'go-launcher', 'build.sh');
const TASK_CONFIG = path.join(CI_DIR, 'launcher-task.config.json');
const OUT_DIR = path.join(PACKAGE_DIR, 'launcher-go', 'dist');

if (!fs.existsSync(BUILD_SH)) {
	console.error(`build.sh not found at ${BUILD_SH}`);
	process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const toUnix = p => p.replace(/\\/g, '/');
console.log('Building task launchers...');
execFileSync('bash', [toUnix(BUILD_SH), toUnix(TASK_CONFIG), toUnix(OUT_DIR)], { stdio: 'inherit', windowsHide: true });

// Intel Macs and Linux arm64 are not supported (owner decision). The SDK's build.sh always cross-compiles all its targets
// and has no option to skip one, so the binaries it produced for them are deleted: nothing downstream (copy-binaries.sh)
// may pick them up.
for (const unsupported of ['task_darwin_amd64_release', 'task_linux_arm64_release']) {
	const binary = path.join(OUT_DIR, unsupported);
	if (fs.existsSync(binary)) {
		fs.rmSync(binary);
		console.log(`Removed ${binary} (unsupported platform)`);
	}
}
