/**
 * Bundles the task CLI into a single CommonJS file.
 * Bundles directly from TypeScript source (no prior tsc build required).
 * Output: dist-bundle/task.cjs and dist-bundle/task-updater.cjs
 * Usage:  npx tsx ci/scripts/bundle.ts
 */
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '../..');

const MAX_UPDATER_SIZE = 500 * 1024; // 500 KB

function getCalVer(): string {
	const now = new Date();
	const pad2 = (n: number) => String(n).padStart(2, '0');
	const date = `${now.getFullYear()}.${pad2(now.getMonth() + 1)}.${pad2(now.getDate())}`;
	const time = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
	let count = '0';
	let hash = 'DEV';
	try {
		count = execSync('git rev-list --count HEAD', { encoding: 'utf8' }).trim();
	} catch {
		/* not a git repo */
	}
	try {
		hash = execSync('git rev-parse --short=8 HEAD', { encoding: 'utf8' }).trim();
	} catch {
		/* not a git repo */
	}
	return `${date}-${time}-${count}-${hash}`;
}
const version = process.env['BUNDLE_VERSION'] || getCalVer();
// Resolve flow-cli source for bundling without requiring a prior flow-cli build step
const flowCliSrc = path.resolve(root, '../flow-cli/src');

const sharedDefine = {
	'import.meta.url': '__importMetaUrl',
	__TASK_CLI_VERSION__: JSON.stringify(version),
};
const sharedBanner = { js: `const __importMetaUrl = require('url').pathToFileURL(__filename).href;` };

const updaterOutfile = path.join(root, 'dist-bundle/task-updater.cjs');

await Promise.all([
	build({
		entryPoints: [path.join(root, 'src/cli/TaskIndex.ts')],
		bundle: true,
		platform: 'node',
		target: 'node22',
		format: 'cjs',
		outfile: path.join(root, 'dist-bundle/task.cjs'),
		external: [],
		supported: { 'top-level-await': false },
		define: sharedDefine,
		banner: sharedBanner,
		// Resolve 'flow-cli' package imports to flow-cli source for standalone bundling
		alias: {
			'flow-cli': flowCliSrc,
		},
		logLevel: 'warning',
	}),
	build({
		entryPoints: [path.join(root, 'src/cli/task-updater-entry.ts')],
		bundle: true,
		format: 'cjs',
		platform: 'node',
		target: 'node22',
		outfile: updaterOutfile,
		banner: sharedBanner,
		define: sharedDefine,
		external: [],
		supported: { 'top-level-await': false },
		logLevel: 'warning',
	}),
]);

const updaterSize = statSync(updaterOutfile).size;
if (updaterSize > MAX_UPDATER_SIZE) {
	throw new Error(
		`task-updater.cjs is ${updaterSize} bytes (${(updaterSize / 1024).toFixed(1)} KB) — exceeds 500 KB limit.\n` +
			'The task runtime may have been accidentally included. Check task-updater-entry.ts imports.'
	);
}

console.log(`Bundled task.cjs + task-updater.cjs (${(updaterSize / 1024).toFixed(1)} KB) — version: ${version}`);
