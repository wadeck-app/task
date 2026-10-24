// Dependency-direction rules of the task packages, checked by architecture.test.ts.
//
//   task-core  <-  task-service  <-  task-cli
//                              \<-  app-module-task
//
// The two adapters (task-cli, app-module-task) never know each other; task-service is caller-agnostic.

export type PackageName = 'task-core' | 'task-service' | 'task-cli' | 'app-module-task';

export interface Violation {
	file: string;
	rule: string;
	detail: string;
}

interface PackageRule {
	/** Import specifiers this package must never use (matched against the module specifier). */
	forbiddenImports: { pattern: RegExp; why: string }[];
	/** Patterns forbidden in the non-test source text of this package. */
	forbiddenSource: { pattern: RegExp; why: string; exceptFiles?: RegExp }[];
}

/** Specifier of a workspace package: its npm name, or the path of its folder (a relative import resolved from the repository root). */
function workspacePackage(folder: string, npmName: string): RegExp {
	// Package names hold only letters, digits, '-', '@' and '/': nothing to escape in a RegExp.
	return new RegExp(`^(${npmName}|@wadeck-app/${folder})(/|$)|(^|/)packages/${folder}(/|$)`);
}

const TASK_CLI = workspacePackage('task-cli', 'task-cli');
const APP_MODULE = workspacePackage('app-module-task', '@wadeck-app/app-module-task');
const TASK_SERVICE = workspacePackage('task-service', '@wadeck-app/task-service');
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
 * Stage 2b: the legacy `projects.json` list is not read any more (the shared registry is the only list of projects), so no
 * source names the file. Tests may (they prove it is ignored).
 */
const NO_PROJECTS_JSON = {
	pattern: /projects\.json/,
	why: 'the legacy projects.json is not read any more: the shared project registry (project CLI) is the only list of projects',
};

/**
 * `.task` as a path segment (`'.task'`, `"/.task"`, `` `${dir}/.task` ``) belongs to ONE module, task-service `legacyData.ts`, which is
 * used only by the unmigrated-project read (`chooseDataLocation`) and `migrate-data`. Everything else asks it, so removing that
 * read (stage 2b-2) removes the knowledge of the folder with it. The global config dir default (`path.join(os.homedir(), '.task')`)
 * is not project data. Source rule: tests and comments are out of scope.
 */
const NO_LEGACY_DATA_PATH = {
	pattern: /(?<!\bhomedir\(\)\s*,\s*)(?:['"`]\.task(?:['"`/\\])|(?<!~)[/\\]\.task\b)/,
	why: 'the `.task` folder is known by task-service legacyData.ts only (the unmigrated read and migrate-data); ask it for the path',
	exceptFiles: /(^|\/)packages\/task-service\/src\/legacyData\.ts$/,
};

/**
 * Task never writes the project registry (Decision #20, stage 2a): the shared registry belongs to the project CLI, and its
 * writers (`task init`, `task projects add|remove|move|prune` and their lock) are gone. Source rules (non-test files; tests build registry
 * fixtures with the SDK's own mutations): no import of an SDK mutation, no function of the deleted legacy writers.
 */
const NO_REGISTRY_WRITE = [
	{
		pattern:
			/import\s*(?:type\s*)?\{[^}]*\b(?:addProject|removeProject|renameProject|addAlias|removeAlias|setParent|setGit|addPath|removePath|movePath|setMain|withRegistryLock)\b[^}]*\}\s*from\s*['"]@wadeck-app\/project-sdk['"]/,
		why: 'task reads the shared project registry, it never writes it (project add / paths / remove belong to the project CLI)',
	},
	{
		pattern:
			/\b(?:registerProject|unregisterProject|registerInitializedProject|removeRegisteredProject|relocateProject|pruneMissingProjects|initProject)\b/,
		why: 'the legacy projects.json is read only: its writers (task init, task projects add|remove|move|prune) were removed in stage 2a',
	},
];

export const PACKAGE_RULES: Record<PackageName, PackageRule> = {
	'task-core': {
		forbiddenImports: [
			{ pattern: TASK_SERVICE, why: 'storage must not depend on the use-case layer above it' },
			{ pattern: TASK_CLI, why: 'storage must not depend on an adapter' },
			{ pattern: APP_MODULE, why: 'storage must not depend on an adapter' },
		],
		forbiddenSource: [
			...NO_CONSOLE_NO_EXIT,
			NO_PROJECT_SDK_OUTSIDE_SERVICE,
			...NO_REGISTRY_WRITE,
			NO_PROJECTS_JSON,
			NO_LEGACY_DATA_PATH,
		],
	},
	'task-service': {
		forbiddenImports: [
			{ pattern: TASK_CLI, why: 'the service is caller-agnostic: it must not know the CLI' },
			{ pattern: APP_MODULE, why: 'the service is caller-agnostic: it must not know the app-module' },
			{ pattern: SHARED_CLI, why: 'CLI libraries belong to task-cli' },
			{ pattern: APP_CORE, why: 'app-core belongs to app-module-task and the registration in task-cli' },
			{ pattern: HTTP_AND_CLI_LIBS, why: 'HTTP and CLI frameworks belong to the adapters' },
		],
		forbiddenSource: [...NO_CONSOLE_NO_EXIT, ...NO_REGISTRY_WRITE, NO_PROJECTS_JSON, NO_LEGACY_DATA_PATH],
	},
	'task-cli': {
		forbiddenImports: [
			{ pattern: APP_MODULE, why: 'the adapters must not know each other: share through task-service' },
		],
		forbiddenSource: [NO_PROJECT_SDK_OUTSIDE_SERVICE, ...NO_REGISTRY_WRITE, NO_PROJECTS_JSON, NO_LEGACY_DATA_PATH],
	},
	'app-module-task': {
		forbiddenImports: [
			{ pattern: TASK_CLI, why: 'the adapters must not know each other: share through task-service' },
			{ pattern: SHARED_CLI, why: 'CLI libraries belong to task-cli; share through task-service' },
		],
		forbiddenSource: [NO_PROJECT_SDK_OUTSIDE_SERVICE, ...NO_REGISTRY_WRITE, NO_PROJECTS_JSON, NO_LEGACY_DATA_PATH],
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
	if (!options.isTest) {
		const code = stripComments(source);
		for (const { pattern, why, exceptFiles } of rule.forbiddenSource) {
			if (exceptFiles?.test(file) === true) continue;
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
