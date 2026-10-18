/**
 * Bundles the task CLI into a single CommonJS file.
 * Bundles directly from TypeScript source (no prior tsc build required).
 * Output: dist-bundle/task.cjs, dist-bundle/task-updater.cjs and dist-bundle/app-module/ (packaged app-module-task)
 * Usage:  npx tsx ci/scripts/bundle.ts
 */
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { cpSync, existsSync, rmSync, statSync } from 'node:fs';
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
const sharedDefine = {
	'import.meta.url': '__importMetaUrl',
	__TASK_CLI_VERSION__: JSON.stringify(version),
};
const sharedBanner = { js: `const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;` };

const updaterOutfile = path.join(root, 'dist-bundle/task-updater.cjs');

await Promise.all([
	build({
		entryPoints: [path.join(root, 'src/TaskIndex.ts')],
		bundle: true,
		platform: 'node',
		target: 'node22',
		format: 'cjs',
		outfile: path.join(root, 'dist-bundle/task.cjs'),
		external: [],
		supported: { 'top-level-await': false },
		define: sharedDefine,
		banner: sharedBanner,
		logLevel: 'warning',
	}),
	build({
		entryPoints: [path.join(root, 'src/task-updater-entry.ts')],
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

// The app-module is built by its own package: `npm run bundle` there runs `app-core-cli package` (backend bundle,
// views, packaged manifest stamped with BUNDLE_VERSION). task-cli only copies the resulting dist-module/ next to
// task.cjs, where `task cli register` and the updater look for it.
const appModuleDir = path.join(root, '../app-module-task');
const appModuleOutDir = path.join(root, 'dist-bundle/app-module');
execSync('npm run bundle', {
	cwd: appModuleDir,
	env: { ...process.env, BUNDLE_VERSION: version },
	stdio: 'inherit',
	windowsHide: true,
});
const packagedModule = path.join(appModuleDir, 'dist-module');
if (!existsSync(path.join(packagedModule, 'manifest.json'))) {
	throw new Error(
		`app-module-task produced no ${packagedModule}/manifest.json: run "npm run bundle" in packages/app-module-task and read its output.`
	);
}
rmSync(appModuleOutDir, { recursive: true, force: true });
cpSync(packagedModule, appModuleOutDir, { recursive: true });

const updaterSize = statSync(updaterOutfile).size;
if (updaterSize > MAX_UPDATER_SIZE) {
	throw new Error(
		`task-updater.cjs is ${updaterSize} bytes (${(updaterSize / 1024).toFixed(1)} KB) -- exceeds 500 KB limit.\n` +
			'The task runtime may have been accidentally included. Check task-updater-entry.ts imports.'
	);
}

console.log(`Bundled task.cjs + task-updater.cjs (${(updaterSize / 1024).toFixed(1)} KB) -- version: ${version}`);
