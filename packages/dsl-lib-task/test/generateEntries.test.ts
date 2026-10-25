import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateEntries } from '../scripts/generate-entries.js';
import { LIB_ENTRIES } from '../scripts/paths.js';

describe('the generated entries file', () => {
	it('is what the generator produces now (run "npm run entries --workspace=packages/dsl-lib-task" if not)', () => {
		expect(
			fs.existsSync(LIB_ENTRIES),
			`${LIB_ENTRIES} is missing: run "npm run entries --workspace=packages/dsl-lib-task"`
		).toBe(true);
		expect(fs.readFileSync(LIB_ENTRIES, 'utf8').replace(/\r\n/g, '\n')).toBe(generateEntries());
	}, 240_000);
});

describe('the generated entries and the installed shell', () => {
	const source = fs.readFileSync(LIB_ENTRIES, 'utf8');

	it('take the coercion helpers from compat/dslRenderer.ts: the shell (dsl-renderer 175) does not export them', () => {
		expect(source).toContain("from '../compat/dslRenderer.js'");
		const fromPackage = [...source.matchAll(/import \{([^}]*)\} from '@wadeck-app\/dsl-renderer'/g)].flatMap(m =>
			m[1]!.split(',').map(name => name.trim())
		);
		for (const name of ['coerceProp', 'resolveExpressionsDeep', 'coerceDate', 'coerceStringList']) {
			expect(fromPackage, `${name} must not be imported from the package`).not.toContain(name);
		}
	});

	it('still import renderChildren and resolveExpressionValue from the package, which the shell exports', () => {
		expect(source).toMatch(/import \{[^}]*renderChildren[^}]*\} from '@wadeck-app\/dsl-renderer'/);
		expect(source).toMatch(/import \{[^}]*resolveExpressionValue[^}]*\} from '@wadeck-app\/dsl-renderer'/);
	});
});

/*
 * dsl-renderer lists the component files with fs.readdirSync and never sorts them, so the order of the entries was
 * the file system's. The generator sorts the listing itself; this checks that a case-insensitive listing (Windows)
 * gives the same file as the committed one.
 */
describe('the generated entries do not depend on the file system listing order', () => {
	it('gives the committed file for a case-insensitive listing, the order Windows lists in', () => {
		const real = fs.readdirSync;
		fs.readdirSync = ((...args: Parameters<typeof fs.readdirSync>) => {
			const result = (real as (...a: unknown[]) => unknown).apply(fs, args);
			return Array.isArray(result) && result.every(entry => typeof entry === 'string')
				? [...result].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
				: result;
		}) as typeof fs.readdirSync;
		let windows: string;
		try {
			windows = generateEntries();
		} finally {
			fs.readdirSync = real;
		}

		expect(windows).toBe(fs.readFileSync(LIB_ENTRIES, 'utf8').replace(/\r\n/g, '\n'));
	}, 240_000);
});
