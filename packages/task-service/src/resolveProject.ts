import * as fs from 'node:fs';
import * as path from 'node:path';

import {
	NoProjectInScopeError,
	ProjectError,
	defaultRegistryDir,
	describeResolution,
	loadRegistry,
	mainPath,
	requirePath,
	resolveScope,
} from '@wadeck-app/project-sdk';
import type { Registry, Scope } from '@wadeck-app/project-sdk';
import { TaskConfigLoader } from '@wadeck-app/task-core';

import { ConflictingProjectSelectionError, ProjectNotInitializedError } from './errors.js';
import { isSameProjectDir } from './projectsRegistry.js';

/**
 * How the project was found: `flag` (`-p`), `env` (`TASK_PROJECT`) or `cwd` (the registered folder that contains the cwd
 * or the directory given by `--project-dir` / `TASK_PROJECT_DIR` / `PROJECT_DIR`), all three through the shared registry;
 * `legacy` is the pre-registry rule (a directory holding a `.task`), kept in stage 1 and removed in stage 2.
 */
export type ProjectSource = 'flag' | 'env' | 'cwd' | 'legacy';

export interface ResolveProjectInput {
	cwd: string;
	/** `-p` / `--project`: name, alias or id of a registered project (never a path). */
	projectRef?: string;
	/** `--project-dir` (legacy): a directory, looked up in the registry like a cwd. */
	projectDir?: string;
	/** Default `process.env`. Read: TASK_PROJECT, TASK_PROJECT_DIR, PROJECT_DIR, and XDG_CONFIG_HOME for the registry location. */
	env?: NodeJS.ProcessEnv;
}

export interface ResolvedProject {
	/** Registry id (8 hex); absent for the legacy path. */
	id?: string;
	/** Registry name, or the directory name for the legacy path. */
	name: string;
	/** The directory whose `.task` holds the data: the main path of a registered project. */
	path: string;
	source: ProjectSource;
	/** What supplied the selection: `--project`, `TASK_PROJECT`, `--project-dir`, `TASK_PROJECT_DIR`, `PROJECT_DIR` or `cwd`. */
	via: string;
	registryDir: string;
	/** One line stating how the project was resolved (for the task log). */
	logLine: string;
	/** Set on the legacy path: the deprecation line the caller prints once on stderr. */
	legacyWarning?: string;
}

function nonBlank(value: string | undefined): string | undefined {
	return value !== undefined && value.trim() !== '' ? value : undefined;
}

/** Two paths designate one folder: same text (case-insensitive on Windows) or same real folder (links, junctions, 8.3 names). */
function sameFolder(a: string, b: string): boolean {
	if (isSameProjectDir(a, b)) return true;
	try {
		const [left, right] = [fs.realpathSync.native(a), fs.realpathSync.native(b)];
		return isSameProjectDir(left, right);
	} catch {
		return false;
	}
}

/** Where the data of a registry-resolved project lives (its main path); a project without path cannot be used. */
function registered(scope: Scope, via: string, registryDir: string): ResolvedProject {
	// A virtual project has no folder to read from: VirtualProjectError naming it.
	requirePath(scope);
	const dataDir = path.resolve(mainPath(scope.project)!);
	if (!TaskConfigLoader.isInitialized(dataDir)) {
		throw new ProjectNotInitializedError(
			`project ${scope.project.name} (${scope.project.id}) has no .task in its main path ${dataDir}`,
			`In this version its tasks are stored in <main path>/.task: run \`task init\` in ${dataDir} (or copy the .task there).`
		);
	}
	const resolution = describeResolution({ ...scope, via }, { registryDir });
	return {
		id: scope.project.id,
		name: scope.project.name,
		path: dataDir,
		source: scope.source,
		via,
		registryDir,
		logLine: `${resolution}; data ${path.join(dataDir, '.task')}`,
	};
}

function legacy(dir: string, via: string, registryDir: string, reason: string): ResolvedProject {
	return {
		name: path.basename(dir),
		path: dir,
		source: 'legacy',
		via,
		registryDir,
		logLine: `project: ${path.basename(dir)} via legacy (${via}), path ${dir}, not in the shared registry (${reason}); registry: ${registryDir}`,
		legacyWarning:
			`Deprecated: ${dir} is not in the shared project registry (${reason}). ` +
			`Its ${path.join(dir, '.task')} is still used as before, but this fallback will be removed. Register it with: project add "${dir}"`,
	};
}

/**
 * Which project a command works on, and where its data is. `-p` > `TASK_PROJECT` > the directory (`--project-dir` >
 * `TASK_PROJECT_DIR` > `PROJECT_DIR` > cwd) looked up in the shared registry; a reference that does not resolve is an
 * error, never a fallback. Only when the directory is not in the registry (or the registry cannot be read) and it holds a
 * `.task`, the legacy rule applies and `legacyWarning` is set. Reads the registry, never writes it.
 * Throws the SDK's typed errors (`ProjectNotFoundError`, `AmbiguousReferenceError`, `VirtualProjectError`, registry errors),
 * {@link ConflictingProjectSelectionError} and {@link ProjectNotInitializedError}.
 */
export function resolveProject(input: ResolveProjectInput): ResolvedProject {
	const env = input.env ?? process.env;
	const registryDir = defaultRegistryDir(env);
	const cwd = path.resolve(input.cwd);
	if (input.projectRef !== undefined && input.projectDir !== undefined) {
		throw new ConflictingProjectSelectionError(
			'--project and --project-dir both select the project',
			'Pass one: --project <name|alias|id> (the shared registry), or --project-dir <dir> (deprecated).'
		);
	}

	if (
		input.projectRef !== undefined ||
		(input.projectDir === undefined && nonBlank(env['TASK_PROJECT']) !== undefined)
	) {
		const scope = resolveScope(loadRegistry(registryDir), {
			...(input.projectRef === undefined ? {} : { flag: input.projectRef }),
			env: env['TASK_PROJECT'],
			envName: 'TASK_PROJECT',
			cwd,
		});
		return registered(scope, scope.via, registryDir);
	}

	const [raw, via] =
		input.projectDir !== undefined
			? [input.projectDir, '--project-dir']
			: env['TASK_PROJECT_DIR'] !== undefined
				? [env['TASK_PROJECT_DIR'], 'TASK_PROJECT_DIR']
				: env['PROJECT_DIR'] !== undefined
					? [env['PROJECT_DIR'], 'PROJECT_DIR']
					: [undefined, 'cwd'];
	// An empty value counts as unset, as before.
	const dir = raw ? path.resolve(cwd, raw) : cwd;
	const viaName = raw ? via : 'cwd';

	let registry: Registry | undefined;
	let problem: ProjectError | undefined;
	try {
		registry = loadRegistry(registryDir);
	} catch (error) {
		if (!(error instanceof ProjectError)) throw error;
		problem = error;
	}

	let noScope: NoProjectInScopeError | undefined;
	if (registry !== undefined) {
		try {
			const scope = resolveScope(registry, { cwd: dir });
			// The folder only lies INSIDE a registered one and holds a .task of its own: that data was used until now, never switch silently.
			if (scope.path !== undefined && !sameFolder(scope.path, dir) && TaskConfigLoader.isInitialized(dir)) {
				return legacy(
					dir,
					viaName,
					registryDir,
					`it lies inside project ${scope.project.name} (${scope.project.id}) but holds a .task of its own`
				);
			}
			return registered(scope, viaName, registryDir);
		} catch (error) {
			if (!(error instanceof NoProjectInScopeError)) throw error;
			noScope = error;
		}
	}

	if (TaskConfigLoader.isInitialized(dir)) {
		return legacy(
			dir,
			viaName,
			registryDir,
			problem === undefined
				? 'no registered project contains it'
				: `the registry could not be read: ${problem.message}`
		);
	}
	if (problem !== undefined) throw problem;
	throw new ProjectNotInitializedError(
		`project not initialized: no .task in ${dir}, and ${noScope!.message}`,
		`Run: task init\n${noScope!.hint}`,
		noScope
	);
}

/**
 * Resolves a reference (name, alias, id or unique id prefix) through the shared registry for a caller that has no cwd and no
 * flags (the app-module: `?project=`). Same rules and errors as `-p`; TASK_PROJECT and the legacy variables are not read.
 */
export function resolveProjectReference(ref: string, env: NodeJS.ProcessEnv = process.env): ResolvedProject {
	return resolveProject({ cwd: process.cwd(), projectRef: ref, env: { ...env, TASK_PROJECT: undefined } });
}
