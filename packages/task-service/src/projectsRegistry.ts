import * as fs from 'node:fs';
import * as path from 'node:path';

import { TaskConfigLoader } from '@wadeck-app/task-core';

import {
	InvalidProjectPathError,
	ProjectAlreadyRegisteredError,
	ProjectNotRegisteredError,
	ProjectsRegistryError,
} from './errors.js';
import { assertExistingDirectory, validateProjectPath } from './projectPaths.js';
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

/**
 * Removes a registered project and returns the entry as stored. The REGISTRY ENTRY only: the project's `.task` data and
 * its directory are never touched. Throws {@link ProjectNotRegisteredError} when it is not registered (nothing is written).
 */
export function removeRegisteredProject(
	configDir: string,
	dir: string,
	lockOptions?: RegistryLockOptions
): { removed: string } {
	const target = validateProjectPath(dir);
	return withRegistryLock(
		configDir,
		() => {
			const projects = listRegisteredProjects(configDir);
			const stored = projects.find(p => isSameProjectDir(p, target));
			if (stored === undefined) throw new ProjectNotRegisteredError(target);
			writeRegistry(
				configDir,
				projects.filter(p => p !== stored)
			);
			return { removed: stored };
		},
		lockOptions
	);
}

/**
 * Replaces the registry entry `oldDir` by `newDir` (the project moved on disk, or was registered with a wrong path),
 * keeping its position. `newDir` must be an existing directory holding a `.task`. `oldDir` may be gone from the disk.
 * Nothing in either directory is touched. Fails (nothing written) when `oldDir` is not registered, `newDir` already is,
 * or both are the same directory. Safe against concurrent writers.
 */
export function relocateProject(
	configDir: string,
	oldDir: string,
	newDir: string,
	lockOptions?: RegistryLockOptions
): { from: string; to: string } {
	const from = validateProjectPath(oldDir, 'current project directory');
	const to = validateProjectPath(newDir, 'new project directory');
	assertExistingDirectory(to);
	if (!TaskConfigLoader.isInitialized(to)) {
		throw new InvalidProjectPathError(
			`${to} is not an initialized task project (no .task directory)`,
			'Point to the directory that holds the .task folder, or run `task init` there first (the Projects page can initialise it).'
		);
	}
	if (isSameProjectDir(from, to)) {
		throw new InvalidProjectPathError(
			`the new directory is the same directory as the registered one (${to})`,
			'Give the directory the project moved to.'
		);
	}
	return withRegistryLock(
		configDir,
		() => {
			const projects = listRegisteredProjects(configDir);
			const index = projects.findIndex(p => isSameProjectDir(p, from));
			if (index < 0) throw new ProjectNotRegisteredError(from);
			const clash = projects.find(p => isSameProjectDir(p, to));
			if (clash !== undefined) throw new ProjectAlreadyRegisteredError(clash);
			const stored = projects[index]!;
			writeRegistry(
				configDir,
				projects.map((p, i) => (i === index ? to : p))
			);
			return { from: stored, to };
		},
		lockOptions
	);
}

/** True only when the path is known not to be a directory (absent, or a file); other stat failures (permissions...) keep the entry. */
function isMissingDirectory(dir: string): boolean {
	try {
		return !fs.statSync(dir).isDirectory();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === 'ENOENT' || code === 'ENOTDIR';
	}
}

/**
 * Removes the registered projects whose directory no longer exists and returns them. With `dryRun` nothing is
 * written. A registry with nothing to prune is not rewritten. Safe against concurrent writers.
 */
export function pruneMissingProjects(
	configDir: string,
	options: { dryRun?: boolean; lock?: RegistryLockOptions } = {}
): { removed: string[] } {
	return withRegistryLock(
		configDir,
		() => {
			const projects = listRegisteredProjects(configDir);
			const removed = projects.filter(isMissingDirectory);
			if (removed.length > 0 && options.dryRun !== true) {
				writeRegistry(
					configDir,
					projects.filter(p => !removed.includes(p))
				);
			}
			return { removed };
		},
		options.lock
	);
}
