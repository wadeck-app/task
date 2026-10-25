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
			isTest: /\.test\.tsx?$/.test(file) || ['testHelpers.ts', 'test-setup.ts'].includes(path.basename(file)),
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

	describe('dsl-lib-task: browser components', () => {
		const inLib = (source: string, isTest = false): string[] =>
			violationsIn('dsl-lib-task', source, { isTest, resolveRelative: noRelative });

		it('may import react, the shared dsl packages, the icon set and its own files', () => {
			for (const specifier of [
				'react',
				'react/jsx-runtime',
				'react-dom',
				'@wadeck-app/dsl-ui',
				'@wadeck-app/dsl-ui/dist/components/display/Badge.js',
				'@wadeck-app/dsl-renderer',
				'lucide-react',
				'./Timeline.js',
				'../runtime-config.js',
			]) {
				expect(inLib(`import { x } from '${specifier}';`), specifier).toEqual([]);
			}
		});

		it('must not import a Node builtin or an unlisted dependency (outside tests)', () => {
			for (const specifier of ['node:fs', 'node:path', 'fs', 'path', 'zod', 'react-router-dom', 'lodash']) {
				expect(inLib(`import { x } from '${specifier}';`), specifier).toHaveLength(1);
			}
			expect(inLib("import fs from 'node:fs';", true)).toEqual([]);
			expect(inLib("import { render } from '@testing-library/react';", true)).toEqual([]);
		});

		it('must not import the service, the storage, the CLI, the module or the app-core libraries', () => {
			for (const specifier of [
				'@wadeck-app/task-service',
				'@wadeck-app/task-core',
				'task-cli',
				'@wadeck-app/app-module-task',
				'@wadeck-app/app-module-task/dist',
				'@wadeck-app/app-core-sdk',
				'@wadeck-app/shared-cli',
				'fastify',
			]) {
				expect(inLib(`import { x } from '${specifier}';`).length, specifier).toBeGreaterThan(0);
				// Not even a test may couple the components to the backend.
				expect(
					inLib(`import { x } from '${specifier}';`, true).length,
					`${specifier} in a test`
				).toBeGreaterThan(0);
			}
			expect(
				violationsIn('dsl-lib-task', "import { x } from '../../task-service/src/x.js';", {
					isTest: false,
					resolveRelative: () => 'packages/task-service/src/x.js',
				}).length
			).toBeGreaterThan(0);
		});

		it('must not use the Node process API', () => {
			expect(inLib('const dir = process.cwd();')).toHaveLength(1);
			expect(inLib('const dir = process.env.HOME;')).toHaveLength(1);
			expect(inLib('const dir = process.cwd();', true)).toEqual([]);
		});

		it('is itself unknown to the node-side packages', () => {
			for (const pkg of ['task-core', 'task-service', 'task-cli'] as const) {
				expect(violationsIn(pkg, "import { x } from '@wadeck-app/dsl-lib-task';"), pkg).toHaveLength(1);
			}
			// The module loads it (src/dsl-components).
			expect(violationsIn('app-module-task', "import { x } from '@wadeck-app/dsl-lib-task';")).toEqual([]);
		});

		it('declaring a forbidden dependency in package.json is reported', () => {
			const found = checkManifest(
				'p.json',
				{ dependencies: { '@wadeck-app/task-service': '*' } },
				PACKAGE_RULES['dsl-lib-task']
			);
			expect(found).toHaveLength(1);
		});
	});

	// The queue SDK is the shared delivery adapter of the events (queueEventSink.ts): both adapters get it through task-service.
	it('task-service may import the queue SDK, while shared-cli and app-core stay forbidden there', () => {
		expect(violationsIn('task-service', "import { createQueuePublisher } from '@wadeck-app/queue-sdk';")).toEqual(
			[]
		);
		expect(violationsIn('task-service', "import { x } from '@wadeck-app/shared-cli';")).toHaveLength(1);
		expect(violationsIn('task-service', "import { x } from '@wadeck-app/app-core-sdk';")).toHaveLength(1);
	});

	// The shared project registry: task-service owns the reading (resolution, listing, error description); the adapters and the
	// storage go through it. Tests of the adapters may build a registry fixture with the SDK's own mutations.
	it('task-service may import the project SDK; the adapters and task-core must not in their sources, their tests may', () => {
		const sdk = "import { loadRegistry } from '@wadeck-app/project-sdk';";
		expect(violationsIn('task-service', sdk)).toEqual([]);
		for (const pkg of ['task-cli', 'app-module-task', 'task-core'] as const) {
			expect(violationsIn(pkg, sdk), pkg).toHaveLength(1);
			expect(violationsIn(pkg, sdk, { isTest: true, resolveRelative: noRelative }), `${pkg} test`).toEqual([]);
		}
		expect(violationsIn('task-cli', '// see @wadeck-app/project-sdk in task-service')).toEqual([]);
	});

	// The shared registry belongs to the project CLI. Task reads it (resolution, listing) and never writes it.
	it.each(['task-core', 'task-service', 'task-cli', 'app-module-task', 'dsl-lib-task'] as const)(
		'%s must not write the shared registry',
		pkg => {
			for (const mutation of [
				'addProject',
				'removeProject',
				'renameProject',
				'addAlias',
				'removeAlias',
				'setParent',
				'setGit',
				'addPath',
				'removePath',
				'movePath',
				'setMain',
				'withRegistryLock',
			]) {
				const source = `import { ${mutation} } from '@wadeck-app/project-sdk';`;
				expect(violationsIn(pkg, source), `${pkg} imports ${mutation}`).not.toEqual([]);
				// Tests build their registry fixtures with the SDK's own mutations.
				expect(violationsIn(pkg, source, { isTest: true, resolveRelative: noRelative }), `${pkg} test`).toEqual(
					[]
				);
			}
		}
	);

	it('reading the registry is allowed in task-service, a multi-line import of a read function passes', () => {
		const read = `import {
	loadRegistry,
	resolveScope,
	writeFileAtomic,
	projectToolDir,
} from '@wadeck-app/project-sdk';`;
		expect(violationsIn('task-service', read)).toEqual([]);
		const write = `import {
	loadRegistry,
	addPath,
} from '@wadeck-app/project-sdk';`;
		expect(violationsIn('task-service', write)).not.toEqual([]);
	});

	describe('no `.task` project data path construction in any non-test source', () => {
		const construction = [
			"path.join(dir, '.task', 'tasks')",
			'path.join(dir, ".task")',
			"path.join(projectDir, '.task/config.yml')",
			'`${dir}/.task`',
			"dir + '/.task'",
			"fs.existsSync(path.join(dir, '.task'))",
		];

		it.each(PACKAGES)('%s: any construction is reported', pkg => {
			for (const source of construction) {
				expect(violationsIn(pkg, `const p = ${source};`), `${pkg}: ${source}`).not.toEqual([]);
			}
		});

		it('tests, comments and prose are not reported', () => {
			for (const pkg of PACKAGES) {
				expect(
					violationsIn(pkg, `const p = ${construction[0]!};`, { isTest: true, resolveRelative: noRelative }),
					pkg
				).toEqual([]);
				expect(violationsIn(pkg, '// the data used to live in <dir>/.task'), pkg).toEqual([]);
				expect(violationsIn(pkg, "const m = 'tasks kept in the .task folder';"), pkg).toEqual([]);
			}
		});

		it('the global config dir default (~/.task) is not project data', () => {
			expect(violationsIn('task-core', "const raw = path.join(os.homedir(), '.task');")).toEqual([]);
			// Documentation text of the same directory.
			expect(violationsIn('task-cli', "const help = 'Global config directory (default: ~/.task)';")).toEqual([]);
		});

		it('no file is exempt: the global config dir default (homedir) is the only allowed spelling', () => {
			const source = "const dir = path.join(projectDir, '.task');";
			for (const file of [
				'packages/task-service/src/anyFile.ts',
				'packages/task-service/src/storage.ts',
				'packages/task-service/src/openContext.ts',
				'packages/task-cli/src/commands/AnyCommand.ts',
			]) {
				expect(
					checkSource(file, source, PACKAGE_RULES[file.includes('task-cli') ? 'task-cli' : 'task-service'], {
						isTest: false,
						resolveRelative: noRelative,
					}),
					file
				).toHaveLength(1);
			}
		});
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
