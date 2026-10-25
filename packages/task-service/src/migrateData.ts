// `task cli migrate-data`: copies the `.task` of a registered project into the shared project registry. This module is the ONLY one that
// knows the `.task` folder (architecture rule NO_LEGACY_DATA_PATH): task reads the registry alone, and refuses a project whose data
// is still in the old folder (`assertDataMigrated`) with the command that copies it.
import * as fs from 'node:fs';
import * as path from 'node:path';

import { CONFIG_FILE, INDEX_FILE, jsonFilesIn, taskIdsIn } from './dataFiles.js';
import { DataMigrationError, ProjectDataSplitError, UnmigratedDataError } from './errors.js';
import type { ResolvedProject } from './resolveProject.js';
import { hasTaskData, ownConfigFile, tasksDirOf } from './storage.js';
import type { TaskStorage } from './storage.js';

/** The old data folder of a project directory (a registered project's main path). */
function oldDataDirOf(mainDir: string): string {
	return path.join(mainDir, '.task');
}

interface OldData {
	/** Task files in `tasks/`. */
	tasks: number;
	index: boolean;
	config: boolean;
}

/** What an old data folder holds (what `task cli migrate-data` copies). */
function describeOldData(dir: string): OldData {
	return {
		tasks: jsonFilesIn(path.join(dir, 'tasks')).length,
		index: fs.existsSync(path.join(dir, INDEX_FILE)),
		config: fs.existsSync(path.join(dir, CONFIG_FILE)),
	};
}

/** The command that copies the old data folder of a project into the shared registry. */
function migrateCommand(projectName: string): string {
	return `task cli migrate-data -p ${projectName}`;
}

/**
 * Task reads the registry only. Called before every context is built: fails when the project still keeps its data in the `.task` of its
 * main path, never falls back to it.
 * - registry has no task data and the `.task` holds data (or a config the registry lacks): {@link UnmigratedDataError} naming both
 *   folders, hint = the exact `task cli migrate-data -p <name>` command;
 * - both hold task data with the same task ids (the state right after `migrate-data`): passes, the registry wins, nothing is said;
 * - both hold task data and the ids differ: a REAL split, {@link ProjectDataSplitError} (nothing is read);
 * - otherwise (fresh project, registry data only, virtual project): passes.
 */
export function assertDataMigrated(storage: TaskStorage, projectName: string): void {
	if (storage.mainDir === undefined) return;
	const oldDir = oldDataDirOf(storage.mainDir);
	const old = describeOldData(oldDir);
	const oldHasData = old.tasks > 0 || old.index;
	const registryHasData = hasTaskData(storage.dataDir);
	if (registryHasData && oldHasData) {
		const [mine, theirs] = [taskIdsIn(storage.dataDir), taskIdsIn(oldDir)];
		if (mine.length === theirs.length && mine.every((id, index) => id === theirs[index])) return;
		throw new ProjectDataSplitError(
			projectName,
			oldDir,
			storage.dataDir,
			`Keep one of them: to keep the registry data, delete ${oldDir} by hand; to keep the .task data, move ${storage.dataDir} away by hand (then run: ${migrateCommand(projectName)}).`
		);
	}
	if (!registryHasData && (oldHasData || (old.config && !fs.existsSync(ownConfigFile(storage))))) {
		throw new UnmigratedDataError(
			projectName,
			oldDir,
			storage.dataDir,
			`Copy the tasks into the registry with: ${migrateCommand(projectName)}, check them (task list -p ${projectName} --all), then delete ${oldDir} by hand.`
		);
	}
}

export interface MigrateDataOptions {
	/** Report what would be copied; write nothing (not even the destination folders). */
	dryRun?: boolean;
}

export interface MigrateDataResult {
	dryRun: boolean;
	project: { id: string; name: string };
	/** The `.task` folder read (never modified, never deleted). */
	source: string;
	destination: { dataDir: string; configFile: string };
	tasks: { count: number; bytes: number };
	index: { copied: boolean; bytes: number };
	config: { copied: boolean; bytes: number };
	/** Entries of the `.task` that were left alone (not task files), as paths relative to it. Never silent. */
	notCopied: string[];
	/** Things worth knowing that did not stop the copy. */
	warnings: string[];
	/** What to do next, in words and commands. */
	nextStep: string;
}

const KNOWN_ENTRIES = new Set(['tasks', 'task-index.json', 'config.yml']);

function fail(message: string, hint?: string): never {
	throw new DataMigrationError(message, hint);
}

function sizeOf(file: string): number {
	return fs.statSync(file).size;
}

/**
 * Copies `<main path>/.task/{tasks/*.json, task-index.json, config.yml}` into the data folder and the own config layer of a
 * project of the shared registry. COPY ONLY: the source is never modified, moved or deleted. Refuses (nothing written) when the project
 * is virtual, has nothing to copy, or when the destination already holds task data (or a config, if there is one to
 * copy). Verifies the file count and every byte size after the copy; any failure removes what this call created
 * (`DataMigrationError`). Nothing is rebuilt: a missing index stays missing and is reported in `warnings`.
 */
export function migrateData(resolved: ResolvedProject, options: MigrateDataOptions = {}): MigrateDataResult {
	const dryRun = options.dryRun === true;
	const { storage } = resolved;
	const project = { id: resolved.id, name: resolved.name };
	if (storage.mainDir === undefined) {
		return fail(
			`project ${project.name} (${project.id}) is a virtual project (no path): it has no .task to copy`,
			'A virtual project keeps its data in the registry already; there is nothing to migrate.'
		);
	}
	const source = oldDataDirOf(storage.mainDir);
	const found = describeOldData(source);
	if (found.tasks === 0 && !found.index && !found.config) {
		return fail(
			`nothing to migrate: ${source} holds no task file, no task-index.json and no config.yml`,
			`If the data is elsewhere, register that folder instead: project paths add ${project.name} <dir> --main`
		);
	}
	const configFile = ownConfigFile(storage);
	if (hasTaskData(storage.dataDir)) {
		return fail(
			`refusing to copy ${source} into ${storage.dataDir}: that folder already holds task data, and copying would mix two sets of tasks`,
			`Nothing was written. If ${storage.dataDir} was created by mistake, move it away yourself, then run again; if the data is already migrated, delete ${source} by hand.`
		);
	}
	if (found.config && fs.existsSync(configFile)) {
		return fail(
			`refusing to copy ${path.join(source, 'config.yml')} over ${configFile}: the project already has a config`,
			`Nothing was written. Merge the two files by hand, or move ${configFile} away, then run again.`
		);
	}

	const tasksSource = path.join(source, 'tasks');
	const taskFiles =
		found.tasks === 0
			? []
			: fs
					.readdirSync(tasksSource)
					.filter(name => name.endsWith('.json'))
					.sort();
	const notCopied = [
		...fs.readdirSync(source).filter(name => !KNOWN_ENTRIES.has(name)),
		...(found.tasks === 0 && !fs.existsSync(tasksSource)
			? []
			: fs
					.readdirSync(tasksSource)
					.filter(name => !name.endsWith('.json'))
					.map(name => `tasks/${name}`)),
	].sort();
	const warnings: string[] = [];
	if (found.tasks > 0 && !found.index) {
		warnings.push(
			`${path.join(source, 'task-index.json')} is missing: the tasks are copied but the index is not rebuilt (it was missing before the copy too). Check with \`task list -p ${project.name} --all\` before trusting the copy.`
		);
	}
	if (found.tasks === 0 && found.index) {
		warnings.push(`${source} has a task-index.json but no task file: the index is copied as it is.`);
	}

	const result: MigrateDataResult = {
		dryRun,
		project,
		source,
		destination: { dataDir: storage.dataDir, configFile },
		tasks: {
			count: taskFiles.length,
			bytes: taskFiles.reduce((sum, name) => sum + sizeOf(path.join(tasksSource, name)), 0),
		},
		index: { copied: found.index, bytes: found.index ? sizeOf(path.join(source, 'task-index.json')) : 0 },
		config: { copied: found.config, bytes: found.config ? sizeOf(path.join(source, 'config.yml')) : 0 },
		notCopied,
		warnings,
		nextStep:
			`Check the copy with: task list -p ${project.name} --all (and \`task show <id> -p ${project.name}\`). ` +
			`When you are satisfied, delete ${source} by hand: task never deletes it. Until you do, commands use the registry copy; a task created or deleted meanwhile makes the two folders differ, and commands then fail (naming both) until ${source} is deleted. A second copy is refused.`,
	};
	if (dryRun) {
		result.nextStep = `Dry run: nothing was written. Run again without --dry-run to copy.`;
		return result;
	}

	const created: string[] = [];
	const copy = (from: string, to: string): void => {
		fs.mkdirSync(path.dirname(to), { recursive: true });
		// COPYFILE_EXCL: never overwrite anything that is already there.
		fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
		created.push(to);
		if (sizeOf(from) !== sizeOf(to)) {
			throw new Error(
				`size mismatch after copying ${from} (${sizeOf(from)} bytes) to ${to} (${sizeOf(to)} bytes)`
			);
		}
	};
	try {
		const tasksTarget = tasksDirOf(storage);
		fs.mkdirSync(tasksTarget, { recursive: true });
		for (const name of taskFiles) copy(path.join(tasksSource, name), path.join(tasksTarget, name));
		if (found.index) copy(path.join(source, 'task-index.json'), path.join(storage.dataDir, 'task-index.json'));
		if (found.config) copy(path.join(source, 'config.yml'), configFile);
		const copiedCount = fs.readdirSync(tasksTarget).filter(name => name.endsWith('.json')).length;
		if (copiedCount !== taskFiles.length) {
			throw new Error(
				`${taskFiles.length} task file(s) read from ${tasksSource} but ${copiedCount} found in ${tasksTarget}`
			);
		}
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		const failed: string[] = [];
		for (const file of created) {
			try {
				fs.rmSync(file, { force: true });
			} catch {
				failed.push(file);
			}
		}
		return fail(
			`copying ${source} failed: ${reason}. The copy was rolled back (${created.length - failed.length} of ${created.length} copied file(s) removed), ${source} was not modified`,
			failed.length === 0
				? `Fix the cause above, then run again.`
				: `These copied files could not be removed, delete them by hand before running again: ${failed.join(', ')}`
		);
	}
	return result;
}
