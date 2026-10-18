import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		restoreMocks: true,
		include: ['src/**/*.test.ts'],
		// The real-server test spawns app-core and packages the module: it has its own, longer timeouts.
		testTimeout: 15_000,
	},
	resolve: {
		// Load task-core and task-service from source so tests never run against a stale or missing dist/.
		alias: {
			'@wadeck-app/task-core': path.resolve(import.meta.dirname, '../task-core/src/index.ts'),
			'@wadeck-app/task-service': path.resolve(import.meta.dirname, '../task-service/src/index.ts'),
		},
	},
});
