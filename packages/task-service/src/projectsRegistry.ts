import * as fs from 'node:fs';
import * as path from 'node:path';

import { ProjectsRegistryError } from './errors.js';
import { withRegistryLock } from './registryLock.js';
import type { RegistryLockOptions } from './registryLock.js';

/** Location of the registry: a JSON array of absolute project directories. */
export function projectsRegistryPath(configDir: string): string {
	return path.join(configDir, 'projects.json');
}

function corrupt(file: string, reason: string): ProjectsRegistryError {
	return new ProjectsRegistryError(
		`projects registry ${file} is invalid: ${reason}`,
		`Fix or delete ${file} (expected a JSON array of absolute project directories), then run \`task init\` in your projects again if you delete it.`
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

function normalize(dir: string): string {
	if (!path.isAbsolute(dir)) {
		throw new ProjectsRegistryError(
			`project directory "${dir}" is not absolute`,
			'Pass an absolute path (the projects registry only holds absolute directories).'
		);
	}
	return path.resolve(dir);
}

/** Registered project directories, in registration order. No file means nothing registered; a corrupt file throws. */
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

/** Write to a sibling temp file then rename: a crash never leaves a half-written registry. */
function writeRegistry(configDir: string, projects: string[]): void {
	const file = projectsRegistryPath(configDir);
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(projects, null, 2) + '\n', 'utf8');
		fs.renameSync(tmp, file);
	} catch (error) {
		fs.rmSync(tmp, { force: true });
		throw new ProjectsRegistryError(
			`cannot write projects registry ${file}: ${(error as Error).message}`,
			`Check that ${configDir} is writable.`
		);
	}
}

/** Adds a project directory. Idempotent: `added` is false when it was already registered. Safe against concurrent writers. */
export function registerProject(configDir: string, dir: string, lockOptions?: RegistryLockOptions): { added: boolean } {
	const target = normalize(dir);
	return withRegistryLock(
		configDir,
		() => {
			const projects = listRegisteredProjects(configDir);
			if (projects.some(p => isSameProjectDir(p, target))) return { added: false };
			writeRegistry(configDir, [...projects, target]);
			return { added: true };
		},
		lockOptions
	);
}

/** Removes a project directory. `removed` is false when it was not registered (nothing is written). Safe against concurrent writers. */
export function unregisterProject(
	configDir: string,
	dir: string,
	lockOptions?: RegistryLockOptions
): { removed: boolean } {
	const target = normalize(dir);
	return withRegistryLock(
		configDir,
		() => {
			const projects = listRegisteredProjects(configDir);
			const kept = projects.filter(p => !isSameProjectDir(p, target));
			if (kept.length === projects.length) return { removed: false };
			writeRegistry(configDir, kept);
			return { removed: true };
		},
		lockOptions
	);
}
