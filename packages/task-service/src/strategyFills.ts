// The fill techniques of the storage design (2A.3): how a capability a backend lacks can be emulated with a feature it has,
// and how faithful each technique is. Config validation checks `strategy.options.fills` against this table; what a backend
// really implements is declared by its plugin (`StrategyPlugin.fillTechniques`). Keys are capability names of task-core.
import type { BackendCapabilities } from '@wadeck-app/task-core';

/** exact = indistinguishable from local; approximate = same data, concurrent human edits can alter it; lossy = part of it is lost. */
export type FillFidelity = 'exact' | 'approximate' | 'lossy';

export const FILL_TECHNIQUES = {
	status: { label: 'exact', 'projects-field': 'exact', 'scoped-label': 'exact' },
	meta: { labels: 'exact', 'body-block': 'approximate', sidecar: 'approximate' },
	hierarchy: { native: 'exact', tasklist: 'lossy', 'work-item': 'exact', epic: 'exact' },
	delete: { tombstone: 'approximate', hard: 'exact' },
	history: { derived: 'approximate' },
	activity: { native: 'approximate' },
	search: { index: 'approximate' },
	ids: { 'keep-origin': 'lossy' },
} as const satisfies Partial<Record<keyof BackendCapabilities, Record<string, FillFidelity>>>;

/** `linkTypes` is filled per link type (`fills.linkTypes.causedBy`). */
export const LINK_FILL_TECHNIQUES: Readonly<Record<string, Readonly<Record<string, FillFidelity>>>> = {
	blockedBy: { native: 'exact', 'body-block': 'approximate', 'relates-block': 'approximate' },
	duplicateOf: {
		'duplicate-marker': 'approximate',
		'quick-action': 'approximate',
		relate: 'approximate',
		'relate-block': 'approximate',
	},
	causedBy: { 'relate-block': 'approximate' },
};

const BY_KEY: Record<string, Readonly<Record<string, FillFidelity>>> = {
	...FILL_TECHNIQUES,
	...Object.fromEntries(
		Object.entries(LINK_FILL_TECHNIQUES).map(([type, techniques]) => [`linkTypes.${type}`, techniques])
	),
};

/** Every key a fill can be declared under: a capability name, or `linkTypes.<type>`. Sorted. */
export function fillKeys(): string[] {
	return Object.keys(BY_KEY).sort();
}

/** The capability names that have fills (`linkTypes` included), sorted. */
export function fillableCapabilities(): string[] {
	return [...Object.keys(FILL_TECHNIQUES), 'linkTypes'].sort();
}

/** The techniques of one fill key (`meta`, `linkTypes.causedBy`) with their fidelity; undefined for a key with no fill. */
export function techniquesOf(key: string): Readonly<Record<string, FillFidelity>> | undefined {
	return BY_KEY[key];
}
