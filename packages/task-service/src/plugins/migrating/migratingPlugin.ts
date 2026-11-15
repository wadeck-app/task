// The built-in strategy `migrating` (plugins.migrating.default, alias migrating): a strategy made of two others. `current` is where the
// tasks are, `new` is where they will go. Phase P2 of .claude/plans/2026-11-15_migrating-wrapper.md: writes route by the state of
// the task (in-a: current, moving: current then mirrored to new, in-b: new), a creation goes to `new`, and `moveTask` moves one task
// (the background worker that calls it is phase P3: migrationWorker.ts, started by startMigration.ts). It works for ANY pair of
// strategies and knows none by name: the host opens each side (`StrategyContext.openStrategy`), and the plugin reads only their
// capabilities, traits and locations.
import * as path from 'node:path';

import { BackendDataError, ProjectWriteLock } from '@wadeck-app/task-core';
import type { BackendCapabilities, BackendTraits } from '@wadeck-app/task-core';

import type {
	CheckLine,
	ProjectFacts,
	ReadNotice,
	StrategyContext,
	StrategyInstance,
	StrategyPlugin,
	SubStrategyViews,
} from '../kinds.js';
import { heldBackBy, intersectCapabilities, NOTHING_PROMISED } from './capabilityIntersection.js';
import { MigratingBackend } from './MigratingBackend.js';
import { MigrationJournal } from './migrationJournal.js';
import { migrationControlApi } from './migrationControlApi.js';
import type { MigrationToolkit } from './migrationToolkit.js';
import { runMigrationWorker } from './migrationWorker.js';
import { startMigration } from './startMigration.js';
import { nodeIndexFiles } from './nodeIndexFiles.js';
import { nodeWalFiles } from './nodeWalFiles.js';
import { nodeProcessFacts, nodeWorkerFiles } from './nodeWorkerFiles.js';
import { ROW_STATES, RoutingIndex } from './routingIndex.js';
import { combineTraits } from './traitsCombination.js';

const SLOTS = ['current', 'new'] as const;
const KNOWN_OPTIONS = [...SLOTS, 'budget'] as const;
const BUDGET_OPTIONS = ['requestsPerMinute'] as const;
/** Where the second side keeps what it stores itself, under the data folder of the project. */
const NEW_SIDE_FOLDER = path.join('migrating', 'new');
/** The routing index and its lock, under the data folder of the project. */
const INDEX_FOLDER = 'migrating';

function isMapping(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeFound(value: unknown): string {
	return Array.isArray(value) ? 'a list' : (JSON.stringify(value) ?? String(value));
}

function budgetProblem(budget: unknown): string | undefined {
	if (!isMapping(budget)) {
		return `budget: must be a mapping (for example { requestsPerMinute: 30 }), found ${describeFound(budget)}`;
	}
	for (const key of Object.keys(budget)) {
		if (!(BUDGET_OPTIONS as readonly string[]).includes(key)) {
			return `budget.${key}: unknown option (known: ${BUDGET_OPTIONS.join(', ')})`;
		}
	}
	const perMinute = budget['requestsPerMinute'];
	if (perMinute !== undefined && !(typeof perMinute === 'number' && Number.isInteger(perMinute) && perMinute > 0)) {
		return `budget.requestsPerMinute: must be a positive whole number (requests a minute the move may use), found ${describeFound(perMinute)}`;
	}
	return undefined;
}

function viewsOf(views: SubStrategyViews | undefined): {
	current: SubStrategyViews[string];
	next: SubStrategyViews[string];
} {
	const current = views?.['current'];
	const next = views?.['new'];
	if (current === undefined || next === undefined) {
		throw new Error(
			'the migrating strategy needs the resolved strategies of "current" and "new" to know what it can do (a caller did not pass them: this is a bug of the host)'
		);
	}
	return { current, next };
}

function capabilitiesOf(views: SubStrategyViews | undefined): ReturnType<typeof intersectCapabilities> {
	const { current, next } = viewsOf(views);
	return intersectCapabilities(current.capabilities, next.capabilities);
}

/** Lines of a side, named after it so the person sees which side a finding is about. */
function prefixed(side: string, lines: readonly CheckLine[]): CheckLine[] {
	return lines.map(line => ({ ...line, name: `${side}.${line.name}` }));
}

export const migratingPlugin: StrategyPlugin = {
	extensionPoint: 'strategy',
	backendKind: 'migrating',
	// Only the answer for a caller that does not know the sides, which never happens in a project: the sides' own capabilities decide.
	capabilities: NOTHING_PROMISED,
	// A fill enables what ONE backend cannot do natively; this one has no capability of its own to fill (declare the fill on the side).
	fillTechniques: {},
	strategySlots: SLOTS,
	migrationControl: migrationControlApi,

	validate(options) {
		for (const key of Object.keys(options)) {
			if (!(KNOWN_OPTIONS as readonly string[]).includes(key)) {
				return `${key}: unknown option for strategy "migrating" (known: ${KNOWN_OPTIONS.join(', ')})`;
			}
		}
		for (const slot of SLOTS) {
			const block = options[slot];
			if (block === undefined) {
				return `${slot}: required (a full strategy block: { type, options }, the strategy ${slot === 'current' ? 'the tasks are in now' : 'they will move to'})`;
			}
			if (!isMapping(block)) {
				return `${slot}: must be a full strategy block ({ type, options }), found ${describeFound(block)}`;
			}
		}
		return options['budget'] === undefined ? undefined : budgetProblem(options['budget']);
	},

	validateSubStrategies(_options, views) {
		const { current, next } = viewsOf(views);
		const { conflicts } = intersectCapabilities(current.capabilities, next.capabilities);
		if (conflicts.length > 0) {
			return `the two strategies cannot be combined: ${conflicts[0]} ("current" is ${current.ref}, "new" is ${next.ref})`;
		}
		if (current.location !== undefined && current.location === next.location) {
			return `new: the same storage as "current" (${current.location}): there is nothing to move`;
		}
		return undefined;
	},

	capabilitiesFor(_fills, _options, views): BackendCapabilities {
		return capabilitiesOf(views).capabilities;
	},

	traitsFor(_options, _fills, project: ProjectFacts, views): BackendTraits {
		const { current, next } = viewsOf(views);
		return combineTraits(current.traits(project), next.traits(project));
	},

	// Both storages, so a migration into either of them is refused as a migration into itself.
	locationOf(_options, views) {
		const { current, next } = viewsOf(views);
		const known = [current.location, next.location].filter(
			(location): location is string => location !== undefined
		);
		return known.length === 0 ? undefined : known.join(' + ');
	},

	describe() {
		return {
			summary:
				'A strategy made of two others: "current" is where the tasks are, "new" is where they will go. A new task is created in "new"; a task stays in "current" until it is moved (one task at a time, copied, verified, then switched in ONE step; its copy in "current" is kept), and every change to a task goes to the side that holds it. It offers only what both can do.',
			options: {
				current: 'a full strategy block ({ type, options }): where the tasks are now (required)',
				new: 'a full strategy block ({ type, options }): where the tasks will go (required); it must hold what "current" holds',
				budget: '{ requestsPerMinute: <whole number> }: the share of requests the background move may use (optional)',
			},
			snippet: [
				'strategy:',
				'    type: migrating',
				'    options:',
				'        current:',
				'            type: <the strategy the tasks are in now>',
				'            options: { ... }',
				'        new:',
				'            type: <the strategy they will move to>',
				'            options: { ... }',
				'        budget:',
				'            requestsPerMinute: 30',
			].join('\n'),
		};
	},

	async create(options, context: StrategyContext) {
		if (context.openStrategy === undefined) {
			throw new Error(
				`${context.source}: strategy.options.current and strategy.options.new are not available to the migrating strategy (the host did not open them); this is a bug of the host`
			);
		}
		const views = context.subStrategies;
		const { current: currentView, next: nextView } = viewsOf(views);
		const { capabilities } = intersectCapabilities(currentView.capabilities, nextView.capabilities);
		const held = heldBackBy({ current: currentView.capabilities, new: nextView.capabilities }, capabilities);

		if (context.copyTasks === undefined) {
			throw new Error(
				`${context.source}: the host gave the migrating strategy no way to copy a task between its two strategies; this is a bug of the host`
			);
		}
		const current = await context.openStrategy('current');
		const next = await context.openStrategy('new', { dataSubdir: NEW_SIDE_FOLDER });
		const facts = {
			statuses: context.statuses,
			types: context.types,
			...(context.priorities === undefined ? {} : { priorities: [...context.priorities] }),
		};
		const budget = options['budget'];
		const perMinute = isMapping(budget) ? (budget['requestsPerMinute'] as number | undefined) : undefined;

		// The routing index lives in the data folder of the project; writes go through the host's atomic writer and the index lock.
		const indexDir = path.join(context.dataDir, INDEX_FOLDER);
		const routingIndex = new RoutingIndex({
			file: path.join(indexDir, 'index.json'),
			files: nodeIndexFiles(context.writeFile),
			lock: new ProjectWriteLock(path.join(indexDir, 'index.lock')),
		});
		const journal = new MigrationJournal({
			dir: indexDir,
			files: nodeWalFiles(context.writeFile),
			onLogProblem: text => context.log('warn', text),
		});
		const copier = context.copyTasks(
			{ slot: 'current', backend: current.backend },
			{ slot: 'new', backend: next.backend }
		);
		const nextTraits = nextView.traits(facts);
		const backend = new MigratingBackend({
			current: current.backend,
			next: next.backend,
			index: routingIndex,
			capabilities,
			heldBackBy: held,
			statuses: context.statuses.map(status => status.name),
			nextTraits,
			journal,
			copier,
		});
		// What the start of a migration and its background worker use: the sides' port, the index, the journal, the files of the worker.
		const processFacts = nodeProcessFacts();
		const toolkit: MigrationToolkit = {
			dir: indexDir,
			files: nodeWorkerFiles(context.writeFile),
			current: current.backend,
			nextCapabilities: next.backend.capabilities,
			nextTraits,
			index: routingIndex,
			journal,
			copier,
			moves: backend.moves,
			...(perMinute === undefined ? {} : { budget: { requestsPerMinute: perMinute } }),
			...processFacts,
		};
		// What a crash left half done is settled before the first command runs; what was done is said, loudly.
		const recovered = await backend.moves.recover();
		for (const action of recovered.actions) context.log('warn', `migrating: recovery: ${action}`);
		for (const open of recovered.unsettled) {
			context.log(
				'error',
				`migrating: ${open.task === '' ? 'an interrupted creation' : `task ${open.task}`} could not be settled: ${open.reason}; writes to it are refused until the next opening settles it`
			);
		}
		const instance: StrategyInstance = {
			backend,
			migration: {
				dir: toolkit.dir,
				start: input => startMigration(toolkit, input),
				runWorker: options => runMigrationWorker(toolkit, options),
			},
			describe: () => [
				'state: writes follow the routing index (in-a: "current", moving: "current" then mirrored to "new", in-b: "new"); a new task is created in "new"',
				...current.describe().map(line => `current: ${line}`),
				...next.describe().map(line => `new: ${line}`),
				perMinute === undefined
					? 'budget: not set'
					: `budget: ${perMinute} requests a minute for the background move`,
			],
			check: async () => {
				const index = indexLine(routingIndex, path.join(indexDir, 'index.json'));
				const routed = index.status === 'ok' && !index.text.startsWith('no task is routed');
				// A damaged index is reported by its own line; the counts need it readable.
				const rows = index.status === 'error' ? [] : routingIndex.snapshot().rows;
				const count = (state: string): number => rows.filter(row => row.state === state).length;
				const stale = rows.filter(row => row.state === 'moving' && row.stale === true).length;
				let open: number;
				try {
					open = backend.moves.openTransactions();
				} catch (error) {
					return [
						{
							name: 'state',
							status: 'error',
							text: error instanceof Error ? error.message : String(error),
							fix: 'The write-ahead log is damaged: restore it from a backup; do not delete it while a move is unfinished.',
						},
						index,
					];
				}
				const unsettled = backend.moves.unsettled().size;
				const lines: CheckLine[] = [
					{
						name: 'state',
						status: unsettled > 0 ? 'error' : stale > 0 || open > 0 ? 'warn' : 'ok',
						text: `${routed ? 'writes follow the routing index' : 'no task is routed yet'}: ${count('moving')} moving (${stale} stale copies), ${count('in-b')} in "new", ${count('deleted')} deleted; ${open} unfinished transaction(s) in the write-ahead log, ${unsettled} that recovery could not settle`,
						fix:
							unsettled > 0
								? 'Fix the problem named in the task log (line "could not be settled"), then open the project again: recovery runs at the opening.'
								: stale > 0 || open > 0
									? 'A move or a recovery settles them: moves.moveTask / moves.catchUp, or open the project again. Nothing is lost: the copies in "current" are kept.'
									: 'Nothing to do. To move the tasks in the background: task strategy migrate start (see task strategy migrate status).',
					},
					index,
				];
				lines.push(...prefixed('current', await current.check()), ...prefixed('new', await next.check()));
				return lines;
			},
			takeNotices: () => [
				...(current.takeNotices?.() ?? []).map((notice): ReadNotice => ({
					...notice,
					text: `current: ${notice.text}`,
				})),
				...(next.takeNotices?.() ?? []).map((notice): ReadNotice => ({
					...notice,
					text: `new: ${notice.text}`,
				})),
			],
			// The host releases both sides with this instance.
			dispose: () => Promise.resolve(),
		};
		return instance;
	},
};

/** The `index` line of the check: what the routing index holds, or why it cannot be read (never fixed by recreating it). */
function indexLine(index: RoutingIndex, file: string): CheckLine {
	try {
		const { rows } = index.snapshot();
		if (rows.length === 0) {
			return { name: 'index', status: 'ok', text: `no task is routed away from current (${file} has no row)` };
		}
		const counts = ROW_STATES.map(state => `${state} ${rows.filter(row => row.state === state).length}`);
		return {
			name: 'index',
			status: 'ok',
			text: `${rows.length} task(s) in the routing index: ${counts.join(', ')}`,
		};
	} catch (error) {
		const { message, hint } = describeIndexProblem(error);
		return { name: 'index', status: 'error', text: message, ...(hint === undefined ? {} : { fix: hint }) };
	}
}

function describeIndexProblem(error: unknown): { message: string; hint?: string } {
	if (error instanceof BackendDataError) return { message: error.message, hint: error.hint };
	return { message: error instanceof Error ? error.message : String(error) };
}
