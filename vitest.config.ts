import * as fs from 'fs';
import * as path from 'path';
import { type Plugin, defineConfig } from 'vitest/config';

// Resolve .js imports to .ts source files during testing (ESM → TypeScript)
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
		__TASK_CLI_VERSION__: '"0.0.1"',
	},
	test: {
		globals: true,
		environment: 'node',
		include: ['src/**/*.test.ts'],
		exclude: ['**/node_modules/**', '**/dist/**'],
		mockReset: true,
		restoreMocks: true,
	},
	resolve: {
		alias: {
			'shared-cli': path.resolve(__dirname, '../shared-cli/src'),
		},
		extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
	},
	esbuild: {
		target: 'es2022',
	},
});
