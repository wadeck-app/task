// Reads every registered project with one callback (the forest, the types...): the unreadable ones are reported, never dropped.
import { inspectKnownProjects, NoReadableProjectsError, type TaskServiceContext } from '@wadeck-app/task-service';

import type { SkippedProject } from './allProjectsViews.js';

export interface ProjectRead<T> {
	project: { id?: string; name: string; path: string };
	value: T;
}

export interface AcrossProjects<T> {
	/** The readable projects, sorted by name (case-insensitive) then path: the order of the other all-projects views. */
	entries: ProjectRead<T>[];
	/** The projects that could not be read, with why. */
	unreadable: SkippedProject[];
	/** Why the shared registry could not be read (the legacy projects are still read); null when it was. */
	registryProblem: string | null;
}

function compareText(a: string, b: string): number {
	const [left, right] = [a.toLowerCase(), b.toLowerCase()];
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Runs `read` on every readable registered project. Nothing registered is an empty answer; projects registered but
 * none readable throw {@link NoReadableProjectsError} (an empty answer would read as "no tasks"); a corrupt registry throws its error.
 */
export function readAcrossProjects<T>(configDir: string, read: (ctx: TaskServiceContext) => T): AcrossProjects<T> {
	const { entries: inspected, registryProblem } = inspectKnownProjects(configDir);
	const entries: ProjectRead<T>[] = [];
	const unreadable: SkippedProject[] = [];
	for (const { known, health, context } of inspected) {
		if (context === null) {
			unreadable.push({ path: health.path, error: health.error ?? 'unreadable' });
			continue;
		}
		entries.push({ project: { ...context.project, path: known.path }, value: read(context) });
	}
	if (inspected.length > 0 && entries.length === 0) throw new NoReadableProjectsError(unreadable);
	entries.sort((a, b) => compareText(a.project.name, b.project.name) || compareText(a.project.path, b.project.path));
	return { entries, unreadable, registryProblem };
}
