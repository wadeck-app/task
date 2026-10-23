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

/**
 * The registered directory a reference names: a slug of a page address, or an absolute directory (the API, links made
 * before the slugs). Undefined when none of the registered projects matches.
 */
export function findProjectByRef(registered: readonly string[], ref: string): string | undefined {
	if (ref === '') return undefined;
	const bySlug = registered.filter(dir => projectSlug(dir) === ref);
	if (bySlug.length === 1) return bySlug[0];
	if (!path.isAbsolute(ref)) return undefined;
	return registered.find(dir => isSameProjectDir(dir, ref));
}
