// `task cli migrate-data`: copies the `.task` of a registered project into the shared project registry (stage 2a).
import * as fs from 'node:fs';
import * as path from 'node:path';

import { DataMigrationError } from './errors.js';
import type { ResolvedProject } from './resolveProject.js';
import { describeLegacyData, hasTaskData, ownConfigFile, tasksDirOf } from './storage.js';

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
 * REGISTERED project. COPY ONLY: the source is never modified, moved or deleted. Refuses (nothing written) when the project is not
 * registered, is virtual, has nothing to copy, or when the destination already holds task data (or a config, if there is one to
 * copy). Verifies the file count and every byte size after the copy; any failure removes what this call created
 * (`DataMigrationError`). Nothing is rebuilt: a missing index stays missing and is reported in `warnings`.
 */
export function migrateData(resolved: ResolvedProject, options: MigrateDataOptions = {}): MigrateDataResult {
	const dryRun = options.dryRun === true;
	const { storage } = resolved;
	if (resolved.id === undefined || storage.kind !== 'registry') {
		const dir = resolved.path ?? '<dir>';
		return fail(
			`${dir} is not in the shared project registry, so there is no registry folder to copy its .task into`,
			`Register it first: project add "${dir}" [--name <name>], then run: task cli migrate-data -p <name>`
		);
	}
	const project = { id: resolved.id, name: resolved.name };
	if (storage.legacyDir === undefined) {
		return fail(
			`project ${project.name} (${project.id}) is a virtual project (no path): it has no .task to copy`,
			'A virtual project keeps its data in the registry already; there is nothing to migrate.'
		);
	}
	const source = storage.legacyDir;
	const found = describeLegacyData(source);
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
			`When you are satisfied, delete ${source} by hand: task never deletes it. Until you do, commands use the registry copy and print the note "old copy still in ${source}: delete it by hand once checked"; a second copy is refused.`,
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
