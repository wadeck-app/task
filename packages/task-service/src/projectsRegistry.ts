// The LEGACY list of projects (`<config dir>/projects.json`, a JSON array of absolute directories), READ ONLY.
// Task no longer writes it (no lock, no register/unregister/move/prune): the shared project registry (`project` CLI) owns the
// projects. It is still read to list the projects that have not been registered there yet (removed in stage 2b).
import * as fs from 'node:fs';
import * as path from 'node:path';

import { ProjectsRegistryError } from './errors.js';

/** Location of the legacy list: a JSON array of absolute project directories. */
export function projectsRegistryPath(configDir: string): string {
	return path.join(configDir, 'projects.json');
}

function corrupt(file: string, reason: string): ProjectsRegistryError {
	return new ProjectsRegistryError(
		`projects registry ${file} is invalid: ${reason}`,
		`Fix or delete ${file} (expected a JSON array of absolute project directories; task only reads it now, register projects with the project CLI: project add <dir>).`
	);
}

/** Comparison key: Windows paths are case-insensitive. */
function keyOf(dir: string): string {
	return process.platform === 'win32' ? dir.toLowerCase() : dir;
}

/** True when both paths designate the same project directory (the comparison the registry itself uses). */
export function isSameProjectDir(a: string, b: string): boolean {
	return keyOf(path.resolve(a)) === keyOf(path.resolve(b));
}

/** Legacy project directories, in the order of the file. No file means none; a corrupt file throws, never read as "none". */
export function listRegisteredProjects(configDir: string): string[] {
	const file = projectsRegistryPath(configDir);
	let raw: string;
	try {
		raw = fs.readFileSync(file, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw new ProjectsRegistryError(
			`cannot read projects registry ${file}: ${(error as Error).message}`,
			`Check the permissions of ${file}.`
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw corrupt(file, (error as Error).message || 'not valid JSON');
	}
	if (!Array.isArray(parsed)) {
		throw corrupt(file, 'the top level is not a JSON array');
	}
	for (const entry of parsed) {
		if (typeof entry !== 'string') {
			throw corrupt(file, `entry ${JSON.stringify(entry)} is not a string`);
		}
		if (!path.isAbsolute(entry)) {
			throw corrupt(file, `entry "${entry}" is not an absolute path`);
		}
	}
	return parsed as string[];
}
