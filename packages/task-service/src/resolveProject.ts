import * as path from 'node:path';

import {
	NoProjectInScopeError,
	defaultRegistryDir,
	describeResolution,
	loadRegistry,
	mainPath,
	resolveScope,
} from '@wadeck-app/project-sdk';
import type { Registry, Scope } from '@wadeck-app/project-sdk';

import { registryStorage } from './storage.js';
import type { TaskStorage } from './storage.js';

/**
 * How the project was found: `flag` (`-p`), `env` (`TASK_PROJECT`) or `cwd` (the registered folder that contains the cwd),
 * all three through the shared registry.
 */
export type ProjectSource = 'flag' | 'env' | 'cwd';

export interface ResolveProjectInput {
	cwd: string;
	/** `-p` / `--project`: name, alias or id of a registered project (never a path). */
	projectRef?: string;
	/** Default `process.env`. Read: TASK_PROJECT, and XDG_CONFIG_HOME for the registry location. */
	env?: NodeJS.ProcessEnv;
}

export interface ResolvedProject {
	/** Registry id (8 hex). */
	id: string;
	/** Registry name. */
	name: string;
	/**
	 * The main path of the project (the cwd of its events). Absent for a virtual project (no folder): its data works, its
	 * events cannot be delivered.
	 */
	path?: string;
	/** Where the data and the config are: the shared registry (`chooseDataLocation` may still point an unmigrated project at its `.task`). */
	storage: TaskStorage;
	source: ProjectSource;
	/** What supplied the selection: `--project`, `TASK_PROJECT` or `cwd`. */
	via: string;
	registryDir: string;
	/** One line stating how the project was resolved (for the task log). */
	logLine: string;
}

function nonBlank(value: string | undefined): string | undefined {
	return value !== undefined && value.trim() !== '' ? value : undefined;
}

/** A project found through the registry: its data and config live in the registry, its path (if any) is the main path. */
function registered(scope: Scope, via: string, registryDir: string, registry: Registry): ResolvedProject {
	const main = mainPath(scope.project);
	const storage = registryStorage(registry, registryDir, scope.project);
	const resolution = describeResolution({ ...scope, via }, { registryDir });
	return {
		id: scope.project.id,
		name: scope.project.name,
		...(main === undefined ? {} : { path: path.resolve(main) }),
		storage,
		source: scope.source,
		via,
		registryDir,
		logLine: `${resolution}; data ${storage.dataDir}`,
	};
}

/** The registry's "no project in scope" answer, with the folder written the way the user typed it (native separators), not normalised. */
function withNativeFolder(error: NoProjectInScopeError, dir: string): NoProjectInScopeError {
	const native = (text: string): string => text.split(error.cwd).join(dir);
	return new NoProjectInScopeError(native(error.message), {
		cwd: dir,
		registered: error.registered,
		hint: native(error.hint),
	});
}

/**
 * Which project a command works on, and where its data is. `-p` > `TASK_PROJECT` > the cwd looked up in the shared registry
 * (deepest registered ancestor wins). A reference that does not resolve is an error, never a fallback, and so is a folder
 * the registry does not contain. Reads the registry, never writes it.
 * Throws the SDK's typed errors (`ProjectNotFoundError`, `AmbiguousReferenceError`, `NoProjectInScopeError`, `VirtualProjectError`, registry errors).
 */
export function resolveProject(input: ResolveProjectInput): ResolvedProject {
	const env = input.env ?? process.env;
	const registryDir = defaultRegistryDir(env);
	const cwd = path.resolve(input.cwd);
	const registry = loadRegistry(registryDir);
	try {
		const scope = resolveScope(registry, {
			...(input.projectRef === undefined ? {} : { flag: input.projectRef }),
			env: nonBlank(env['TASK_PROJECT']),
			envName: 'TASK_PROJECT',
			cwd,
		});
		return registered(scope, scope.via, registryDir, registry);
	} catch (error) {
		if (error instanceof NoProjectInScopeError) throw withNativeFolder(error, cwd);
		throw error;
	}
}

/**
 * Resolves a reference (name, alias, id or unique id prefix) through the shared registry for a caller that has no cwd and no
 * flags (the app-module: `?project=`). Same rules and errors as `-p`; TASK_PROJECT is not read.
 */
export function resolveProjectReference(ref: string, env: NodeJS.ProcessEnv = process.env): ResolvedProject {
	return resolveProject({ cwd: process.cwd(), projectRef: ref, env: { ...env, TASK_PROJECT: undefined } });
}
