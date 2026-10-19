import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { checkManifest, checkSource, importedModules, PACKAGE_RULES } from './rules.js';
import type { PackageName, Violation } from './rules.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PACKAGES = Object.keys(PACKAGE_RULES) as PackageName[];

function sourceFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(full);
		return /\.(ts|tsx|mts|cts)$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
	});
}

function repoRelative(file: string): string {
	return path.relative(ROOT, file).split(path.sep).join('/');
}

function violationsOf(pkg: PackageName): { checked: number; violations: Violation[] } {
	const rule = PACKAGE_RULES[pkg];
	const files = sourceFiles(path.join(ROOT, 'packages', pkg, 'src'));
	const violations = files.flatMap(file =>
		checkSource(repoRelative(file), fs.readFileSync(file, 'utf8'), rule, {
			isTest: /\.test\.tsx?$/.test(file) || path.basename(file) === 'testHelpers.ts',
			resolveRelative: specifier => repoRelative(path.resolve(path.dirname(file), specifier)),
		})
	);
	const manifestFile = path.join(ROOT, 'packages', pkg, 'package.json');
	const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Parameters<typeof checkManifest>[1];
	return {
		checked: files.length,
		violations: [...violations, ...checkManifest(repoRelative(manifestFile), manifest, rule)],
	};
}

function format(violations: Violation[]): string {
	return violations.map(v => `${v.file}: ${v.rule}: ${v.detail}`).join('\n');
}

describe('dependency direction of the task packages', () => {
	it.each(PACKAGES)('%s respects its rules', pkg => {
		const { checked, violations } = violationsOf(pkg);
		// A scan that finds no file proves nothing: fail instead of passing silently.
		expect(checked, `no source file found for ${pkg}`).toBeGreaterThan(0);
		expect(violations, format(violations)).toEqual([]);
	});
});

describe('the rules detect what they forbid', () => {
	const noRelative = (s: string): string => s;
	const inSrc = { isTest: false, resolveRelative: noRelative };

	function violationsIn(pkg: PackageName, source: string, options = inSrc): string[] {
		return checkSource('x.ts', source, PACKAGE_RULES[pkg], options).map(v => v.detail);
	}

	it('app-module-task must not import task-cli or shared-cli', () => {
		expect(violationsIn('app-module-task', "import { x } from 'task-cli/foo.js';")).toHaveLength(1);
		expect(violationsIn('app-module-task', "import { x } from '@wadeck-app/shared-cli';")).toHaveLength(1);
		expect(
			violationsIn('app-module-task', "import { x } from '../../task-cli/src/x.js';", {
				isTest: false,
				resolveRelative: () => 'packages/task-cli/src/x.js',
			})
		).toHaveLength(1);
	});

	it('task-cli must not import app-module-task', () => {
		expect(violationsIn('task-cli', "import { x } from '@wadeck-app/app-module-task';")).toHaveLength(1);
		expect(violationsIn('task-cli', "const m = await import('@wadeck-app/app-module-task/dist');")).toHaveLength(1);
	});

	it('task-service must not import an adapter, a CLI library, app-core or an HTTP framework', () => {
		for (const specifier of [
			'task-cli',
			'@wadeck-app/app-module-task',
			'@wadeck-app/shared-cli/ConfigDir',
			'@wadeck-app/app-core-sdk',
			'fastify',
		]) {
			expect(violationsIn('task-service', `import { x } from '${specifier}';`), specifier).toHaveLength(1);
		}
	});

	it('task-service must not print, exit or read argv (outside tests)', () => {
		expect(violationsIn('task-service', 'console.log(1);')).toHaveLength(1);
		expect(violationsIn('task-service', 'process.exit(1);')).toHaveLength(1);
		expect(violationsIn('task-service', 'const a = process.argv;')).toHaveLength(1);
		expect(violationsIn('task-service', 'console.log(1);', { isTest: true, resolveRelative: noRelative })).toEqual(
			[]
		);
		expect(violationsIn('task-service', '// console.log(1) in a comment')).toEqual([]);
	});

	it('task-core must not import task-service', () => {
		expect(violationsIn('task-core', "import { x } from '@wadeck-app/task-service';")).toHaveLength(1);
	});

	it('allowed imports pass', () => {
		expect(violationsIn('task-cli', "import { x } from '@wadeck-app/task-service';")).toEqual([]);
		expect(violationsIn('app-module-task', "import { x } from '@wadeck-app/task-service';")).toEqual([]);
		expect(violationsIn('task-service', "import { x } from '@wadeck-app/task-core';")).toEqual([]);
	});

	it('a forbidden package.json dependency is reported', () => {
		const found = checkManifest('p.json', { dependencies: { 'task-cli': '*' } }, PACKAGE_RULES['app-module-task']);
		expect(found).toHaveLength(1);
		expect(found[0]!.rule).toBe('forbidden-dependency');
	});

	it('finds static, side-effect, dynamic and require imports', () => {
		expect(
			importedModules(
				"import a from 'a'; import type { B } from 'b'; import 'c'; const d = await import('d'); const e = require('e'); export * from 'f';"
			).sort()
		).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
	});
});

describe('the adapters agree on the app-core module id without importing each other', () => {
	const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');
	const manifestId = (JSON.parse(read('packages/app-module-task/manifest.json')) as { id?: string }).id;

	it('manifest.json declares the id', () => {
		expect(manifestId, 'packages/app-module-task/manifest.json has no "id"').toBeTruthy();
	});

	it('task-cli registers the module under the id of the manifest', () => {
		expect(read('packages/task-cli/src/AppCoreRegistration.ts')).toContain(`APP_CORE_MODULE_ID = '${manifestId}'`);
	});

	it('the module builds its page links under the id of the manifest', () => {
		expect(read('packages/app-module-task/src/backend/hrefs.ts')).toContain(`MODULE_ID = '${manifestId}'`);
	});
});
