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
