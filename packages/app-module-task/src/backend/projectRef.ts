import * as crypto from 'node:crypto';
import * as path from 'node:path';

import { isSameProjectDir } from '@wadeck-app/task-service';

/**
 * How a project is named in a PAGE address (`/tasks/p/<slug>/...`): the shell's breadcrumb keeps the path parameters of
 * the current address and prints the value, but cuts it to 16 characters, so a full directory would read the same for
 * every project of one workspace. The slug is the directory name (address-safe characters) and six hex digits of the
 * directory, which keeps two projects with the same name apart and is derived, never stored.
 * The API still takes the absolute directory (`?project=`): only the pages use slugs.
 */
export function projectSlug(dir: string): string {
	const resolved = path.resolve(dir);
	const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
	const name = path
		.basename(resolved)
		.replace(/[^A-Za-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '');
	const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 6);
	return `${name === '' ? 'project' : name}~${hash}`;
}

/** A project as the module addresses it: its id in the shared registry when it has one, and its directory. */
export interface ProjectIdentity {
	id?: string;
	path: string;
}

/**
 * How a project is named in a PAGE address (`/tasks/p/:project`): its registry id (8 hex, stable when the directory moves),
 * else, for a project known only by the legacy projects.json, the slug of its directory.
 */
export function pageRef(project: ProjectIdentity): string {
	return project.id ?? projectSlug(project.path);
}

/**
 * How a project is named in an API query (`?project=`): its registry id, else its absolute directory (deprecated, the only
 * name a legacy project has).
 */
export function apiRef(project: ProjectIdentity): string {
	return project.id ?? project.path;
}

/**
 * The known project a reference names, without reading anything: a registry id, a slug of a page address (older links,
 * unregistered projects), or an absolute directory (the API; deprecated). Undefined when none matches; names and aliases
 * are the registry's to resolve (task-service `resolveProjectReference`).
 * Works on bare directories (strings) as well as on projects with an id.
 */
export function findProjectByRef<T extends string | ProjectIdentity>(known: readonly T[], ref: string): T | undefined {
	if (ref === '') return undefined;
	const pathOf = (item: T): string => (typeof item === 'string' ? item : item.path);
	const wanted = ref.toLowerCase();
	const byId = known.filter(item => typeof item !== 'string' && item.id === wanted);
	if (byId.length === 1) return byId[0];
	const bySlug = known.filter(item => projectSlug(pathOf(item)) === ref);
	if (bySlug.length === 1) return bySlug[0];
	if (!path.isAbsolute(ref)) return undefined;
	return known.find(item => isSameProjectDir(pathOf(item), ref));
}
