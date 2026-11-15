import { defineConfig } from 'vitest/config';

// A vitest run started from the repository root (`npx vitest run packages/x/src/y.test.ts`) must use the config of the package the test
// belongs to: its setup file points XDG_CONFIG_HOME / HOME / USERPROFILE at a temp dir. Without this file vitest ran such a test with its
// defaults, no setup, and every `registerTestProject` wrote into the developer's real project registry (519 test projects were found there).
export default defineConfig({
	test: {
		projects: ['packages/*', 'architecture'],
	},
});
