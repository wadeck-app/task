// `task migrate` over two projects of the shared registry: opens each project the way every command does (its own config chooses the
// backend), hands the two backends to the engine, and releases both. Registering, moving and removing projects belongs to the project
// CLI, so a project that is not registered is not a source nor a target.
import { NO_TRAITS } from '@wadeck-app/task-core';

import type { TaskServiceContext } from '../context.js';
import { eventsRaisedByServer } from '../eventsRaisedByServer.js';
import { openResolvedProject } from '../openContext.js';
import type { TaskPluginRegistry } from '../plugins/kinds.js';
import { projectFactsOf } from '../projectConfig.js';
import type { ResolvedProject } from '../resolveProject.js';
import { MigrationRefusedError } from './migrateErrors.js';
import { runMigration } from './migrateRun.js';
import type { RunMigrationInput } from './migrateRun.js';
import type { MigrationEndpoint, MigrationOptions, MigrationProgress, MigrationResult } from './migrateTypes.js';

export interface MigrateProjectsInput {
	from: ResolvedProject;
	to: ResolvedProject;
	options: MigrationOptions;
	/** The command that continues a stopped run (the CLI builds it from what was typed). */
	resumeCommand: string;
	onProgress?: (progress: MigrationProgress) => void;
	/** Global config directory (global hooks and defaults). Default: the config loader's own. */
	globalConfigDir?: string;
	registry?: TaskPluginRegistry;
	/** The environment plugins read tokens from. Default `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** Tests: clock, pid and process check of the engine. */
	engine?: Pick<RunMigrationInput, 'now' | 'pid' | 'isAlive'>;
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

function locationOf(ctx: TaskServiceContext): string | undefined {
	return ctx.strategy?.plugin.locationOf?.(ctx.strategy.options);
}

/**
 * Migrates every task of `from` into `to`. Throws what the engine throws when it cannot start (MigrationRefusedError,
 * MigrationStateError), a ConfigSchemaError naming the config file of a project that does not load, and the errors of the registry.
 * Everything that happens once the run has started is in the result.
 */
export async function migrateProjects(input: MigrateProjectsInput): Promise<MigrationResult> {
	const { from, to } = input;
	if (from.id === to.id) {
		throw new MigrationRefusedError(
			`the source and the target are the same project (${from.name})`,
			'Migrate between two registered projects: --from <source project> --to <other project>. Register the second with the project CLI: project add <dir>.'
		);
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
	try {
		// The source is read as it is now: no cache.
		const source = openResolvedProject(from, input.globalConfigDir, { ...open, freshReads: true });
		contexts.push(source);
		// A migration is not a user editing tasks: a remote target's server is asked to raise nothing for these writes unless --emit-events.
		const target = openResolvedProject(to, input.globalConfigDir, {
			...open,
			...(input.options.emitEvents ? {} : { suppressEvents: true }),
		});
		contexts.push(target);
		targetRaisedByServer = eventsRaisedByServer(target);

		const sourceWhere = locationOf(source);
		if (sourceWhere !== undefined && sourceWhere === locationOf(target)) {
			throw new MigrationRefusedError(
				`the source (${from.name}) and the target (${to.name}) are the same repository: ${sourceWhere}`,
				'Migrate into a project whose strategy points elsewhere (another repository, or the local files).'
			);
		}
		result = await runMigration({
			source: endpointOf(source, from),
			target: endpointOf(target, to),
			journalDir: to.storage.dataDir,
			options: input.options,
			resumeCommand: input.resumeCommand,
			...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
			...input.engine,
		});
	} catch (error) {
		failed = true;
		failure = error;
	}

	// Both projects are released whatever happened; a release that fails is said, it never hides the result or the error.
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
	if (targetRaisedByServer) result = leaveEventsToServer(result, to, input.options.emitEvents);
	return releaseWarnings.length === 0 ? result : { ...result, warnings: [...result.warnings, ...releaseWarnings] };
}

/**
 * The events of a remote project are raised by its server (capabilities.events): the engine built the summary (and, with --emit-events,
 * the per-task events) for the target, but delivering them from this machine would raise them twice, with the paths of the wrong machine.
 * They are dropped, and the one fact the person loses is said.
 */
function leaveEventsToServer(result: MigrationResult, to: ResolvedProject, emitted: boolean): MigrationResult {
	if (result.events.length === 0) return result;
	const note = `the events of project ${to.name} are raised by its server: ${
		emitted
			? 'the server raised the per-task events of the writes of this run (as it does for any change, the migratedFrom marker included)'
			: 'the server raised none for the writes of this run'
	}, and the summary event onTasksMigrated is not raised for a remote target`;
	return { ...result, events: [], warnings: [...result.warnings, note] };
}
