import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		include: ['src/**/*.test.ts'],
		exclude: ['**/node_modules/**', '**/dist/**'],
		mockReset: true,
		restoreMocks: true,
		// Sets QUEUE_SDK_OFF=1: no test can push to a real queue.
		setupFiles: ['../../scripts/testTempSetup.ts', './vitest.setup.ts'],
		// Sweeps the temp dirs an interrupted earlier run left behind.
		globalSetup: ['../../scripts/testTempGlobalSetup.ts'],
	},
	resolve: {
		extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
		// Load task-core from source so tests never run against a stale or missing dist/.
		alias: {
			// The contract suites (they import vitest) are test helpers, not part of the package barrel. Listed first: the
			// shorter key below also matches this path.
			'@wadeck-app/task-core/contract': path.resolve(import.meta.dirname, '../task-core/src/contract/index.ts'),
			'@wadeck-app/task-core': path.resolve(import.meta.dirname, '../task-core/src/index.ts'),
		},
	},
	esbuild: {
		target: 'es2022',
	},
});
