import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		include: ['src/**/*.test.ts'],
		exclude: ['**/node_modules/**', '**/dist/**'],
		mockReset: true,
		restoreMocks: true,
		// Removes the temp dirs a test leaves; sweeps those an interrupted earlier run left behind.
		setupFiles: ['../../scripts/testTempSetup.ts'],
		globalSetup: ['../../scripts/testTempGlobalSetup.ts'],
	},
	resolve: {
		extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
	},
	esbuild: {
		target: 'es2022',
	},
});
