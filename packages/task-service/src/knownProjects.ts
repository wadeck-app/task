// The projects the cross-project views show: the shared registry first, the legacy projects.json second (stage 1).
import * as path from 'node:path';

import { ProjectError, defaultRegistryDir, loadRegistry, mainPath } from '@wadeck-app/project-sdk';
import { TaskConfigLoader } from '@wadeck-app/task-core';

import { isSameProjectDir, listRegisteredProjects } from './projectsRegistry.js';

/** One project a cross-project view shows. */
export interface KnownProject {
	/** Id in the shared project registry; absent for a project known only by the legacy projects.json. */
	id?: string;
	/** Registry name when registered, else the directory name. */
	name: string;
	/** The directory whose `.task` holds the data (the main path for a registered project). */
	path: string;
	/** In the shared project registry. Unregistered projects work through the legacy registry, which stage 2 removes. */
	registered: boolean;
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
 * The registered projects (the shared registry, read at every call, never cached) followed by the entries of the legacy
 * `<configDir>/projects.json` that are not the main path of a registered project. A registered project is a task project when
 * its main path holds a `.task`, or when the legacy registry lists it (a vanished `.task` must stay visible); a virtual project
 * has no folder and no task data in this version. A shared registry that cannot be read is reported in `registryProblem`
 * and does not hide the legacy projects. A corrupt projects.json throws, as before.
 */
export function listKnownProjects(configDir: string, options: ListKnownProjectsOptions = {}): KnownProjects {
	const legacy = listRegisteredProjects(configDir);
	const projects: KnownProject[] = [];
	let registryProblem: string | null = null;
	try {
		const registry = loadRegistry(defaultRegistryDir(options.env ?? process.env));
		for (const project of registry.projects) {
			const main = mainPath(project);
			if (main === undefined) continue;
			const dir = path.resolve(main);
			if (TaskConfigLoader.isInitialized(dir) || legacy.some(entry => isSameProjectDir(entry, dir))) {
				projects.push({ id: project.id, name: project.name, path: dir, registered: true });
			}
		}
	} catch (error) {
		if (!(error instanceof ProjectError)) throw error;
		registryProblem = error.message;
	}
	for (const entry of legacy) {
		if (projects.some(known => known.registered && isSameProjectDir(known.path, entry))) continue;
		projects.push({ name: path.basename(entry), path: entry, registered: false });
	}
	return { projects, registryProblem };
}
