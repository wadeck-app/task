// Turns the structure-checked strategy section of the project in effect into a plugin and its options (design 3A.3, 4.1).
// Registry lookup only: a type the schema knows (github, gitlab, remote) but no plugin implements is a loud error, never `local`.
import { BACKEND_KINDS } from '@wadeck-app/task-core';

import { PluginLookupError, PluginSlotError, resolveSlot } from './plugin-host/index.js';
import type { ResolvedSlot } from './plugin-host/index.js';
import type {
	DeclaredFills,
	ProjectFacts,
	StrategyPlugin,
	TaskPluginRegistry,
	TransportPlugin,
} from './plugins/kinds.js';
import { StrategyConfigError } from './strategyConfig.js';
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
	project?: ProjectFacts
): ResolvedStrategy {
	const wanted = section ?? { type: undefined, fidelity: 'strict' as const, options: {}, fills: {} };
	const type = wanted.type ?? DEFAULT_STRATEGY_TYPE;
	const declaredKind = declaredKindOf(type);
	const installed = isInstalled(registry, type);

	// A remote strategy carries a transport slot: check it first, so a typo in it is reported rather than "not installed".
	let transport: ResolvedSlot<TransportPlugin> | undefined;
	if (declaredKind === 'remote' && wanted.options['transport'] !== undefined) {
		try {
			const slot = wanted.options['transport'];
			transport = resolveSlot(
				registry,
				'transport',
				typeof slot === 'object' && slot !== null && !Array.isArray(slot) ? slot : {},
				{ file: source, path: 'strategy.options.transport' },
				'plain-http'
			);
		} catch (error) {
			toConfigError(error);
		}
	}

	if (!installed && declaredKind !== undefined) {
		throw new StrategyConfigError(
			source,
			'strategy.type',
			`strategy type ${declaredKind} is declared but no plugin is installed; built-in types: ${registry
				.list('strategy')
				.map(entry => entry.aliases[0] ?? entry.ref)
				.join(', ')}`,
			`Set strategy.type to a built-in type (${registry
				.list('strategy')
				.map(entry => entry.aliases[0] ?? entry.ref)
				.join(
					', '
				)}) or remove the strategy section; ${declaredKind} arrives in a later stage of the storage design.`
		);
	}

	let resolved: ResolvedSlot<StrategyPlugin>;
	try {
		resolved = resolveSlot(
			registry,
			'strategy',
			{ type, options: wanted.options },
			{ file: source, path: 'strategy' }
		);
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
				`strategy.options.fills.${key}`,
				`the "${name}" strategy does not implement the fill "${fill.use}" for ${key.split('.')[0]} ` +
					`(${describeImplemented(resolved.plugin, key, implemented)})`
			);
		}
	}

	const projectProblem =
		project === undefined ? undefined : resolved.plugin.validateForProject?.(wanted.options, project);
	if (projectProblem !== undefined) {
		const keyed = /^([A-Za-z][A-Za-z0-9_.-]*): ([\s\S]+)$/.exec(projectProblem);
		throw keyed === null
			? new StrategyConfigError(source, 'strategy.options', projectProblem)
			: new StrategyConfigError(source, `strategy.options.${keyed[1]}`, keyed[2]!);
	}

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
	};
}
