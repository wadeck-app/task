import * as path from 'node:path';

/** A project as the module addresses it: its id in the shared project registry, and its main folder when it is shown. */
export interface ProjectIdentity {
	id: string;
	path?: string;
}

/**
 * How a project is named in a PAGE address (`/tasks/p/:project`): its registry id (8 hex, stable when the folder moves). The
 * shell's breadcrumb prints the value cut at 16 characters, so a folder would read the same for every project of a workspace.
 */
export function pageRef(project: ProjectIdentity): string {
	return project.id;
}

/** How a project is named in an API query (`?project=`): its registry id. */
export function apiRef(project: ProjectIdentity): string {
	return project.id;
}

/**
 * The two spellings that named a project before the shared registry and are not accepted any more: the absolute folder, and the
 * page slug (`<folder name>~<6 hex>`). Null for anything else, which is the registry's to resolve (id, id prefix, name, alias).
 * Recognised on any platform: a Windows path sent to a POSIX server is still a folder, not a name.
 */
export function retiredRefKind(ref: string): 'directory' | 'slug' | null {
	if (path.isAbsolute(ref) || path.posix.isAbsolute(ref) || path.win32.isAbsolute(ref)) return 'directory';
	if (/^[\w-]+~[0-9a-f]{6}$/.test(ref)) return 'slug';
	return null;
}
