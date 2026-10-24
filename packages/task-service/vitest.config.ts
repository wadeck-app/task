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
		setupFiles: ['./vitest.setup.ts'],
	},
	resolve: {
		extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
		// Load task-core from source so tests never run against a stale or missing dist/.
		alias: {
			'@wadeck-app/task-core': path.resolve(import.meta.dirname, '../task-core/src/index.ts'),
		},
	},
	esbuild: {
		target: 'es2022',
	},
});
