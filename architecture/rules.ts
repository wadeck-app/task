// Dependency-direction rules of the task packages, checked by architecture.test.ts.
//
//   task-core  <-  task-service  <-  task-cli
//                              \<-  app-module-task  ->  dsl-lib-task (browser components, loaded by src/dsl-components)
//
// The two adapters (task-cli, app-module-task) never know each other; task-service is caller-agnostic. dsl-lib-task is
// browser code (React, DOM): it knows no storage, no service, no backend and no Node API; data reaches it through props.

export type PackageName = 'task-core' | 'task-service' | 'task-cli' | 'app-module-task' | 'dsl-lib-task';

export interface Violation {
	file: string;
	rule: string;
	detail: string;
}

interface PackageRule {
	/** Import specifiers this package must never use (matched against the module specifier). */
	forbiddenImports: { pattern: RegExp; why: string }[];
	/**
	 * When set, a non-test source may import ONLY a relative path or a specifier matching one of these (tests may
	 * import anything not forbidden above: Testing Library, vitest, node:).
	 */
	allowedImports?: { patterns: RegExp[]; why: string };
	/** Patterns forbidden in the non-test source text of this package. */
	forbiddenSource: { pattern: RegExp; why: string }[];
	/** Names that must never be imported (`import { Name } from ...`), in any file of the package, tests included. */
	forbiddenImportedNames?: { name: string; why: string }[];
	/**
	 * The non-test files that may import the Node file system API (repo-relative path -> why), any other non-test file
	 * importing `fs` is a violation. Tasks are read and written through the backend port, so a use case never
	 * touches a file; what is listed is logs, configuration, the updater and the test harnesses.
	 */
	fsAllowlist?: { files: Record<string, string>; why: string };
}

/** Specifier of a workspace package: its npm name, or the path of its folder (a relative import resolved from the repository root). */
function workspacePackage(folder: string, npmName: string): RegExp {
	// Package names hold only letters, digits, '-', '@' and '/': nothing to escape in a RegExp.
	return new RegExp(`^(${npmName}|@wadeck-app/${folder})(/|$)|(^|/)packages/${folder}(/|$)`);
}

const TASK_CLI = workspacePackage('task-cli', 'task-cli');
const APP_MODULE = workspacePackage('app-module-task', '@wadeck-app/app-module-task');
const TASK_SERVICE = workspacePackage('task-service', '@wadeck-app/task-service');
const TASK_CORE = workspacePackage('task-core', '@wadeck-app/task-core');
const DSL_LIB = workspacePackage('dsl-lib-task', '@wadeck-app/dsl-lib-task');
/**
 * What a browser component bundle may import besides its own files: React, the dsl packages the shell shares as
 * singletons (dsl-ui, dsl-renderer) and the icon set. Anything else is a decision, so it is added here on purpose.
 */
const BROWSER_LIB_IMPORT =
	/^(react|react-dom|@wadeck-app\/dsl-ui|@wadeck-app\/dsl-renderer|lucide-react)(\/[\w./-]+)?$/;
const SHARED_CLI = /^@wadeck-app\/shared-(cli|updater)(\/|$)/;
const APP_CORE = /^@wadeck-app\/app-core-(sdk|cli)(\/|$)/;
const HTTP_AND_CLI_LIBS = /^(fastify|express|koa|commander|yargs|inquirer|chalk)(\/|$)/;

/** Output and process control belong to the adapters: a use case returns data, it does not print or exit. */
const NO_CONSOLE_NO_EXIT = [
	{ pattern: /\bprocess\.exit\s*\(/, why: 'process.exit belongs to the CLI entry point' },
	{ pattern: /\bconsole\.\w+\s*\(/, why: 'console output belongs to the adapters' },
	{ pattern: /\bprocess\.argv\b/, why: 'argv parsing belongs to the CLI' },
];

/**
 * The shared project registry (@wadeck-app/project-sdk) is read through task-service only: one resolution rule
 * (`resolveProject`, `listKnownProjects`), one description of its typed errors (`describeError`), the same for both adapters.
 * Tests may use the SDK's mutations to build a registry fixture, so this is a source rule (non-test files), not an import rule.
 */
const NO_PROJECT_SDK_OUTSIDE_SERVICE = {
	pattern: /@wadeck-app\/project-sdk/,
	why: 'the shared project registry is read through task-service (resolveProject, listKnownProjects, describeError), not directly',
};

/**
 * Task keeps its project data and config in the shared project registry, never in the project folder: no source names `.task` as a
 * path segment (`'.task'`, `"/.task"`, `` `${dir}/.task` ``). The only spelling allowed is the global config dir default,
 * the home directory joined with `.task` (and the prose `~/.task`). Source rule: tests and comments are out of scope.
 */
const NO_PROJECT_DATA_DIR = {
	pattern: /(?<!\bhomedir\(\)\s*,\s*)(?:['"`]\.task(?:['"`/\\])|(?<!~)[/\\]\.task\b)/,
	why: 'project data and config live in the shared project registry: no source builds a `.task` path (only the global config dir default, the home directory joined with ".task")',
};

/**
 * Task never writes the project registry: it belongs to the project CLI. Source rule (non-test files; tests build registry
 * fixtures with the SDK's own mutations): no import of an SDK mutation.
 */
const NO_REGISTRY_WRITE = [
	{
		pattern:
			/import\s*(?:type\s*)?\{[^}]*\b(?:addProject|removeProject|renameProject|addAlias|removeAlias|setParent|setGit|addPath|removePath|movePath|setMain|withRegistryLock)\b[^}]*\}\s*from\s*['"]@wadeck-app\/project-sdk['"]/,
		why: 'task reads the shared project registry, it never writes it (project add / paths / remove belong to the project CLI)',
	},
];

/**
 * The synchronous TaskStore is the local backend's rules engine and stays inside task-core (step 0.6 of the storage design,
 * .claude/plans/2026-11-08_storage-strategies.md): every other package asks the backend (`createLocalBackend`,
 * `LocalFileBackend`, the `TaskBackend` port) and never names the store, tests included.
 */
const NO_TASK_STORE_OUTSIDE_CORE = [
	{
		name: 'TaskStore',
		why: 'tasks are reached through the async TaskBackend port (createLocalBackend for the local one); the synchronous TaskStore is internal to task-core',
	},
];

const FS_WHY =
	'tasks are read and written through the TaskBackend port; a file that needs the Node file system API is listed here on purpose, with its reason';

export const PACKAGE_RULES: Record<PackageName, PackageRule> = {
	'task-core': {
		forbiddenImports: [
			{ pattern: TASK_SERVICE, why: 'storage must not depend on the use-case layer above it' },
			{ pattern: TASK_CLI, why: 'storage must not depend on an adapter' },
			{ pattern: APP_MODULE, why: 'storage must not depend on an adapter' },
			{ pattern: DSL_LIB, why: 'storage must not depend on browser components' },
		],
		forbiddenSource: [
			...NO_CONSOLE_NO_EXIT,
			NO_PROJECT_SDK_OUTSIDE_SERVICE,
			...NO_REGISTRY_WRITE,
			NO_PROJECT_DATA_DIR,
		],
		fsAllowlist: {
			why: FS_WHY,
			files: {
				'packages/task-core/src/TaskStore.ts': 'the local backend: task files and the index',
				'packages/task-core/src/TaskConfigLoader.ts': 'the global config file',
			},
		},
	},
	'task-service': {
		forbiddenImports: [
			{ pattern: TASK_CLI, why: 'the service is caller-agnostic: it must not know the CLI' },
			{ pattern: APP_MODULE, why: 'the service is caller-agnostic: it must not know the app-module' },
			{ pattern: SHARED_CLI, why: 'CLI libraries belong to task-cli' },
			{ pattern: APP_CORE, why: 'app-core belongs to app-module-task and the registration in task-cli' },
			{ pattern: HTTP_AND_CLI_LIBS, why: 'HTTP and CLI frameworks belong to the adapters' },
			{ pattern: DSL_LIB, why: 'the service is caller-agnostic: it must not know browser components' },
		],
		forbiddenSource: [...NO_CONSOLE_NO_EXIT, ...NO_REGISTRY_WRITE, NO_PROJECT_DATA_DIR],
		forbiddenImportedNames: NO_TASK_STORE_OUTSIDE_CORE,
		fsAllowlist: {
			why: FS_WHY,
			files: {
				'packages/task-service/src/projectsHealth.ts': 'existence of the registered folders',
				'packages/task-service/src/queueEventSink.ts': 'the queue publisher configuration files',
				'packages/task-service/src/taskLog.ts': 'the task log files',
			},
		},
	},
	'task-cli': {
		forbiddenImports: [
			{ pattern: APP_MODULE, why: 'the adapters must not know each other: share through task-service' },
			{ pattern: DSL_LIB, why: 'the CLI has no browser components' },
		],
		forbiddenSource: [NO_PROJECT_SDK_OUTSIDE_SERVICE, ...NO_REGISTRY_WRITE, NO_PROJECT_DATA_DIR],
		forbiddenImportedNames: NO_TASK_STORE_OUTSIDE_CORE,
		fsAllowlist: {
			why: FS_WHY,
			files: {
				'packages/task-cli/src/appModuleManifest.ts': 'finds the app-module manifest next to the bundle',
				'packages/task-cli/src/appModuleStaging.ts': 'copies the app-module to the config dir for app-core',
				'packages/task-cli/src/cli/readText.ts': '--description-file / standard input',
				'packages/task-cli/src/commands/TaskCliCommand.ts': 'self-check temp dir, update state and logs',
				'packages/task-cli/src/commands/updateLog.ts': 'the updater log files',
				'packages/task-cli/src/isolatedCliEnv.ts': 'the temp tree of spawned test processes',
				'packages/task-cli/src/QueueEventsDeclaration.ts': 'the queue-events marker file',
				'packages/task-cli/src/registerAfterUpdate.ts': 'the app-module registration after an update',
				'packages/task-cli/src/task-updater-entry.ts': 'the updater process',
			},
		},
	},
	'app-module-task': {
		forbiddenImports: [
			{ pattern: TASK_CLI, why: 'the adapters must not know each other: share through task-service' },
			{ pattern: SHARED_CLI, why: 'CLI libraries belong to task-cli; share through task-service' },
		],
		forbiddenSource: [NO_PROJECT_SDK_OUTSIDE_SERVICE, ...NO_REGISTRY_WRITE, NO_PROJECT_DATA_DIR],
		forbiddenImportedNames: NO_TASK_STORE_OUTSIDE_CORE,
		fsAllowlist: {
			why: FS_WHY,
			files: {
				'packages/app-module-task/src/backend/lastProject.ts': 'the last created-in project file of the module',
				'packages/app-module-task/src/backend/projects.ts': 'existence of the registered folders',
				'packages/app-module-task/src/backend/routeHarness.ts': 'the route test harness',
				'packages/app-module-task/src/backend/serverErrorLog.ts': 'the 5xx log file',
				'packages/app-module-task/src/backend/vitest.setup.ts': 'the test environment',
			},
		},
	},
	'dsl-lib-task': {
		forbiddenImports: [
			{ pattern: TASK_SERVICE, why: 'browser components get their data through props, never from the service' },
			{ pattern: TASK_CORE, why: 'browser components must not read the storage' },
			{ pattern: TASK_CLI, why: 'browser components must not know the CLI' },
			{
				pattern: APP_MODULE,
				why: 'the module loads the components, not the other way round (its backend is Node code)',
			},
			{ pattern: SHARED_CLI, why: 'CLI libraries belong to task-cli' },
			{ pattern: APP_CORE, why: 'app-core belongs to app-module-task and the registration in task-cli' },
			{ pattern: HTTP_AND_CLI_LIBS, why: 'HTTP and CLI frameworks belong to the adapters' },
		],
		allowedImports: {
			patterns: [BROWSER_LIB_IMPORT],
			why: 'a component bundle shares react and the dsl packages with the shell and runs in a browser: no Node builtin (node:*, fs, path...) and no other dependency without a decision recorded in architecture/rules.ts',
		},
		forbiddenSource: [
			NO_PROJECT_SDK_OUTSIDE_SERVICE,
			...NO_REGISTRY_WRITE,
			NO_PROJECT_DATA_DIR,
			{ pattern: /\bprocess\.(?:env|argv|exit|cwd)\b/, why: 'no Node process API in browser code' },
		],
	},
};

const IMPORT_PATTERNS = [
	/\bfrom\s*['"]([^'"]+)['"]/g,
	/\bimport\s*['"]([^'"]+)['"]/g,
	/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
	/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** Every module specifier a TypeScript source imports (static, side-effect, dynamic, require). */
export function importedModules(source: string): string[] {
	const found = new Set<string>();
	for (const pattern of IMPORT_PATTERNS) {
		for (const match of source.matchAll(pattern)) found.add(match[1]!);
	}
	return [...found];
}

/** Every name an `import { A, B as C }` clause brings in from its module (the name as exported: `A`, `B`). */
export function importedNames(source: string): string[] {
	const names: string[] = [];
	for (const match of source.matchAll(/\bimport\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g)) {
		for (const part of match[1]!.split(',')) {
			const name = part
				.trim()
				.replace(/^type\s+/, '')
				.split(/\s+as\s+/)[0]!
				.trim();
			if (name !== '') names.push(name);
		}
	}
	return names;
}

/** True when the source imports the Node file system API (`fs`, `node:fs`, `fs/promises`, `node:fs/promises`). */
export function importsNodeFs(source: string): boolean {
	return importedModules(source).some(specifier => /^(node:)?fs(\/promises)?$/.test(specifier));
}

function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/**
 * Violations of `rule` in one source file. `relativeImportTarget` turns a relative specifier into a path relative to
 * the repository root, so that `../../task-cli/x` is recognised whichever file it is written in.
 */
export function checkSource(
	file: string,
	source: string,
	rule: PackageRule,
	options: { isTest: boolean; resolveRelative: (specifier: string) => string }
): Violation[] {
	const violations: Violation[] = [];
	for (const specifier of importedModules(source)) {
		const target = specifier.startsWith('.') ? options.resolveRelative(specifier) : specifier;
		for (const { pattern, why } of rule.forbiddenImports) {
			if (pattern.test(target)) {
				violations.push({ file, rule: 'forbidden-import', detail: `imports "${specifier}": ${why}` });
			}
		}
	}
	if (!options.isTest && rule.allowedImports) {
		for (const specifier of importedModules(source)) {
			if (specifier.startsWith('.') || rule.allowedImports.patterns.some(pattern => pattern.test(specifier)))
				continue;
			violations.push({
				file,
				rule: 'unlisted-import',
				detail: `imports "${specifier}": ${rule.allowedImports.why}`,
			});
		}
	}
	const code = stripComments(source);
	for (const { name, why } of rule.forbiddenImportedNames ?? []) {
		if (importedNames(code).includes(name)) {
			violations.push({ file, rule: 'forbidden-imported-name', detail: `imports "${name}": ${why}` });
		}
	}
	if (!options.isTest && rule.fsAllowlist && importsNodeFs(source) && !(file in rule.fsAllowlist.files)) {
		violations.push({
			file,
			rule: 'fs-outside-allowlist',
			detail: `imports the Node file system API: ${rule.fsAllowlist.why}. Add the file to fsAllowlist in architecture/rules.ts only for a reason that is not task data`,
		});
	}
	if (!options.isTest) {
		for (const { pattern, why } of rule.forbiddenSource) {
			if (pattern.test(code)) {
				violations.push({ file, rule: 'forbidden-source', detail: `matches ${pattern}: ${why}` });
			}
		}
	}
	return violations;
}

/** Internal workspace dependencies declared in a package.json that the rules forbid. */
export function checkManifest(
	file: string,
	manifest: {
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
		peerDependencies?: Record<string, string>;
	},
	rule: PackageRule
): Violation[] {
	const declared = [
		...Object.keys(manifest.dependencies ?? {}),
		...Object.keys(manifest.devDependencies ?? {}),
		...Object.keys(manifest.peerDependencies ?? {}),
	];
	return declared.flatMap(name =>
		rule.forbiddenImports
			.filter(({ pattern }) => pattern.test(name))
			.map(({ why }) => ({ file, rule: 'forbidden-dependency', detail: `declares "${name}": ${why}` }))
	);
}
