// How a background migration ends, for the adapters (the CLI): `finalizeProjectMigration` switches the project to "new" alone,
// `abortProjectMigration` puts it back on "current". The checks, the state and the order of the steps are in the migrating plugin
// (plugins/migrating/migrationFinish.ts, reached through the seam); what is here is the part that belongs to the host: the project
// config file (read, validated as a layer, backed up, replaced atomically), the opening of the project for the verification, and the
// summary event.
import { writeFileAtomic } from '@wadeck-app/project-sdk';
import { BackendRejectedError, TaskConfigLoader } from '@wadeck-app/task-core';

import type { TaskEvent } from './events.js';
import { sha256Hex } from './migrate/canonicalJson.js';
import { BACKUP_SUFFIX, readConfigText, writeConfigWithBackup } from './migrate/migrateInPlace.js';
import { openMigration, openMigrationControl } from './migrationService.js';
import { openResolvedProject } from './openContext.js';
import type { AbortOutcome, ConfigSwitch, FinalizeOutcome, TaskPluginRegistry } from './plugins/kinds.js';
import { loadProjectSetup } from './projectConfig.js';
import type { ResolvedProject } from './resolveProject.js';
import { ownConfigFile } from './storage.js';

/** Where the config an abort replaces is kept (the one `finalize` replaces is kept as config.yml.before-migration, like `task migrate --in-place`). */
export const ABORT_BACKUP_SUFFIX = '.before-abort';

export interface MigrationEndInput {
	project: ResolvedProject;
	globalConfigDir?: string;
	registry?: TaskPluginRegistry;
	env?: NodeJS.ProcessEnv;
	/** Tests: how the backup and the new config are written. Default: the SDK's atomic write (temp file, fsync, rename). */
	writeFile?: (file: string, content: string) => void;
}

export interface FinalizeResult extends FinalizeOutcome {
	project: { id: string; name: string };
	/** The summary event, to hand to the sink: empty when it was raised already. */
	events: TaskEvent[];
}

export interface AbortResult extends AbortOutcome {
	project: { id: string; name: string };
}

export interface AbortInput extends MigrationEndInput {
	/** Leave the tasks whose truth is in "new" there (listed, no longer part of the project) instead of refusing. */
	keepMoved: boolean;
	sleep?: (ms: number) => Promise<void>;
	/** How long to wait for a worker that was asked to stop. Default 60 s. */
	waitMs?: number;
}

const DEFAULT_ABORT_WAIT_MS = 60_000;
const SECTION_HINT =
	'The project config (config.yml of the project) must have: strategy: { type: migrating, options: { current: { type: ... }, new: { type: ... } } }. See: task strategy show. Nothing was changed.';

const fingerprintOf = (text: string | undefined): string => (text === undefined ? 'absent' : sha256Hex(text));

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The switch of the project config to one of the two blocks of its migrating section (`new` for a finalize, `current` for an abort).
 * Everything that can be refused is refused here, before a store is opened or a byte is written: no config file, no migrating
 * section, a block that does not validate as a project section (secrets, options), an existing backup with other content.
 */
function prepareSwitch(
	input: MigrationEndInput,
	which: 'new' | 'current',
	suffix: string,
	operation: string
): ConfigSwitch {
	const { project } = input;
	const configFile = ownConfigFile(project.storage);
	const backupFile = `${configFile}${suffix}`;
	const old = readConfigText(configFile);
	const loadOptions = {
		...(input.globalConfigDir === undefined ? {} : { globalConfigDir: input.globalConfigDir }),
		...(input.registry === undefined ? {} : { registry: input.registry }),
	};
	if (old === undefined) {
		throw new BackendRejectedError(
			'migrating',
			operation,
			`${operation} refused: the project ${project.name} has no config file (${configFile}), so it has no migrating strategy to end`,
			SECTION_HINT
		);
	}
	// The project as it is: a migrating strategy, or a refusal naming what it is.
	const current = loadProjectSetup(project.storage, loadOptions);
	if (current.strategy.plugin.migrationControl === undefined) {
		throw new BackendRejectedError(
			'migrating',
			operation,
			`${operation} refused: the strategy of ${project.name} is "${current.strategy.type}", not a migrating one: ${configFile} has no migration to end`,
			SECTION_HINT
		);
	}
	const values = TaskConfigLoader.parseConfigText(old, configFile) ?? {};
	const section = values['strategy'];
	const block = isRecord(section) && isRecord(section['options']) ? section['options'][which] : undefined;
	if (!isRecord(block)) {
		throw new BackendRejectedError(
			'migrating',
			operation,
			`${operation} refused: ${configFile} has no strategy.options.${which} block`,
			SECTION_HINT
		);
	}
	// Every other key of the config is kept; the strategy section becomes the block, whole (its type, options, fidelity, fills).
	const next = { ...values, strategy: block };
	// The block is validated as the section of the project it will be (secrets, options, fills): a problem names the file and the key.
	const target = loadProjectSetup(project.storage, {
		...loadOptions,
		ownLayer: { name: configFile, values: next },
	});
	if (target.strategy.plugin.migrationControl !== undefined) {
		throw new BackendRejectedError(
			'migrating',
			operation,
			`${operation} refused: the "${which}" block of ${configFile} is itself a migrating strategy`,
			`Give it the strategy the tasks ${which === 'new' ? 'go to' : 'are in'}. Nothing was changed.`
		);
	}
	const text = TaskConfigLoader.renderConfig(next);
	const kept = readConfigText(backupFile);
	if (kept !== undefined && kept !== old) {
		throw new BackendRejectedError(
			'migrating',
			operation,
			`${operation} refused: ${backupFile} already exists with other content: it is the rollback copy of an earlier switch and would be overwritten`,
			`Keep it elsewhere (rename ${backupFile}), then run the command again. Nothing was changed.`
		);
	}
	const write = input.writeFile ?? writeFileAtomic;
	return {
		current: () => fingerprintOf(readConfigText(configFile)),
		original: fingerprintOf(old),
		target: fingerprintOf(text),
		apply: markStarted => {
			const fresh = readConfigText(configFile);
			if (fresh !== old) {
				throw new BackendRejectedError(
					'migrating',
					operation,
					`${operation} refused: ${configFile} changed since it was read: replacing it now would overwrite that change`,
					'Review the change, then run the command again. The config is untouched.'
				);
			}
			writeConfigWithBackup({ configFile, backupFile, old: fresh, text, write, markStarted });
			return { config: configFile, backup: backupFile };
		},
	};
}

function finalizeEvent(project: ResolvedProject, outcome: FinalizeOutcome): TaskEvent {
	return {
		name: 'onTasksMigrated',
		payload: {
			fromProjectId: project.id,
			fromProjectName: project.name,
			toProjectId: project.id,
			toProjectName: project.name,
			created: outcome.moved,
			resumed: 0,
			skipped: 0,
			failed: 0,
			remaining: 0,
			complete: true,
			taskProjectId: project.id,
			taskProjectName: project.name,
			...(project.path === undefined ? {} : { taskProjectPath: project.path }),
		},
	};
}

/**
 * Ends the background migration of `project` on its "new" strategy: the project config becomes the "new" block (every other key kept, the
 * old file kept as config.yml.before-migration), after the files and the STORES were checked. Throws a BackendRejectedError naming each
 * blocker and its fix when it cannot, before anything is written. A finished migration answers `already-finished` and changes nothing;
 * a run that died right after writing the config only completes its bookkeeping (no store is opened).
 */
export async function finalizeProjectMigration(input: MigrationEndInput): Promise<FinalizeResult> {
	const { project } = input;
	const { control, input: controlInput } = openMigrationControl(project.storage, input.registry);
	const configFile = ownConfigFile(project.storage);
	const stage = control.finalizeStage(controlInput, fingerprintOf(readConfigText(configFile)));
	const who = { id: project.id, name: project.name };
	if (stage.kind === 'already-finished') return { ...stage.outcome, project: who, events: [] };
	if (stage.kind === 'interrupted') {
		const outcome = control.completeFinalize(controlInput, fingerprintOf(readConfigText(configFile)));
		return { ...outcome, project: who, events: outcome.eventDue ? [finalizeEvent(project, outcome)] : [] };
	}

	// Refused here, before any store is opened: the config, its backup and the block that will become the strategy.
	const config = prepareSwitch(input, 'new', BACKUP_SUFFIX, 'finalize');
	// The stores are read as they are now (no cache): the verification is the last look before the project stops using the index.
	const ctx = openResolvedProject(project, input.globalConfigDir, {
		freshReads: true,
		...(input.registry === undefined ? {} : { registry: input.registry }),
		...(input.env === undefined ? {} : { env: input.env }),
	});
	let outcome: FinalizeOutcome;
	const warnings: string[] = [];
	try {
		const migration = await openMigration(ctx);
		outcome = await migration.finalize(config);
		for (const notice of ctx.takeNotices?.() ?? []) warnings.push(notice.text);
	} finally {
		try {
			await ctx.dispose?.();
		} catch (error) {
			warnings.push(
				`could not release the storage of project ${project.name}: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
	return {
		...outcome,
		warnings: [...outcome.warnings, ...warnings],
		project: who,
		events: outcome.eventDue ? [finalizeEvent(project, outcome)] : [],
	};
}

/**
 * Puts the project back on its "current" strategy: the project config becomes the "current" block (the migrating config is kept as
 * config.yml.before-abort). No store is opened, so it works when a token is missing or a server is down. Nothing is deleted: the copies
 * in "new" are listed (and, with `keepMoved`, the tasks whose truth is there). Refused, with the fix, while tasks live in "new" and
 * `keepMoved` is not given, or while a worker does not stop.
 */
export async function abortProjectMigration(input: AbortInput): Promise<AbortResult> {
	const { project } = input;
	const { control, input: controlInput } = openMigrationControl(project.storage, input.registry);
	const configFile = ownConfigFile(project.storage);
	const stage = control.abortStage(controlInput, fingerprintOf(readConfigText(configFile)));
	const who = { id: project.id, name: project.name };
	if (stage.kind === 'already-aborted') return { ...stage.outcome, project: who };
	if (stage.kind === 'interrupted') {
		return { ...control.completeAbort(controlInput, fingerprintOf(readConfigText(configFile))), project: who };
	}
	const config = prepareSwitch(input, 'current', ABORT_BACKUP_SUFFIX, 'abort');
	const outcome = await control.abort(controlInput, {
		keepMoved: input.keepMoved,
		switch: config,
		sleep: input.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))),
		waitMs: input.waitMs ?? DEFAULT_ABORT_WAIT_MS,
	});
	return { ...outcome, project: who };
}
