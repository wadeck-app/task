import { defineConfig } from 'vitest/config';

// Static checks over the sources of all packages: no build needed, no package-specific setup.
// Run from the repository root: vitest run --root architecture
export default defineConfig({
	test: {
		environment: 'node',
		include: ['*.test.ts'],
	},
});
