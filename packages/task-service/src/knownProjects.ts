// The projects the cross-project views show: the shared registry first, the legacy projects.json second (removed in stage 2b).
import * as path from 'node:path';

import { ProjectError, defaultRegistryDir, loadRegistry, mainPath } from '@wadeck-app/project-sdk';

import { isSameProjectDir, listRegisteredProjects } from './projectsRegistry.js';
import { legacyStorage, registryStorage } from './storage.js';
import type { TaskStorage } from './storage.js';

/** One project a cross-project view shows. */
export interface KnownProject {
	/** Id in the shared project registry; absent for a project known only by the legacy projects.json. */
	id?: string;
	/** Registry name when registered, else the directory name. */
	name: string;
	/** The main path of a registered project, or the legacy directory. */
	path: string;
	/** In the shared project registry. Unregistered projects work through the legacy registry, which stage 2b removes. */
	registered: boolean;
	/** Where its data and config are: the shared registry for a registered project, `<dir>/.task` for the others. */
	storage: TaskStorage;
	/** Why the project cannot be opened whatever its data (a broken parent chain in the registry); absent when nothing is wrong. */
	problem?: string;
}

export interface KnownProjects {
	/** Registered projects first (registry order), then the legacy-only ones (projects.json order). */
	projects: KnownProject[];
	/** Why the shared registry could not be read (the legacy projects are still listed); null when it was read or does not exist yet. */
	registryProblem: string | null;
}

export interface ListKnownProjectsOptions {
	/** Default `process.env`: only XDG_CONFIG_HOME is read, at call time, to locate the shared registry. */
	env?: NodeJS.ProcessEnv;
}

/**
 * Every registered project that has a folder (the shared registry, read at every call, never cached), followed by the entries of
 * the legacy `<configDir>/projects.json` that are not the main path of a registered project. Any registered project can hold
 * tasks (its data is in the registry), so none is filtered out for lack of a `.task`; a project whose main path still holds
 * unmigrated data is listed and read from that `.task` (see `chooseDataLocation`); a real split is listed unreadable. A virtual project (no folder) is
 * NOT listed: the cross-project views and the app-module address projects by folder (use the CLI with `-p` for it).
 * A shared registry that cannot be read is reported in `registryProblem` and does not hide the legacy projects. A corrupt
 * projects.json throws, as before.
 */
export function listKnownProjects(configDir: string, options: ListKnownProjectsOptions = {}): KnownProjects {
	const legacy = listRegisteredProjects(configDir);
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
					registered: true,
					storage: registryStorage(registry, registryDir, project),
				});
			} catch (error) {
				if (!(error instanceof ProjectError)) throw error;
				// A broken parent chain: the project is listed with the reason, on the storage of the project alone.
				projects.push({
					id: project.id,
					name: project.name,
					path: dir,
					registered: true,
					storage: registryStorage(registry, registryDir, { ...project, parent: undefined }),
					problem: error.message,
				});
			}
		}
	} catch (error) {
		if (!(error instanceof ProjectError)) throw error;
		registryProblem = error.message;
	}
	for (const entry of legacy) {
		if (projects.some(known => known.registered && isSameProjectDir(known.path, entry))) continue;
		projects.push({ name: path.basename(entry), path: entry, registered: false, storage: legacyStorage(entry) });
	}
	return { projects, registryProblem };
}
