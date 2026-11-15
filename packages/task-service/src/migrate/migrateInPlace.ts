// `task migrate --in-place --to-config <file>`: the same registered project moves to another storage. The source is the project as it is now
// (its config.yml), the target is the project as it will be once config.yml is replaced by the draft: the same project opened twice,
// the second time with the draft in place of its own config layer (nothing is written until the switch). The engine does the copy, the
// read-back and the journal; this file reads the draft ONCE, takes the lock, decides what an earlier journal means, refuses what cannot
// work, hands the engine the switch and releases both contexts.
import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeFileAtomic } from '@wadeck-app/project-sdk';
import { NO_TRAITS, TaskConfigLoader } from '@wadeck-app/task-core';

import type { TaskServiceContext } from '../context.js';
import { describeError } from '../describeError.js';
import { eventsRaisedByServer } from '../eventsRaisedByServer.js';
import type { TaskEvent } from '../events.js';
import { openResolvedProject } from '../openContext.js';
import type { TaskPluginRegistry } from '../plugins/kinds.js';
import { loadProjectSetup, projectFactsOf } from '../projectConfig.js';
import type { OwnLayerOverride } from '../projectConfig.js';
import type { ResolvedProject } from '../resolveProject.js';
import { ownConfigFile } from '../storage.js';
import { checkStrategy } from '../strategyCheck.js';
import { canonical, sha256Hex } from './canonicalJson.js';
import { MigrationRefusedError } from './migrateErrors.js';
import {
	acquireLock,
	archiveFiles,
	recoverArchives,
	idMapFileName,
	inPlaceJournalFileName,
	readJournal,
	writeIdMap,
	writeJournal,
} from './migrateJournal.js';
import type { HeldLock, Journal } from './migrateJournal.js';
import { runMigration } from './migrateRun.js';
import type { RunMigrationInput } from './migrateRun.js';
import type {
	InPlaceReport,
	MigrationEndpoint,
	MigrationOptions,
	MigrationProgress,
	MigrationResult,
} from './migrateTypes.js';

/** Where the config the draft replaces is kept, next to it. */
export const BACKUP_SUFFIX = '.before-migration';

export interface MigrateInPlaceInput {
	/** The project that changes storage (one project: id, name, aliases and paths stay as they are). */
	project: ResolvedProject;
	/** The draft: the WHOLE new config.yml (a strategy section and everything else the project keeps), as typed. */
	draftFile: string;
	options: MigrationOptions;
	/** The command that continues a stopped run (the CLI builds it from what was typed). */
	resumeCommand: string;
	onProgress?: (progress: MigrationProgress) => void;
	globalConfigDir?: string;
	registry?: TaskPluginRegistry;
	env?: NodeJS.ProcessEnv;
	/** Tests: clock, pid and process check of the engine. */
	engine?: Pick<RunMigrationInput, 'now' | 'pid' | 'isAlive'>;
	/** Tests: how the backup and the new config are written. Default: the SDK's atomic write (temp file, fsync, rename). */
	writeFile?: (file: string, content: string) => void;
}

const sha256 = sha256Hex;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function endpointOf(ctx: TaskServiceContext, resolved: ResolvedProject): MigrationEndpoint {
	const strategy = ctx.strategy;
	if (strategy === undefined) throw new Error('internal error: the context of a project has no strategy');
	const facts = projectFactsOf(ctx.config);
	return {
		project: {
			id: resolved.id,
			name: resolved.name,
			...(resolved.path === undefined ? {} : { path: resolved.path }),
		},
		backend: ctx.store,
		facts,
		traits: strategy.plugin.traitsFor?.(strategy.options, strategy.fills, facts) ?? NO_TRAITS,
		takeNotices: () => ctx.takeNotices?.() ?? [],
	};
}

function readText(file: string): string | undefined {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw error;
	}
}

interface Draft {
	file: string;
	/** What the switch writes, byte for byte, and what everything below was validated from: the file is read once. */
	text: string;
	layer: OwnLayerOverride;
}

/** The draft, read once. Anything unreadable, invalid or without a strategy is a refusal naming the file. */
function readDraft(draftFile: string): Draft {
	const file = path.resolve(draftFile);
	let text: string | undefined;
	try {
		text = readText(file);
	} catch (error) {
		throw new MigrationRefusedError(
			`cannot read the draft config ${file}: ${(error as Error).message}`,
			'Check the path given to --to-config and its permissions.'
		);
	}
	if (text === undefined) {
		throw new MigrationRefusedError(
			`the draft config ${file} does not exist`,
			'Write the config.yml the project should have once migrated: the draft replaces the whole config.yml, so copy the current one and add the strategy section (see: task strategy help github). Then give its path to --to-config.'
		);
	}
	// A YAML error or a top level that is not a mapping throws, naming the file.
	const values = TaskConfigLoader.parseConfigText(text, file) ?? {};
	if (values['strategy'] === undefined) {
		throw new MigrationRefusedError(
			`the draft config ${file} has no strategy section, and it is the WHOLE new config.yml: an in-place migration changes where the tasks live`,
			'The draft replaces config.yml entirely (statuses, types, priorities, defaults... included), not only its strategy: copy the current config.yml, add the strategy: section of the target storage (for example strategy: { type: github, options: { repo: owner/name, tokenEnv: GITHUB_TOKEN } }), and give that file to --to-config.'
		);
	}
	return { file, text, layer: { name: file, values } };
}

interface TargetDefinition {
	hash: string;
	/** Hash per part, to say which part changed: `type`, `fidelity`, `options.<key>`, `fills`, `statuses`, `types`. */
	parts: Record<string, string>;
	location: string;
}

/**
 * Options that only say HOW to connect: fixing one (a variable renamed, a longer timeout, another page size) changes nothing of the data
 * that is migrated, so an unfinished run may continue with the fixed draft. Every other option changes where or how the tasks are
 * stored and is part of the target definition.
 */
const CONNECTION_OPTIONS: ReadonlySet<string> = new Set([
	'tokenEnv',
	'tokenFile',
	'timeoutSeconds',
	'cache',
	'pageSize',
	'maxPages',
	'writeSpacingSeconds',
	'rateLimit',
]);

/** The value of an option with its connection-only keys removed (a remote `transport` holds its own `options`). */
function withoutConnection(value: unknown): unknown {
	if (!isRecord(value)) return value;
	const kept: Record<string, unknown> = {};
	for (const [key, inner] of Object.entries(value)) {
		if (CONNECTION_OPTIONS.has(key)) continue;
		kept[key] = key === 'options' ? withoutConnection(inner) : inner;
	}
	return kept;
}

/** What of the resolved config of the project (with the draft) changes the data a migration writes. */
interface TargetConfigFacts {
	statuses: readonly string[];
	defaultStatus: string;
	terminalStatuses: readonly string[];
	negativeStatuses: readonly string[];
	types: readonly string[];
	priorities: readonly string[];
	defaultPriority: string;
}

/**
 * What defines the target: the strategy section as parsed (secrets are never literal in it: they are variable names or file paths)
 * without its connection-only options, and the statuses with their flags, the types, the priorities and the default priority the
 * project has with the draft. A comment or any other key of the draft is not part of it.
 */
function defineTarget(draft: Draft, facts: TargetConfigFacts, location: string): TargetDefinition {
	const parts: Record<string, string> = {};
	const hash = (value: unknown): string => sha256(canonical(value)).slice(0, 16);
	const section = draft.layer.values['strategy'];
	if (isRecord(section)) {
		for (const [key, value] of Object.entries(section)) {
			if (key === 'options' && isRecord(value)) {
				for (const [option, optionValue] of Object.entries(value)) {
					if (CONNECTION_OPTIONS.has(option)) continue;
					parts[`options.${option}`] = hash(withoutConnection(optionValue));
				}
			} else {
				parts[key] = hash(value);
			}
		}
	}
	parts['statuses'] = hash({
		names: facts.statuses,
		default: facts.defaultStatus,
		terminal: facts.terminalStatuses,
		negative: facts.negativeStatuses,
	});
	parts['types'] = hash(facts.types);
	parts['priorities'] = hash(facts.priorities);
	parts['defaults.priority'] = hash(facts.defaultPriority);
	return { hash: sha256(canonical(parts)), parts, location };
}

function changedParts(before: Record<string, string>, after: Record<string, string>): string[] {
	return [...new Set([...Object.keys(before), ...Object.keys(after)])]
		.filter(key => before[key] !== after[key])
		.sort();
}

function allDone(journal: Journal): boolean {
	return Object.values(journal.tasks).every(entry => entry.phase === 'done');
}

/**
 * Migrates every task of `project` into the storage the strategy of the draft describes, then replaces the config of the project by the
 * draft (the old one is kept next to it as config.yml.before-migration). Throws what the engine throws when it cannot start
 * (MigrationRefusedError, MigrationStateError), a ConfigSchemaError naming the draft or the config file that does not load, and the
 * errors of the registry. Everything that happens once the run has started is in the result.
 */
export async function migrateInPlace(input: MigrateInPlaceInput): Promise<MigrationResult> {
	const { project, options } = input;
	const draft = readDraft(input.draftFile);
	const configFile = ownConfigFile(project.storage);
	const backupFile = `${configFile}${BACKUP_SUFFIX}`;
	const dataDir = project.storage.dataDir;
	const journalFile = path.join(dataDir, inPlaceJournalFileName(project.id));
	const idMapFile = path.join(dataDir, idMapFileName(project.id));
	const clock = input.engine?.now ?? Date.now;

	// The draft is validated like a config layer (schema, secrets, strategy) and the target is defined from it, before anything else.
	const setup = loadProjectSetup(project.storage, {
		...(input.globalConfigDir === undefined ? {} : { globalConfigDir: input.globalConfigDir }),
		...(input.registry === undefined ? {} : { registry: input.registry }),
		ownLayer: draft.layer,
	});
	const targetPlugin = setup.strategy.plugin;
	const definition = defineTarget(
		draft,
		{
			statuses: setup.config.statuses,
			defaultStatus: setup.config.defaultStatus,
			terminalStatuses: setup.config.terminalStatuses,
			negativeStatuses: setup.config.negativeStatuses,
			types: setup.config.types,
			priorities: setup.config.priorities,
			defaultPriority: setup.config.defaults.priority,
		},
		targetPlugin.locationOf?.(setup.strategy.options) ?? `kind:${targetPlugin.backendKind}`
	);

	// The lock first: two runs of the same project must not race on the checks below. A dry run writes nothing, so it takes none.
	const lock = options.dryRun
		? undefined
		: acquireLock(
				dataDir,
				{
					pid: input.engine?.pid ?? process.pid,
					startedAt: new Date(clock()).toISOString(),
					from: project.id,
					to: project.id,
				},
				input.engine?.isAlive
			);
	try {
		return await migrateLocked({
			...input,
			draft,
			configFile,
			backupFile,
			journalFile,
			idMapFile,
			definition,
			lock,
			clock,
		});
	} finally {
		lock?.release();
	}
}

interface Locked extends MigrateInPlaceInput {
	draft: Draft;
	configFile: string;
	backupFile: string;
	journalFile: string;
	idMapFile: string;
	definition: TargetDefinition;
	lock: HeldLock | undefined;
	clock: () => number;
}

async function migrateLocked(input: Locked): Promise<MigrationResult> {
	const { project, options, draft, configFile, backupFile, journalFile, idMapFile, definition, clock } = input;
	const dataDir = project.storage.dataDir;
	const write = input.writeFile ?? writeFileAtomic;
	const notes: string[] = [];
	const warnings: string[] = [];

	// What config.yml is NOW (the snapshot the switch is judged against), and what an earlier run left.
	const snapshot = readText(configFile);
	const backup = readText(backupFile);
	// An archive a crash interrupted is finished before anything reads the journal; a dry run only says so.
	if (options.dryRun) {
		const stray = fs.existsSync(dataDir) && fs.readdirSync(dataDir).some(name => name.includes('.archiving-'));
		if (stray) {
			notes.push(
				'an interrupted archive of an earlier migration is in the data folder (*.archiving-*): a real run completes it first'
			);
		}
	} else {
		notes.push(...recoverArchives([journalFile, idMapFile]));
	}
	const journal = readJournal(journalFile, { fromId: project.id, toId: project.id });
	let ignoreJournal = false;
	let archiveBeforeWrite: (() => void) | undefined;

	if (snapshot === draft.text) {
		// A run that crashed AFTER replacing the config and BEFORE saying so: the journal knows everything was verified, nothing else is left.
		const state = journal?.inPlace;
		if (
			journal !== undefined &&
			state !== undefined &&
			journal.status !== 'completed' &&
			state.verified &&
			state.targetHash === definition.hash &&
			allDone(journal)
		) {
			if (!state.switchStarted) {
				// The journal never saw the switch begin: this file is a copy of the draft made by someone else (or by hand after a failed
				// switch). Nothing proves the tasks are still read back as they were, so the full path runs once the config is back.
				throw new MigrationRefusedError(
					`the config of ${project.name} already is the draft ${draft.file}, but the journal says the migration never started replacing it (the draft was probably copied by hand): the tasks were not read back for this config`,
					backup === undefined
						? `Put the old config back, then run again with --resume (the tasks are read back before the switch): delete ${configFile} if the project had none, or restore your copy of the old config.yml.`
						: `Put the old config back, then run again with --resume (the tasks are read back before the switch): copy ${backupFile} over ${configFile}.`
				);
			}
			if (!options.resume || options.dryRun) {
				throw new MigrationRefusedError(
					`the config of ${project.name} already is the draft ${draft.file}, but the migration was not marked finished (every task is migrated and verified: the run stopped right after replacing the config)`,
					`Complete it with --resume (no task is touched, nothing is created): ${input.resumeCommand}`
				);
			}
			return assembleResult(input, finishBookkeeping(input, journal), {
				original: backup,
				targetRaisedByServer: journal.inPlace?.kinds.to === 'remote',
				notes,
				warnings: [],
				releaseWarnings: [],
				checks: {},
			});
		}
		throw new MigrationRefusedError(
			`the config of ${project.name} already is the draft ${draft.file}${backup === undefined ? '' : `: it was switched (the config it replaced is ${backupFile})`}`,
			backup === undefined
				? 'Nothing to migrate: the project already has this strategy.'
				: `Nothing to do. To go back, restore the old config: copy ${backupFile} over ${configFile}.`
		);
	}
	// The rollback copy is never overwritten: it is the only way back. Refused before anything is read from a backend or written.
	if (backup !== undefined && backup !== snapshot) {
		throw new MigrationRefusedError(
			`${backupFile} already exists: it is the rollback copy of an earlier in-place migration and would be overwritten`,
			`Keep it elsewhere or delete it if you no longer need it (rename ${backupFile}), then run again.`
		);
	}

	if (journal?.status === 'completed') {
		// A finished migration: its journal and id map are archived (never deleted) so this one starts clean and the old mapping survives.
		if (options.dryRun) {
			ignoreJournal = true;
			notes.push(
				`an earlier in-place migration of this project was completed: its journal and id map are archived (renamed, never deleted) when a real run starts`
			);
		} else if (options.resume) {
			throw new MigrationRefusedError(
				`nothing to resume: the earlier in-place migration of ${project.name} was completed (${journalFile})`,
				'Run the migration without --resume.'
			);
		} else {
			// Archived only right before this run's first write (the engine calls back): a refused or blocked run leaves both files.
			ignoreJournal = true;
			archiveBeforeWrite = () => {
				const archived = archiveFiles([journalFile, idMapFile], new Date(clock()).toISOString());
				notes.push(
					`the journal and the id map of the earlier completed migration were archived: ${archived.join(', ')}`
				);
			};
		}
	} else if (journal !== undefined) {
		const state = journal.inPlace;
		if (state === undefined || state.targetHash !== definition.hash) {
			const changed =
				state === undefined
					? ['everything (the journal records no target)']
					: changedParts(state.parts, definition.parts);
			const sameLocation = state !== undefined && state.location === definition.location;
			if (options.dryRun) {
				notes.push(
					`an earlier in-place run of this project is unfinished and was started with another target (changed: ${changed.join(', ')}${sameLocation ? '' : '; another storage location'}); a real run would ${sameLocation ? 'refuse it unless --resume --accept-draft-change is given' : 'refuse it: the target is somewhere else'}`
				);
				if (!sameLocation) ignoreJournal = true;
			} else if (!sameLocation) {
				throw new MigrationRefusedError(
					`an earlier in-place migration of ${project.name} (${journalFile}) is unfinished and its target is another storage than this draft's (${state?.location ?? 'unknown'} -> ${definition.location}): the tasks it copied are not where this draft points`,
					`Use the draft it started with. If that run is abandoned (check what it created on its target first), move ${journalFile} and ${idMapFile} away and run again.`
				);
			} else if (!(options.resume && options.acceptDraftChange)) {
				throw new MigrationRefusedError(
					`an earlier in-place migration of ${project.name} (${journalFile}) is unfinished and the draft changed since it started (changed: ${changed.join(', ')})`,
					`The storage is the same (${definition.location}), so the copy is still valid. If the change is intended, accept it: ${input.resumeCommand} --accept-draft-change. Otherwise restore the draft it started with.`
				);
			} else {
				notes.push(
					`the draft changed since the earlier run started (${changed.join(', ')}): accepted, the storage location is the same`
				);
			}
		}
	}

	const open = {
		...(input.registry === undefined ? {} : { registry: input.registry }),
		...(input.env === undefined ? {} : { env: input.env }),
	};
	const contexts: TaskServiceContext[] = [];
	let result: MigrationResult | undefined;
	let targetRaisedByServer = false;
	let failed = false;
	let failure: unknown;
	let checks: Pick<InPlaceReport, 'checks' | 'checksNote'> = {};
	try {
		// The source is the project as it is now, read fresh; the target is the project as it will be (the draft in place of its config).
		const source = openResolvedProject(project, input.globalConfigDir, {
			...open,
			freshReads: true,
			...(options.dryRun ? { memoryCache: true } : {}),
		});
		contexts.push(source);
		const target = openResolvedProject(project, input.globalConfigDir, {
			...open,
			// Fresh too: the read-back and the last check before the switch must see what the system holds now, not a cache still valid.
			freshReads: true,
			...(options.dryRun ? { memoryCache: true } : {}),
			...(options.emitEvents ? {} : { suppressEvents: true }),
			ownLayer: draft.layer,
		});
		contexts.push(target);
		targetRaisedByServer = eventsRaisedByServer(target);

		const sourcePlugin = source.strategy?.plugin;
		const targetPlugin = target.strategy?.plugin;
		const sourceWhere = sourcePlugin?.locationOf?.(source.strategy!.options);
		if (
			(sourcePlugin?.backendKind === 'local' && targetPlugin?.backendKind === 'local') ||
			(sourceWhere !== undefined && sourceWhere === targetPlugin?.locationOf?.(target.strategy!.options))
		) {
			throw new MigrationRefusedError(
				sourceWhere === undefined
					? `the draft ${draft.file} keeps the tasks of ${project.name} in the local files of the project: source and target are the same storage`
					: `the draft ${draft.file} points to the storage the tasks of ${project.name} already are in (${sourceWhere})`,
				'Change the strategy section of the draft to another storage (another repository, a task server), or leave the project as it is.'
			);
		}

		// Dry run: what needs no write (the config, the token, the reachability), before the plan reads the target. A check that sends a write
		// of its own (gitlab) is left out, and said. An error line means the plan cannot read the target: it is the answer.
		if (options.dryRun) {
			const skipBackend = target.strategy?.plugin.backendKind === 'gitlab';
			const report = await checkStrategy(
				{
					storage: project.storage,
					project: {
						id: project.id,
						name: project.name,
						...(project.path === undefined ? {} : { path: project.path }),
					},
					ownLayer: draft.layer,
					memoryCache: true,
					...(input.globalConfigDir === undefined ? {} : { globalConfigDir: input.globalConfigDir }),
					...(input.registry === undefined ? {} : { registry: input.registry }),
					...(input.env === undefined ? {} : { env: input.env }),
				},
				{ backend: !skipBackend }
			);
			const errors = report.lines.filter(line => line.status === 'error');
			if (errors.length > 0) {
				throw new MigrationRefusedError(
					`the strategy of the draft ${draft.file} cannot be used yet: ${errors.map(line => `${line.name}: ${line.text}`).join('; ')}`,
					errors
						.map(line => line.fix)
						.filter((fix): fix is string => fix !== undefined)
						.join(' ') || 'Fix the strategy section of the draft, then run the dry run again.'
				);
			}
			checks = {
				checks: report.lines,
				...(skipBackend
					? {
							checksNote:
								'the backend was not asked (the gitlab check sends one no-op write, a dry run sends none): run `task strategy check` after the switch',
						}
					: {}),
			};
		}

		// A task server that serves THIS project is a loop onto the same data. Asked only once the checks above found the server reachable
		// (a dry run), and a failure to ask is an answer with its fix, never a raw transport error.
		if (targetPlugin?.backendKind === 'remote') {
			let info: { project: { id?: string; name: string } };
			try {
				info = await (
					target.store as unknown as { info: () => Promise<{ project: { id?: string; name: string } }> }
				).info();
			} catch (error) {
				const described = describeError(error);
				throw new MigrationRefusedError(
					`cannot ask the task server of the draft ${draft.file} which project it serves: ${described.message}`,
					described.hint ??
						'Run: task strategy check (with the draft as the project config) to see which line fails.'
				);
			}
			if (info.project.id === project.id) {
				throw new MigrationRefusedError(
					`the task server in the draft serves this very project (${project.name}, id ${project.id}): the tasks would be copied onto themselves`,
					'Point strategy.options.transport.options.url at the server of ANOTHER project or machine, or leave the project as it is.'
				);
			}
			if (info.project.id === undefined) {
				warnings.push(
					`the task server does not say the registry id of the project it serves (${info.project.name}): this migration cannot check that it is not this project (${project.id}); make sure it serves another one`
				);
			}
		}

		result = await runMigration({
			source: endpointOf(source, project),
			target: endpointOf(target, project),
			journalDir: project.storage.dataDir,
			options,
			resumeCommand: input.resumeCommand,
			...(input.lock === undefined ? {} : { heldLock: input.lock }),
			...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
			...input.engine,
			inPlace: {
				target: definition,
				source: {
					kind: sourcePlugin?.backendKind ?? 'local',
					location: sourceWhere ?? `kind:${sourcePlugin?.backendKind ?? 'local'}`,
				},
				idMapFile,
				...(ignoreJournal ? { ignoreJournal: true } : {}),
				...(archiveBeforeWrite === undefined ? {} : { beforeWrite: archiveBeforeWrite }),
				switchConfig: markStarted => {
					const fresh = readText(configFile);
					// Idempotent: a config that already is the draft (a run that stopped right after the replacement) is left alone.
					if (fresh === draft.text) return;
					if (fresh !== snapshot) {
						throw new MigrationRefusedError(
							`${configFile} changed since the migration started: replacing it now would overwrite that change`,
							`Review the change, then run: ${input.resumeCommand} (--resume takes a new snapshot of config.yml; nothing is created twice). The config is untouched.`
						);
					}
					// What is written is what was read at the start and validated: a second parse of the same text must give the same content.
					const again = TaskConfigLoader.parseConfigText(draft.text, draft.file);
					if (canonical(again) !== canonical(draft.layer.values)) {
						throw new Error(
							'internal error: the draft text no longer parses to the content that was validated'
						);
					}
					fs.mkdirSync(path.dirname(configFile), { recursive: true });
					// The old config is kept first (the text that is there now: it equals the snapshot); the new one replaces it whole or not at all.
					if (fresh !== undefined && readText(backupFile) === undefined) write(backupFile, fresh);
					// Recorded right BEFORE the write: a crash during or after it leaves the journal saying the switch began. A write that
					// failed and left the old config in place says it did not.
					markStarted(true);
					try {
						write(configFile, draft.text);
					} catch (error) {
						if (readText(configFile) !== draft.text) markStarted(false);
						throw error;
					}
				},
			},
		});
	} catch (error) {
		failed = true;
		failure = error;
	}

	// Both are released whatever happened; a release that fails is said, it never hides the result or the error.
	const releaseWarnings: string[] = [];
	for (const ctx of contexts) {
		try {
			await ctx.dispose?.();
		} catch (error) {
			releaseWarnings.push(
				`could not release the storage of project ${ctx.project.name}: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
	if (failed || result === undefined) throw failure;
	return assembleResult(input, result, {
		original: snapshot,
		targetRaisedByServer,
		notes,
		warnings,
		releaseWarnings,
		checks,
	});
}

interface Assembly {
	/** The config.yml the draft replaced (the backup text when the replacement already happened); undefined: the project had none. */
	original: string | undefined;
	targetRaisedByServer: boolean;
	notes: string[];
	warnings: string[];
	releaseWarnings: string[];
	checks: Pick<InPlaceReport, 'checks' | 'checksNote'>;
}

/** The ONE place the answer of an in-place run is put together, for a run that did the work and for one that only finished its bookkeeping. */
function assembleResult(input: Locked, engineResult: MigrationResult, extra: Assembly): MigrationResult {
	const { project, draft, configFile, backupFile, idMapFile } = input;
	let result = engineResult;
	const warnings = [...extra.warnings];
	if (extra.targetRaisedByServer && result.events.length > 0) {
		warnings.push(
			`the events of project ${project.name} are raised by its server: the summary event onTasksMigrated is not raised for a remote target`
		);
		result = { ...result, events: [] };
	}

	// Backup and rollback are reported only when they are true: the config was replaced and the old one is on disk.
	const switched = result.inPlace?.switched ?? false;
	const backupKept = switched && extra.original !== undefined && readText(backupFile) !== undefined;
	// What the draft drops from the config it replaces, and whether the draft file moved under the run.
	const dropped = keysDropped(extra.original, draft);
	if (dropped.length > 0) {
		const one = dropped.length === 1;
		warnings.push(
			`the draft replaces config.yml as a whole and does not have ${dropped.join(', ')}: ${one ? 'that key' : 'those keys'} ${switched ? (one ? 'is' : 'are') : one ? 'would be' : 'would be'} gone after the switch (${backupKept ? `the old file is kept as ${backupFile}; ` : switched ? '' : `the old file would be kept as ${backupFile}; `}to keep ${dropped.length === 1 ? 'it' : 'them'}: copy the current config.yml, add the strategy section, and use that file as the draft)`
		);
	}
	const moved = readText(draft.file) !== draft.text;
	if (moved) {
		warnings.push(
			`the draft file ${draft.file} changed on disk while the migration ran: the config written is the text read at the start (sha256 ${sha256(draft.text).slice(0, 12)}); run the migration again if the new text is the one you want`
		);
	}
	const accepted = result.inPlace?.acceptedDifferences;
	if (accepted !== undefined && accepted.length > 0) {
		warnings.push(
			`${accepted.length} difference(s) were ACCEPTED (--accept-differences) and are recorded in the journal ${result.journal}: the target holds those tasks as listed in inPlace.acceptedDifferences`
		);
	}
	return {
		...result,
		notes: [...result.notes, ...extra.notes],
		warnings: [...result.warnings, ...warnings, ...extra.releaseWarnings],
		inPlace: {
			switched: result.inPlace?.switched ?? false,
			idMapFile: result.inPlace?.idMapFile ?? idMapFile,
			...(accepted === undefined ? {} : { acceptedDifferences: accepted }),
			draft: draft.file,
			config: configFile,
			...(backupKept ? { backup: backupFile } : {}),
			...(switched && (backupKept || extra.original === undefined)
				? { rollback: rollbackText(extra.original, configFile, backupFile, result.from.kind, result.to.kind) }
				: {}),
			...(result.inPlace?.bookkeepingPending ? { bookkeepingPending: true } : {}),
			...(dropped.length === 0 ? {} : { configKeysDropped: dropped }),
			...(moved ? { draftChangedOnDisk: true } : {}),
			...extra.checks,
		},
	};
}

function rollbackText(
	snapshot: string | undefined,
	configFile: string,
	backupFile: string,
	kind: string,
	toKind: string
): string {
	return snapshot === undefined
		? `the project had no config file: delete ${configFile} to go back from ${toKind} to the previous storage (${kind}); its tasks were NOT deleted`
		: `copy ${backupFile} over ${configFile} to go back from ${toKind} to the previous storage (${kind}); its tasks were NOT deleted`;
}

/** Top-level keys of the config being replaced that the draft does not have. */
function keysDropped(snapshot: string | undefined, draft: Draft): string[] {
	if (snapshot === undefined) return [];
	let current: Record<string, unknown> | undefined;
	try {
		current = TaskConfigLoader.parseConfigText(snapshot, 'config.yml');
	} catch {
		// The project would not have opened with a config that does not parse: nothing to compare.
		return [];
	}
	return Object.keys(current ?? {}).filter(key => !Object.hasOwn(draft.layer.values, key));
}

/**
 * The run that replaced config.yml and stopped before saying so: every task is migrated and verified (the journal says), nothing is
 * read from a backend and nothing created. Marks the journal finished and rewrites the id map from it; the answer goes through
 * {@link assembleResult} like every other.
 */
function finishBookkeeping(input: Locked, journal: Journal): MigrationResult {
	const { project, idMapFile, journalFile, clock } = input;
	const state = journal.inPlace!;
	journal.inPlace = { ...state, switched: true };
	journal.status = 'completed';
	delete journal.lastError;
	delete journal.pending;
	journal.updatedAt = new Date(clock()).toISOString();
	const entries = Object.entries(journal.tasks);
	writeIdMap(
		idMapFile,
		entries.map(([from, entry]) => ({ from, to: entry.target }))
	);
	writeJournal(journalFile, journal);
	const total = entries.length;
	const event: TaskEvent = {
		name: 'onTasksMigrated',
		payload: {
			fromProjectId: project.id,
			fromProjectName: project.name,
			toProjectId: project.id,
			toProjectName: project.name,
			created: 0,
			resumed: 0,
			skipped: total,
			failed: 0,
			remaining: 0,
			complete: true,
			taskProjectId: project.id,
			taskProjectName: project.name,
			...(project.path === undefined ? {} : { taskProjectPath: project.path }),
		},
	};
	return {
		status: 'completed',
		dryRun: false,
		from: { id: project.id, name: project.name, kind: state.kinds.from },
		to: { id: project.id, name: project.name, kind: state.kinds.to },
		counts: { source: total, created: 0, resumed: 0, skipped: total, failed: 0, remaining: 0 },
		losses: [],
		blocking: [],
		notes: [
			`config.yml already was the draft: the earlier run stopped right after replacing it, so only its bookkeeping was completed (the journal said every task was migrated and verified; nothing was read from the storages)`,
		],
		warnings: [],
		estimate: { writes: 0, requests: 0, seconds: 0 },
		idMap: entries.map(([source, entry]) => ({ source, target: entry.target })),
		journal: journalFile,
		events: [event],
		inPlace: {
			switched: true,
			idMapFile,
			...(state.acceptedDifferences === undefined ? {} : { acceptedDifferences: state.acceptedDifferences }),
		},
	};
}
