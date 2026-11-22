// Reads every registered project with one callback (the forest, the types...): the unreadable ones are reported, never dropped.
import {
	describeProblem,
	inspectKnownProjects,
	isRemoteFailure,
	NoReadableProjectsError,
	type KnownProject,
	type ProjectPriorityLevel,
	type TaskServiceContext,
} from '@wadeck-app/task-service';

import type { SkippedProject } from './allProjectsViews.js';

export interface ProjectRead<T> {
	project: { id: string; name: string; path: string; favorite: boolean; priority: ProjectPriorityLevel };
	value: T;
}

export interface AcrossProjects<T> {
	/** The readable projects in importance order (favorites, priority, name), the order of every all-projects view. */
	entries: ProjectRead<T>[];
	/** The projects that could not be read, with why. */
	unreadable: SkippedProject[];
	/** The same projects with their id and name (the page variants list them by name). */
	unreadableProjects: Array<{
		id: string;
		name: string;
		path: string;
		favorite: boolean;
		priority: ProjectPriorityLevel;
		error: string;
	}>;
	/** Why the shared registry could not be read (then no project is listed); null when it was. */
	registryProblem: string | null;
}

function unreadableOf(known: KnownProject): Omit<AcrossProjects<never>['unreadableProjects'][number], 'error'> {
	return { id: known.id, name: known.name, path: known.path, favorite: known.favorite, priority: known.priority };
}

/**
 * Runs `read` on every readable registered project. Nothing registered is an empty answer; projects registered but
 * none readable throw {@link NoReadableProjectsError} (an empty answer would read as "no tasks"); a corrupt registry throws its error.
 */
export async function readAcrossProjects<T>(
	read: (ctx: TaskServiceContext) => T | Promise<T>
): Promise<AcrossProjects<T>> {
	const { entries: inspected, registryProblem } = inspectKnownProjects();
	const entries: ProjectRead<T>[] = [];
	const unreadable: SkippedProject[] = [];
	const unreadableProjects: AcrossProjects<T>['unreadableProjects'] = [];
	for (const { known, health, context } of inspected) {
		if (context === null) {
			const error = health.error ?? 'unreadable';
			unreadable.push({ path: health.path, error });
			unreadableProjects.push({ ...unreadableOf(known), error });
			continue;
		}
		// One project after the other: the first failure and the order of the entries do not depend on timing.
		try {
			entries.push({
				project: {
					id: known.id,
					name: context.project.name,
					path: known.path,
					favorite: known.favorite,
					priority: known.priority,
				},
				value: await read(context),
			});
		} catch (error) {
			// The system behind a project (a forge) can fail for a reason that is not the others' business: it is listed unreadable
			// with the reason and the fix, like a project with an invalid config. Any other failure stays fatal.
			if (!isRemoteFailure(error)) throw error;
			const message = describeProblem(error);
			unreadable.push({ path: health.path, error: message });
			unreadableProjects.push({ ...unreadableOf(known), error: message });
		} finally {
			// Released as soon as it is read: the strategy of a project may hold a connection or a cache.
			await context.dispose?.();
		}
	}
	if (inspected.length > 0 && entries.length === 0) throw new NoReadableProjectsError(unreadable);
	return { entries, unreadable, unreadableProjects, registryProblem };
}
