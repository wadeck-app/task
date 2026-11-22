// The projects the cross-project views show: the projects of the shared registry that have a folder.
import * as path from 'node:path';

import {
	ProjectError,
	compareProjectsByImportance,
	defaultRegistryDir,
	loadRegistry,
	mainPath,
	priorityOf,
} from '@wadeck-app/project-sdk';

import { registryStorage } from './storage.js';
import type { TaskStorage } from './storage.js';

/** The importance level of a project in the registry (`normal` = no level set). */
export type ProjectPriorityLevel = 'high' | 'normal' | 'low';

/** What the importance order reads of a project; `favorite` and `priority` absent mean not favorite and normal (an older answer). */
export interface Rankable {
	id: string;
	name: string;
	favorite?: boolean;
	priority?: ProjectPriorityLevel;
}

/**
 * THE order of every list of projects: the SDK's `compareProjectsByImportance` (favorites, then high/normal/low, then name without case,
 * then id). For the adapters, which never import the SDK, and for lists that mix several sources of projects.
 */
export function compareByImportance(a: Rankable, b: Rankable): number {
	const asProject = (p: Rankable): Parameters<typeof compareProjectsByImportance>[0] => ({
		id: p.id,
		name: p.name,
		...(p.favorite === true ? { favorite: true } : {}),
		...(p.priority === undefined || p.priority === 'normal' ? {} : { priority: p.priority }),
	});
	return compareProjectsByImportance(asProject(a), asProject(b));
}

/** One project a cross-project view shows. */
export interface KnownProject {
	/** Id in the shared project registry. */
	id: string;
	/** Registry name. */
	name: string;
	/** Marked favorite in the registry (set in the project module or with `project favorite`; task only reads it). */
	favorite: boolean;
	/** Priority in the registry; `normal` when none is set. */
	priority: ProjectPriorityLevel;
	/** The main path of the project. */
	path: string;
	/** Where its data and config are: the shared registry. */
	storage: TaskStorage;
	/** Why the project cannot be opened whatever its data (a broken parent chain in the registry); absent when nothing is wrong. */
	problem?: string;
}

export interface KnownProjects {
	/** Importance order (the SDK's `compareProjectsByImportance`: favorites, then high/normal/low, then name, then id). */
	projects: KnownProject[];
	/** Why the shared registry could not be read (no project is then listed); null when it was read or does not exist yet. */
	registryProblem: string | null;
}

export interface ListKnownProjectsOptions {
	/** Default `process.env`: only XDG_CONFIG_HOME is read, at call time, to locate the shared registry. */
	env?: NodeJS.ProcessEnv;
}

/**
 * Every registered project that has a folder (the shared registry, read at every call, never cached), in importance order. Any registered project can
 * hold tasks (its data is in the registry), so none is filtered out. A virtual project
 * (no folder) is NOT listed: the cross-project views and the app-module address projects by folder (use the CLI with `-p` for it).
 * A shared registry that cannot be read is reported in `registryProblem` (nothing else lists projects).
 */
export function listKnownProjects(options: ListKnownProjectsOptions = {}): KnownProjects {
	const projects: KnownProject[] = [];
	// The importance order is applied to the registry projects, so it stays the SDK's single order.
	let registryProblem: string | null = null;
	try {
		const registryDir = defaultRegistryDir(options.env ?? process.env);
		const registry = loadRegistry(registryDir);
		for (const project of [...registry.projects].sort(compareProjectsByImportance)) {
			const importance = { favorite: project.favorite === true, priority: priorityOf(project) };
			const main = mainPath(project);
			if (main === undefined) continue;
			const dir = path.resolve(main);
			try {
				projects.push({
					id: project.id,
					name: project.name,
						...importance,
					path: dir,
					storage: registryStorage(registry, registryDir, project),
				});
			} catch (error) {
				if (!(error instanceof ProjectError)) throw error;
				// A broken parent chain: the project is listed with the reason, on the storage of the project alone.
				projects.push({
					id: project.id,
					name: project.name,
						...importance,
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
