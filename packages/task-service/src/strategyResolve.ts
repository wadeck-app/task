// Turns the structure-checked strategy section of the project in effect into a plugin and its options (design 3A.3, 4.1).
// Registry lookup only: a type the schema knows (github, gitlab, remote) but no plugin implements is a loud error, never `local`.
import { BACKEND_KINDS, NO_TRAITS } from '@wadeck-app/task-core';

import { PluginLookupError, PluginSlotError, resolveSlot } from './plugin-host/index.js';
import type { ResolvedSlot } from './plugin-host/index.js';
import type {
	DeclaredFills,
	ProjectFacts,
	SubStrategyView,
	SubStrategyViews,
	StrategyPlugin,
	TaskPluginRegistry,
	TransportPlugin,
} from './plugins/kinds.js';
import { parseStrategySection, StrategyConfigError } from './strategyConfig.js';
import type { Fidelity, StrategySection } from './strategyConfig.js';

/** The default of a project without a strategy section (or without `type`). */
export const DEFAULT_STRATEGY_TYPE = 'local';

export interface ResolvedStrategy {
	/** The project's own config file: the section lives there. */
	source: string;
	/** False when the file has no strategy section (the default applies, silently, exactly as before the section existed). */
	declared: boolean;
	/** As written, or `local`. */
	type: string;
	ref: string;
	plugin: StrategyPlugin;
	fidelity: Fidelity;
	fills: DeclaredFills;
	/** The options the plugin validated (no `fills`). */
	options: Record<string, unknown>;
	/** The validated `options.transport` slot of a remote strategy. */
	transport?: ResolvedSlot<TransportPlugin>;
	/** The resolved strategy blocks of a meta-plugin by slot (the plugin's `strategySlots` that are written). Absent for any other plugin. */
	subs?: Record<string, ResolvedStrategy>;
}

function toConfigError(error: unknown): never {
	if (error instanceof PluginSlotError)
		throw new StrategyConfigError(error.file, error.path, error.problem, error.hint);
	throw error;
}

function declaredKindOf(type: string): string | undefined {
	return BACKEND_KINDS.find(kind => type === kind || type === `plugins.${kind}.default`);
}

function isInstalled(registry: TaskPluginRegistry, type: string): boolean {
	try {
		registry.lookup(type, 'strategy');
		return true;
	} catch (error) {
		if (error instanceof PluginLookupError) return false;
		throw error;
	}
}

/** What a plugin does implement, said where a fill it lacks is refused. */
function describeImplemented(plugin: StrategyPlugin, key: string, forKey: readonly string[]): string {
	if (forKey.length > 0) return `it implements: ${forKey.join(', ')}`;
	const all = Object.entries(plugin.fillTechniques).filter(([, techniques]) => techniques.length > 0);
	if (all.length === 0) return 'it implements none: every capability is native';
	return `it implements no fill for ${key.split('.')[0]}; its fills: ${all.map(([capability, techniques]) => `${capability}: ${techniques.join(', ')}`).join('; ')}`;
}

function displayName(registry: TaskPluginRegistry, ref: string): string {
	const entry = registry.list('strategy').find(candidate => candidate.ref === ref);
	return entry?.aliases[0] ?? ref;
}

/**
 * Resolves `section` (undefined: the project has none) written in `source`. Throws StrategyConfigError naming the file and the dotted
 * key: unknown or not installed type, an option the plugin refuses, a fill the plugin does not implement, a bad transport slot.
 * With `project` (the statuses and types of the config), the plugin also checks its options against them (`validateForProject`).
 */
export function resolveStrategy(
	section: StrategySection | undefined,
	source: string,
	registry: TaskPluginRegistry,
	project?: ProjectFacts,
	/** The dotted path of the section in the file: `strategy`, or `strategy.options.<slot>` for a block held by a meta-plugin. */
	base = 'strategy',
	/** The section is held by a meta-plugin: another meta-plugin is refused there (no nesting in v1). */
	nested = false
): ResolvedStrategy {
	const wanted = section ?? { type: undefined, fidelity: 'strict' as const, options: {}, fills: {} };
	const type = wanted.type ?? DEFAULT_STRATEGY_TYPE;
	const declaredKind = declaredKindOf(type);
	const installed = isInstalled(registry, type);
	if (nested && installed && registry.lookup(type, 'strategy').strategySlots !== undefined) {
		throw new StrategyConfigError(
			source,
			`${base}.type`,
			`"${type}" holds other strategies and cannot be nested in another one`,
			'Use a plain strategy in this slot (one that stores the tasks itself); strategies that hold other strategies cannot be combined in this version.'
		);
	}

	// A remote strategy carries a transport slot: check it first, so a typo in it is reported rather than "not installed".
	let transport: ResolvedSlot<TransportPlugin> | undefined;
	if (declaredKind === 'remote' && wanted.options['transport'] !== undefined) {
		try {
			const slot = wanted.options['transport'];
			transport = resolveSlot(
				registry,
				'transport',
				typeof slot === 'object' && slot !== null && !Array.isArray(slot) ? slot : {},
				{ file: source, path: `${base}.options.transport` },
				'plain-http'
			);
		} catch (error) {
			toConfigError(error);
		}
	}

	if (!installed && declaredKind !== undefined) {
		throw new StrategyConfigError(
			source,
			`${base}.type`,
			`strategy type ${declaredKind} is declared but no plugin is installed; built-in types: ${registry
				.list('strategy')
				.map(entry => entry.aliases[0] ?? entry.ref)
				.join(', ')}`,
			`Set ${base}.type to a built-in type (${registry
				.list('strategy')
				.map(entry => entry.aliases[0] ?? entry.ref)
				.join(
					', '
				)}) or remove the strategy section; ${declaredKind} arrives in a later stage of the storage design.`
		);
	}

	let resolved: ResolvedSlot<StrategyPlugin>;
	try {
		resolved = resolveSlot(registry, 'strategy', { type, options: wanted.options }, { file: source, path: base });
	} catch (error) {
		if (error instanceof PluginSlotError && error.problem.startsWith('unknown strategy plugin')) {
			const missing = BACKEND_KINDS.filter(kind => !isInstalled(registry, kind));
			throw new StrategyConfigError(
				source,
				error.path,
				error.problem,
				`${error.hint ?? ''}${missing.length === 0 ? '' : `. Declared but not installed: ${missing.join(', ')}.`}`
			);
		}
		return toConfigError(error);
	}

	const name = displayName(registry, resolved.ref);
	for (const [key, fill] of Object.entries(wanted.fills)) {
		const implemented = resolved.plugin.fillTechniques[key] ?? [];
		if (!implemented.includes(fill.use)) {
			throw new StrategyConfigError(
				source,
				`${base}.options.fills.${key}`,
				`the "${name}" strategy does not implement the fill "${fill.use}" for ${key.split('.')[0]} ` +
					`(${describeImplemented(resolved.plugin, key, implemented)})`
			);
		}
	}

	// The strategy blocks of a meta-plugin: checked like a project's own section, under their own dotted key.
	let subs: Record<string, ResolvedStrategy> | undefined;
	const slots = resolved.plugin.strategySlots;
	if (slots !== undefined) {
		subs = {};
		for (const slot of slots) {
			const block = wanted.options[slot];
			if (block === undefined) continue;
			subs[slot] = resolveSubStrategy(block, source, registry, project, `${base}.options.${slot}`);
		}
	}

	const asKeyed = (problem: string): StrategyConfigError => {
		const keyed = KEYED_PROBLEM.exec(problem);
		return keyed === null
			? new StrategyConfigError(source, `${base}.options`, problem)
			: new StrategyConfigError(source, `${base}.options.${keyed[1]}`, keyed[2]!);
	};
	const views = subs === undefined ? undefined : viewsOf(subs);
	if (views !== undefined) {
		const combined = resolved.plugin.validateSubStrategies?.(wanted.options, views);
		if (combined !== undefined) throw asKeyed(combined);
	}
	const projectProblem =
		project === undefined ? undefined : resolved.plugin.validateForProject?.(wanted.options, project, views);
	if (projectProblem !== undefined) throw asKeyed(projectProblem);

	return {
		source,
		declared: section !== undefined,
		type,
		ref: resolved.ref,
		plugin: resolved.plugin,
		fidelity: wanted.fidelity,
		fills: wanted.fills,
		options: wanted.options,
		...(transport === undefined ? {} : { transport }),
		...(subs === undefined ? {} : { subs }),
	};
}

const KEYED_PROBLEM = /^([A-Za-z][A-Za-z0-9_.-]*): ([\s\S]+)$/;

/** One option of a meta-plugin holding a strategy block: parsed like a project section (its path in the messages), then resolved. */
function resolveSubStrategy(
	block: unknown,
	source: string,
	registry: TaskPluginRegistry,
	project: ProjectFacts | undefined,
	path: string
): ResolvedStrategy {
	const section = parseStrategySection(source, block, path);
	if (section === undefined || section.type === undefined) {
		const registered = registry.list('strategy').map(entry => entry.aliases[0] ?? entry.ref);
		throw new StrategyConfigError(
			source,
			`${path}.type`,
			'required (there is no default for a strategy held by another one)',
			`Registered strategy plugins: ${registered.join(', ')}`
		);
	}
	return resolveStrategy(section, source, registry, project, path, true);
}

function viewsOf(subs: Record<string, ResolvedStrategy>): SubStrategyViews {
	return Object.fromEntries(
		Object.entries(subs).map(([slot, sub]): [string, SubStrategyView] => [
			slot,
			{
				slot,
				type: sub.type,
				ref: sub.ref,
				kind: sub.plugin.backendKind,
				capabilities: sub.plugin.capabilitiesFor?.(sub.fills, sub.options) ?? sub.plugin.capabilities,
				traits: facts => sub.plugin.traitsFor?.(sub.options, sub.fills, facts) ?? NO_TRAITS,
				location: sub.plugin.locationOf?.(sub.options),
			},
		])
	);
}

/** The views of the sub-strategies of a resolved strategy, as the hooks of its plugin take them; empty for a plugin without slots. */
export function subStrategyViews(strategy: ResolvedStrategy): SubStrategyViews {
	return strategy.subs === undefined ? {} : viewsOf(strategy.subs);
}
