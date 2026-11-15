import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// A vitest run started from the repository root must go through the package configs (their setup files isolate the project registry,
// HOME and the queue). Without the root config such a run wrote test projects into the developer's real registry.
const repoRoot = path.resolve(__dirname, '..');

describe('root vitest config', () => {
	it('exists and delegates to every package and to architecture', () => {
		const file = path.join(repoRoot, 'vitest.config.ts');
		expect(
			fs.existsSync(file),
			`${file} is missing: a root-level vitest run would skip the registry isolation of the packages`
		).toBe(true);
		const text = fs.readFileSync(file, 'utf8');
		expect(text).toContain('projects');
		expect(text).toContain("'packages/*'");
		expect(text).toContain("'architecture'");
	});

	it('every package that has tests has a vitest config with a setup file', () => {
		for (const name of fs.readdirSync(path.join(repoRoot, 'packages'))) {
			const dir = path.join(repoRoot, 'packages', name);
			if (!fs.existsSync(path.join(dir, 'src'))) continue;
			const config = path.join(dir, 'vitest.config.ts');
			expect(fs.existsSync(config), `${name} has no vitest.config.ts`).toBe(true);
			expect(fs.readFileSync(config, 'utf8'), `${name}: vitest.config.ts has no setupFiles`).toContain(
				'setupFiles'
			);
		}
	});
});
