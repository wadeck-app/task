// View models of the Projects page management (add, edit, remove): texts and rows over the registry listing.
// The sentences say what each action does to the disk, because "remove" next to a project invites the wrong guess.
import type { AddProjectMode, AddProjectResult } from '@wadeck-app/task-service';

import { literal } from './dslNodes.js';
import type { DslNode } from './dslNodes.js';
import type { ProjectListing } from './projects.js';

/** The remove sentence, shown before the confirmation and after the removal. */
const TASKS_STAY =
	"its tasks and .task folder stay on disk (only the project's entry in the task app-module is removed)";

export const MODE_OPTIONS: ReadonlyArray<{ value: AddProjectMode; label: string }> = [
	{ value: 'register', label: 'Register an existing task project (the directory already holds a .task)' },
	{ value: 'init', label: 'Initialise a new task project in this directory (creates .task, like `task init`)' },
];

/** Initial data of the add form: nothing typed, the safe mode (it never writes to the disk). */
export const ADD_FORM_DEFAULTS = { path: '', mode: 'register', createDirectory: false } as const;

function plural(count: number): string {
	return `${count} ${count === 1 ? 'project' : 'projects'}`;
}

/** What the user can do about a project that cannot be read; the buttons are named in the text. */
function repairText(project: ProjectListing): string {
	if (project.error === null) return '';
	const cause = project.error.endsWith('.') ? project.error : `${project.error}.`;
	if (!project.exists) {
		return `${cause} If the project moved, use Edit to give its new directory; otherwise use Remove to unregister it (nothing on disk is deleted).`;
	}
	if (!project.initialized) {
		return `${cause} Use Edit to point to the directory that holds the .task folder, or Remove to unregister it.`;
	}
	return `${cause} Fix the config.yml of the project, or use Remove to unregister it (nothing on disk is deleted).`;
}

/** The line above the Edit form: which entry is being edited, and that the disk is not touched. */
export function editPromptText(name: string, path: string): string {
	return `Edit the registered directory of ${name} (${path}). Nothing is moved on disk: give the directory the project is in now.`;
}

/**
 * One row of the Projects table. It carries what the row buttons send: the Edit form is given `from` and `to` (the
 * current directory, to be changed), the Remove step `path` and `confirm: true` (the click on the confirm button is the
 * confirmation); `editPrompt` / `confirmText` / `confirmLabel` are the texts the picked row shows.
 */
export function manageRows(projects: readonly ProjectListing[]): Record<string, unknown>[] {
	return projects.map(project => ({
		name: project.name,
		path: project.path,
		openText: project.openCount === null ? '-' : String(project.openCount),
		problemText: repairText(project),
		needsRepair: project.error !== null,
		from: project.path,
		to: project.path,
		editPrompt: editPromptText(project.name, project.path),
		confirm: true,
		confirmText: `Remove ${project.name} from the list? This only unregisters the project (${project.path}): ${TASKS_STAY}.`,
		confirmLabel: `Remove ${project.name} from the list`,
	}));
}

/** Links to the tasks of the readable projects: a table with row buttons cannot navigate on a row click. */
export function openLinks(projects: readonly ProjectListing[]): DslNode[] {
	return projects.flatMap(project =>
		project.href === null
			? []
			: [{ $type: 'ButtonLink', label: literal(project.name), to: project.href, size: 'sm' } satisfies DslNode]
	);
}

/** The banner above the table when some projects cannot be read; null when all can. */
export function attentionText(projects: readonly ProjectListing[]): string | null {
	const broken = projects.filter(project => project.error !== null).length;
	if (broken === 0) return null;
	return `${plural(broken)} cannot be read. Use Edit to give the new directory if it moved, or Remove to unregister it (the tasks stay on disk).`;
}

/** The sentence shown after an add. */
export function addedText(result: AddProjectResult): string {
	if (result.mode === 'register') {
		return result.added ? `Registered ${result.path}.` : `${result.path} was already registered: nothing changed.`;
	}
	if (!result.initialized) {
		return result.added
			? `${result.path} already held a task project: left untouched and registered.`
			: `${result.path} already holds a task project and is already registered: nothing changed.`;
	}
	const directory = result.createdDirectory ? ' (created the directory)' : '';
	return `Initialised a new task project in ${result.path}${directory} and registered it.`;
}

export function relocatedText(from: string, to: string): string {
	return `${from} now points to ${to}. Nothing was moved on disk: only the registered directory changed.`;
}

export function removedText(path: string): string {
	return `Unregistered ${path}: ${TASKS_STAY}. Add the directory again to bring it back.`;
}

/** The hint of the refusal to remove without confirmation: what the removal does and does not do. */
export function removeConfirmHint(path: string): string {
	return `Removing ${path} only unregisters it from the task app-module: ${TASKS_STAY}, and the directory can be added again. Resend the same body with "confirm": true.`;
}
