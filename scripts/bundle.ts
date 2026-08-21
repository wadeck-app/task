/**
 * Bundles the task CLI into a single CommonJS file.
 * Bundles directly from TypeScript source (no prior tsc build required).
 * Output: dist-bundle/task.cjs
 * Usage:  npx tsx scripts/bundle.ts
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8')) as { version: string };
// Resolve flow-cli source for bundling without requiring a prior flow-cli build step
const flowCliSrc = path.resolve(root, '../flow-cli/src');

await build({
	entryPoints: [path.join(root, 'src/cli/TaskIndex.ts')],
	bundle: true,
	platform: 'node',
	target: 'node22',
	format: 'cjs',
	outfile: path.join(root, 'dist-bundle/task.cjs'),
	external: [],
	supported: { 'top-level-await': false },
	define: {
		'import.meta.url': '__importMetaUrl',
		__TASK_CLI_VERSION__: JSON.stringify(version),
	},
	banner: {
		js: `const __importMetaUrl = require('url').pathToFileURL(__filename).href;`,
	},
	// Resolve 'flow-cli' package imports to flow-cli source for standalone bundling
	alias: {
		'flow-cli': flowCliSrc,
	},
	logLevel: 'warning',
});

console.log('Bundle written to dist-bundle/task.cjs');
