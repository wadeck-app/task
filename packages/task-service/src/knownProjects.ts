// The projects the cross-project views show: the projects of the shared registry that have a folder.
import * as path from 'node:path';

import { ProjectError, defaultRegistryDir, loadRegistry, mainPath } from '@wadeck-app/project-sdk';

import { registryStorage } from './storage.js';
import type { TaskStorage } from './storage.js';

/** One project a cross-project view shows. */
export interface KnownProject {
	/** Id in the shared project registry. */
	id: string;
	/** Registry name. */
	name: string;
	/** The main path of the project. */
	path: string;
	/** Where its data and config are: the shared registry. */
	storage: TaskStorage;
	/** Why the project cannot be opened whatever its data (a broken parent chain in the registry); absent when nothing is wrong. */
	problem?: string;
}

export interface KnownProjects {
	/** Registry order. */
	projects: KnownProject[];
	/** Why the shared registry could not be read (no project is then listed); null when it was read or does not exist yet. */
	registryProblem: string | null;
}

export interface ListKnownProjectsOptions {
	/** Default `process.env`: only XDG_CONFIG_HOME is read, at call time, to locate the shared registry. */
	env?: NodeJS.ProcessEnv;
}

/**
 * Every registered project that has a folder (the shared registry, read at every call, never cached). Any registered project can
 * hold tasks (its data is in the registry), so none is filtered out for lack of a `.task`; a project whose main path still holds
 * unmigrated data is listed unreadable (see `assertDataMigrated`), and so is a real split. A virtual project
 * (no folder) is NOT listed: the cross-project views and the app-module address projects by folder (use the CLI with `-p` for it).
 * A shared registry that cannot be read is reported in `registryProblem` (nothing else lists projects).
 */
export function listKnownProjects(options: ListKnownProjectsOptions = {}): KnownProjects {
	const projects: KnownProject[] = [];
	let registryProblem: string | null = null;
	try {
		const registryDir = defaultRegistryDir(options.env ?? process.env);
		const registry = loadRegistry(registryDir);
		for (const project of registry.projects) {
			const main = mainPath(project);
			if (main === undefined) continue;
			const dir = path.resolve(main);
			try {
				projects.push({
					id: project.id,
					name: project.name,
					path: dir,
					storage: registryStorage(registry, registryDir, project),
				});
			} catch (error) {
				if (!(error instanceof ProjectError)) throw error;
				// A broken parent chain: the project is listed with the reason, on the storage of the project alone.
				projects.push({
					id: project.id,
					name: project.name,
					path: dir,
					storage: registryStorage(registry, registryDir, { ...project, parent: undefined }),
					problem: error.message,
				});
			}
		}
	} catch (error) {
		if (!(error instanceof ProjectError)) throw error;
		registryProblem = error.message;
	}
	return { projects, registryProblem };
}
