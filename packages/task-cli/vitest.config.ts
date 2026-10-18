import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Plugin, defineConfig } from 'vitest/config';

// Resolve .js imports to .ts source files during testing (ESM -> TypeScript)
function resolveJsToTs(): Plugin {
	return {
		name: 'resolve-js-to-ts',
		enforce: 'pre',
		resolveId(source, importer) {
			if (!importer || !source.startsWith('.')) return null;
			const tsPath = path.resolve(path.dirname(importer), source.replace(/\.js$/, '.ts'));
			if (fs.existsSync(tsPath)) return tsPath;
			return null;
		},
	};
}

export default defineConfig({
	plugins: [resolveJsToTs()],
	// Replace the esbuild bundle-time constant so updater tests see a real version string.
	define: {
		__TASK_CLI_VERSION__: '"2026.01.01-000000-0-TEST0000"',
	},
	test: {
		globals: true,
		environment: 'node',
		include: ['src/**/*.test.ts'],
		exclude: ['**/node_modules/**', '**/dist/**'],
		mockReset: true,
		restoreMocks: true,
		// Points XDG_CONFIG_HOME at a temp dir so no test touches the real ~/.config/task.
		setupFiles: ['./vitest.setup.ts'],
	},
	resolve: {
		extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
		// Load task-core and task-service from source so tests never run against a stale or missing dist/.
		alias: {
			'@wadeck-app/task-core': path.resolve(import.meta.dirname, '../task-core/src/index.ts'),
			'@wadeck-app/task-service': path.resolve(import.meta.dirname, '../task-service/src/index.ts'),
		},
	},
	esbuild: {
		target: 'es2022',
	},
});
