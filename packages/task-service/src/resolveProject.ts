import * as path from 'node:path';

import {
	NoProjectInScopeError,
	defaultRegistryDir,
	describeResolution,
	extractProjectOption,
	loadRegistry,
	mainPath,
	resolveProjectFromArgs as sdkResolveProjectFromArgs,
} from '@wadeck-app/project-sdk';
import type { ProjectOption, Registry, Scope } from '@wadeck-app/project-sdk';

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
	/** Where the data and the config are: the shared registry. */
	storage: TaskStorage;
	source: ProjectSource;
	/** What supplied the selection: `--project`, `TASK_PROJECT` or `cwd`. */
	via: string;
	registryDir: string;
	/** One line stating how the project was resolved (for the task log). */
	logLine: string;
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
 * Takes `-p <ref>`, `--project <ref>` and `--project=<ref>` out of `argv` (wherever they are, nothing after `--`) and reads
 * TASK_PROJECT (blank = unset): the SDK's rules, shared by every CLI of the registry. The caller decides what to do with the
 * pieces (e.g. refuse them for a command that spans all projects). Throws `ProjectOptionError` for a flag without value
 * and for a repeated flag; described by `describeError`.
 */
export function readProjectOption(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): ProjectOption {
	return extractProjectOption(argv, env, 'TASK_PROJECT');
}

export interface ResolveProjectFromArgsInput {
	cwd: string;
	/** The command line (it may hold the project flag anywhere before `--`). */
	argv: readonly string[];
	/** Default `process.env`. Read: TASK_PROJECT, and XDG_CONFIG_HOME for the registry location. */
	env?: NodeJS.ProcessEnv;
}

/**
 * Which project a command works on, and where its data is: the flag in `argv` > `TASK_PROJECT` > the cwd looked up in the shared
 * registry (deepest registered ancestor wins), through the SDK's `resolveProjectFromArgs`. A reference that does not resolve is an
 * error, never a fallback, and so is a folder the registry does not contain. Reads the registry, never writes it.
 * Returns the project and the arguments without the project flag.
 * Throws the SDK's typed errors (`ProjectOptionError`, `ProjectNotFoundError`, `AmbiguousReferenceError`, `NoProjectInScopeError`,
 * `VirtualProjectError`, registry errors).
 */
export function resolveProjectFromArgs(input: ResolveProjectFromArgsInput): {
	project: ResolvedProject;
	args: string[];
} {
	const env = input.env ?? process.env;
	const registryDir = defaultRegistryDir(env);
	const cwd = path.resolve(input.cwd);
	const registry = loadRegistry(registryDir);
	try {
		const { scope, args } = sdkResolveProjectFromArgs(registry, input.argv, env, 'TASK_PROJECT', cwd);
		return { project: registered(scope, scope.via, registryDir, registry), args };
	} catch (error) {
		if (error instanceof NoProjectInScopeError) throw withNativeFolder(error, cwd);
		throw error;
	}
}

/** Same as `resolveProjectFromArgs` for a caller that already holds the reference (`projectRef` = the `-p` value; TASK_PROJECT still applies below it). */
export function resolveProject(input: ResolveProjectInput): ResolvedProject {
	// "--project=<ref>" takes any value (one starting with "-" included).
	const argv = input.projectRef === undefined ? [] : [`--project=${input.projectRef}`];
	return resolveProjectFromArgs({ cwd: input.cwd, argv, ...(input.env === undefined ? {} : { env: input.env }) })
		.project;
}

/**
 * Resolves a reference (name, alias, id or unique id prefix) through the shared registry for a caller that has no cwd and no
 * flags (the app-module: `?project=`). Same rules and errors as `-p`; TASK_PROJECT is not read.
 */
export function resolveProjectReference(ref: string, env: NodeJS.ProcessEnv = process.env): ResolvedProject {
	return resolveProject({ cwd: process.cwd(), projectRef: ref, env: { ...env, TASK_PROJECT: undefined } });
}
