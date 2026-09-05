/**
 * Bundles the task CLI into a single CommonJS file.
 * Bundles directly from TypeScript source (no prior tsc build required).
 * Output: dist-bundle/task.cjs and dist-bundle/task-updater.cjs
 * Usage:  npx tsx ci/scripts/bundle.ts
 */
import { build } from 'esbuild';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '../..');

const MAX_UPDATER_SIZE = 500 * 1024; // 500 KB

const version = process.env['BUNDLE_VERSION'];
if (!version) {
	process.stderr.write('[bundle] ERROR: BUNDLE_VERSION env var not set -- refusing to build without a version\n');
	process.exit(1);
}
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
		`task-updater.cjs is ${updaterSize} bytes (${(updaterSize / 1024).toFixed(1)} KB) -- exceeds 500 KB limit.\n` +
			'The task runtime may have been accidentally included. Check task-updater-entry.ts imports.'
	);
}

console.log(`Bundled task.cjs + task-updater.cjs (${(updaterSize / 1024).toFixed(1)} KB) -- version: ${version}`);
