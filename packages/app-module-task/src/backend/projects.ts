import * as path from 'node:path';

import { TaskConfigLoader } from '@wadeck-app/task-core';
import {
	describeError,
	isSameProjectDir,
	listRegisteredProjects,
	listTasks,
	openTaskContext,
} from '@wadeck-app/task-service';
import type { TaskServiceContext } from '@wadeck-app/task-service';

import { RequestError } from './errors.js';
import { tasksPageHref } from './hrefs.js';

export interface ProjectListing {
	name: string;
	path: string;
	/** False when the directory is registered but has no `.task` directory any more. */
	initialized: boolean;
	/** Tasks in a non-terminal status; null when the project cannot be read (see `error`). */
	openCount: number | null;
	/** Why the project cannot be read (not initialized, corrupt config.yml...); null when it can. */
	error: string | null;
	/** Link to the tasks page of the project; null when the project cannot be read. */
	href: string | null;
}

export function listProjects(configDir: string): ProjectListing[] {
	return listRegisteredProjects(configDir).map(dir => {
		const base = { name: path.basename(dir), path: dir, initialized: TaskConfigLoader.isInitialized(dir) };
		try {
			const openCount = listTasks(openProject(configDir, dir), {}).length;
			return { ...base, openCount, error: null, href: tasksPageHref(dir) };
		} catch (error) {
			// One unreadable project must not hide the others, nor read as "0 open": it is listed with its reason.
			return { ...base, openCount: null, error: describeError(error).message, href: null };
		}
	});
}

/**
 * Resolves the project a request targets and builds the service context over its store.
 * `requested` is the `?project=<absolute dir>` value: it must be registered. Without it, the only registered
 * project is used; several registered projects make the choice ambiguous (400 listing them).
 * A corrupt registry throws the registry error unchanged (never read as "no project").
 */
export function openProject(configDir: string, requested: string | undefined): TaskServiceContext {
	const registered = listRegisteredProjects(configDir);
	const dir = pickProject(registered, requested);
	if (!TaskConfigLoader.isInitialized(dir)) {
		throw new RequestError(
			404,
			`project "${path.basename(dir)}" is registered but not initialized (no .task directory)`,
			`Run \`task init\` in ${dir} to recreate it.`
		);
	}
	return openTaskContext({ projectDir: dir });
}

/** The registered project directories; 404 with the fix when there is none. */
export function requireRegisteredProjects(configDir: string): string[] {
	const registered = listRegisteredProjects(configDir);
	requireAny(registered);
	return registered;
}

function requireAny(registered: string[]): void {
	if (registered.length === 0) {
		throw new RequestError(
			404,
			'no project is registered with the task app-module',
			'Run `task init` in a project directory to register it.'
		);
	}
}

function pickProject(registered: string[], requested: string | undefined): string {
	if (requested !== undefined) {
		if (!path.isAbsolute(requested)) {
			throw new RequestError(
				400,
				`project must be an absolute directory, got "${requested}"`,
				'Pass ?project=<absolute project directory>; GET /api/modules/task/projects lists the registered ones.'
			);
		}
		const wanted = path.resolve(requested);
		const found = registered.find(dir => isSameProjectDir(dir, wanted));
		if (found === undefined) {
			throw new RequestError(
				404,
				`project "${requested}" is not registered with the task app-module`,
				'Run `task init` in that project directory to register it, or GET /api/modules/task/projects to list the registered ones.'
			);
		}
		return found;
	}
	requireAny(registered);
	if (registered.length > 1) {
		throw new RequestError(
			400,
			'several projects are registered: the project query parameter is required',
			'Add ?project=<absolute project directory> (one of "registeredProjects").',
			{ registeredProjects: registered }
		);
	}
	return registered[0]!;
}
