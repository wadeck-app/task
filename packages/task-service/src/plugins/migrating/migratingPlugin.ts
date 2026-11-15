// The built-in strategy `migrating` (plugins.migrating.default, alias migrating): a strategy made of two others. `current` is where the
// tasks are, `new` is where they will go. Phase P0 of .claude/plans/2026-11-15_migrating-wrapper.md: the state `in-a` only. Every
// operation goes to `current`; `new` is opened and checked and nothing is written to it; no task moves yet. It works for ANY pair of
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
import { nodeIndexFiles } from './nodeIndexFiles.js';
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
				'A strategy made of two others: "current" is where the tasks are, "new" is where they will go. In this version every operation goes to "current"; "new" is opened and checked, nothing is written to it and no task moves yet. It offers only what both can do.',
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

		const current = await context.openStrategy('current');
		const next = await context.openStrategy('new', { dataSubdir: NEW_SIDE_FOLDER });
		const budget = options['budget'];
		const perMinute = isMapping(budget) ? (budget['requestsPerMinute'] as number | undefined) : undefined;

		// The routing index lives in the data folder of the project; writes go through the host's atomic writer and the index lock.
		const indexDir = path.join(context.dataDir, INDEX_FOLDER);
		const routingIndex = new RoutingIndex({
			file: path.join(indexDir, 'index.json'),
			files: nodeIndexFiles(context.writeFile),
			lock: new ProjectWriteLock(path.join(indexDir, 'index.lock')),
		});
		const backend = new MigratingBackend({
			current: current.backend,
			next: next.backend,
			index: routingIndex,
			capabilities,
			heldBackBy: held,
			statuses: context.statuses.map(status => status.name),
		});
		const instance: StrategyInstance = {
			backend,
			describe: () => [
				'state: in-a (every operation goes to "current"; "new" is opened and checked, nothing is written to it)',
				...current.describe().map(line => `current: ${line}`),
				...next.describe().map(line => `new: ${line}`),
				perMinute === undefined
					? 'budget: not set'
					: `budget: ${perMinute} requests a minute for the background move`,
			],
			check: async () => {
				const index = indexLine(routingIndex, path.join(indexDir, 'index.json'));
				const routed = index.status === 'ok' && !index.text.startsWith('no task is routed');
				const lines: CheckLine[] = [
					{
						name: 'state',
						status: 'warn',
						text: routed
							? 'reads follow the routing index (see the index line); nothing is written to "new" and no task is moved by this version'
							: 'in-a: every operation goes to "current"; "new" is opened and checked, nothing is written to it and no task is moved',
						fix: 'This version does not move tasks yet. Keep this section to validate the pair, or remove it (keep only the "current" block as the strategy) to stop using it.',
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
