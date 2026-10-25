import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/*
 * Two suites with different needs, hence two projects:
 *  - ui:  the React components and helpers under src/. jsdom; dsl-ui and dsl-renderer resolve to their dist.
 *  - lib: the packaged module under test/. Plain Node (esbuild, which `app-core-cli package` runs, refuses to start
 *         in jsdom), and one global setup that builds the stylesheet and packages the module once for all of them.
 */
export default defineConfig({
	test: {
		projects: [
			{
				plugins: [react()],
				test: {
					name: 'ui',
					root: import.meta.dirname,
					environment: 'jsdom',
					globals: true,
					setupFiles: ['./src/test-setup.ts'],
					include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
				},
			},
			{
				test: {
					name: 'lib',
					root: import.meta.dirname,
					globalSetup: ['./test/global-setup.ts'],
					setupFiles: ['./test/test-setup.ts'],
					globals: true,
					environment: 'node',
					restoreMocks: true,
					include: ['test/**/*.test.{ts,tsx}'],
					// Packaging the module and parsing the components with ts-morph are slow on a loaded runner.
					testTimeout: 60_000,
					hookTimeout: 120_000,
				},
			},
		],
	},
});
