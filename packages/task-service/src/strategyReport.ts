// `task strategy show`: what the project's config selects, as data (the adapters print it). Reads the config and the
// environment only: it opens no backend and creates nothing, so it works offline and never contacts a server.
import { BACKEND_CAPABILITY_NAMES } from '@wadeck-app/task-core';
import type { BackendCapabilities, BackendKind } from '@wadeck-app/task-core';

import type { DeclaredFills, TaskPluginRegistry } from './plugins/kinds.js';
import { loadProjectSetup } from './projectConfig.js';
import type { Fidelity } from './strategyConfig.js';
import { techniquesOf } from './strategyFills.js';
import type { ResolvedStrategy } from './strategyResolve.js';
import type { TaskStorage } from './storage.js';

/** Where a strategy command looks: the storage and identity of the project, plus the injectable parts (tests). */
export interface StrategyTarget {
	storage: TaskStorage;
	project: { id?: string; name: string; path?: string };
	globalConfigDir?: string;
	registry?: TaskPluginRegistry;
	env?: NodeJS.ProcessEnv;
}

export interface CapabilityRow {
	/** A capability name, or `linkTypes.<type>` when the link types are not all stored. */
	capability: string;
	/** `partial`: the plugin says the backend does it only in part (the detail says how). */
	state: 'native' | 'partial' | 'emulated' | 'unsupported';
	detail: string;
}

export interface FillRow {
	capability: string;
	technique: string;
	/** The fidelity the project accepted for this fill. */
	fidelity: Fidelity;
	/** How faithful the technique is by nature. */
	quality: 'exact' | 'approximate' | 'lossy';
}

/** A token the options point at: the NAME of an environment variable or the path of a file, and whether it is there. Never the value. */
export interface TokenRow {
	key: string;
	source: 'env' | 'file';
	name: string;
	/** Known for a variable only; a file is looked at by `strategy check`, not by `show`. */
	present?: boolean;
}

export interface StrategyReport {
	project: { id?: string; name: string; path?: string };
	/** The config file the strategy is read from (the project's own). */
	source: string;
	/** False when that file has no strategy section: the local default applies. */
	declared: boolean;
	type: string;
	ref: string;
	kind: BackendKind;
	summary: string;
	fidelity: Fidelity;
	fills: FillRow[];
	options: Record<string, unknown>;
	tokens: TokenRow[];
	transport?: { ref: string; options: Record<string, unknown> };
	capabilities: CapabilityRow[];
	dataDir: string;
}

const UNSUPPORTED: Partial<Record<keyof BackendCapabilities, unknown>> = {
	hierarchy: 'none',
	history: 'none',
	activity: 'none',
	delete: 'no',
	search: 'none',
	concurrency: 'none',
	labels: false,
	meta: false,
	comments: false,
	priority: false,
	assignee: false,
	claim: false,
	writes: 'none',
};

function detailOf(value: unknown): string {
	if (typeof value === 'boolean') return value ? 'yes' : 'no';
	return String(value);
}

function emulated(fill: DeclaredFills[string]): CapabilityRow['detail'] {
	return fill.use;
}

/**
 * The capability table: native, partial (the plugin has a `notes` entry for it), emulated by a declared fill, or unsupported (a
 * backend may refuse the operation; a fill may replace it). A note key is a capability name or `linkTypes.<type>`.
 */
export function describeCapabilities(
	capabilities: BackendCapabilities,
	fills: DeclaredFills,
	notes: Readonly<Record<string, string>> = {}
): CapabilityRow[] {
	const rows: CapabilityRow[] = [];
	const known = new Set<string>([
		...BACKEND_CAPABILITY_NAMES,
		'linkTypes.blockedBy',
		'linkTypes.duplicateOf',
		'linkTypes.causedBy',
	]);
	for (const key of Object.keys(notes)) {
		if (!known.has(key)) {
			throw new Error(
				`The strategy plugin describes "${key}", which is not a capability (a bug of the plugin; capabilities: ${[...known].join(', ')})`
			);
		}
	}
	const viaFill = (key: string, fallback: CapabilityRow): CapabilityRow => {
		const fill = fills[key];
		if (fill === undefined) {
			const note = notes[key];
			return note === undefined ? fallback : { capability: fallback.capability, state: 'partial', detail: note };
		}
		const quality = techniquesOf(key)?.[fill.use] ?? 'exact';
		return {
			capability: fallback.capability,
			state: 'emulated',
			detail: `via ${emulated(fill)} (${quality}, fidelity ${fill.fidelity})`,
		};
	};
	for (const name of BACKEND_CAPABILITY_NAMES) {
		if (name === 'linkTypes') {
			const stored = capabilities.linkTypes;
			const all = ['blockedBy', 'duplicateOf', 'causedBy'];
			if (all.every(type => (stored as readonly string[]).includes(type))) {
				rows.push({ capability: 'linkTypes', state: 'native', detail: stored.join(', ') });
				continue;
			}
			for (const type of [...all].sort()) {
				const has = (stored as readonly string[]).includes(type);
				rows.push(
					viaFill(`linkTypes.${type}`, {
						capability: `linkTypes.${type}`,
						state: has ? 'native' : 'unsupported',
						detail: has ? 'stored' : 'not stored',
					})
				);
			}
			continue;
		}
		const value = capabilities[name];
		const lacking = name in UNSUPPORTED && UNSUPPORTED[name] === value;
		rows.push(
			viaFill(name, { capability: name, state: lacking ? 'unsupported' : 'native', detail: detailOf(value) })
		);
	}
	return rows;
}

/** Every `tokenEnv` / `tokenFile` found in the options (any depth), with its dotted key under `strategy`. */
export function collectTokenKeys(
	options: unknown,
	prefix = 'strategy.options'
): Array<{ key: string; source: 'env' | 'file'; name: string }> {
	if (typeof options !== 'object' || options === null || Array.isArray(options)) return [];
	const found: Array<{ key: string; source: 'env' | 'file'; name: string }> = [];
	for (const [key, value] of Object.entries(options)) {
		if ((key === 'tokenEnv' || key === 'tokenFile') && typeof value === 'string') {
			found.push({ key: `${prefix}.${key}`, source: key === 'tokenEnv' ? 'env' : 'file', name: value });
		} else {
			found.push(...collectTokenKeys(value, `${prefix}.${key}`));
		}
	}
	return found;
}

export function fillRows(strategy: ResolvedStrategy): FillRow[] {
	return Object.entries(strategy.fills).map(([capability, fill]) => ({
		capability,
		technique: fill.use,
		fidelity: fill.fidelity,
		quality: techniquesOf(capability)?.[fill.use] ?? 'exact',
	}));
}

/**
 * The strategy of a project as the config selects it. Throws the config errors (a ConfigSchemaError naming the file and the key)
 * exactly as opening the project would.
 */
export function showStrategy(target: StrategyTarget): StrategyReport {
	const { strategy } = loadProjectSetup(target.storage, {
		globalConfigDir: target.globalConfigDir,
		registry: target.registry,
	});
	const env = target.env ?? process.env;
	return {
		project: target.project,
		source: strategy.source,
		declared: strategy.declared,
		type: strategy.type,
		ref: strategy.ref,
		kind: strategy.plugin.backendKind,
		summary: strategy.plugin.describe().summary,
		fidelity: strategy.fidelity,
		fills: fillRows(strategy),
		options: strategy.options,
		tokens: tokenRows(strategy, env),
		...(strategy.transport === undefined
			? {}
			: { transport: { ref: strategy.transport.ref, options: strategy.transport.options } }),
		capabilities: describeCapabilities(
			strategy.plugin.capabilitiesFor?.({}, strategy.options) ?? strategy.plugin.capabilities,
			strategy.fills,
			strategy.plugin.capabilityNotes
		),
		dataDir: target.storage.dataDir,
	};
}

function tokenRows(strategy: ResolvedStrategy, env: NodeJS.ProcessEnv): TokenRow[] {
	return collectTokenKeys(strategy.options).map(token => ({
		...token,
		...(token.source === 'env' ? { present: (env[token.name] ?? '') !== '' } : {}),
	}));
}
