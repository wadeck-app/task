// What a strategy that holds two others may promise: only what both do, in the weaker form where they differ. A rule per capability of
// task-core (the type of the table makes a missing one a compile error, and a test lists them), so a capability added to task-core
// cannot be forgotten here. The rules read values only: nothing here knows what kind of storage a side is.
import type { BackendCapabilities } from '@wadeck-app/task-core';

/** One capability of the intersection: its value, and why the two sides cannot be combined when they cannot (never a guess). */
interface RuleResult<V> {
	value: V;
	conflict?: string;
}

type Rule<K extends keyof BackendCapabilities> = (
	a: BackendCapabilities,
	b: BackendCapabilities
) => RuleResult<NonNullable<BackendCapabilities[K]>>;

/** The weaker of two values of an ordered scale (first = weakest). */
function weaker<K extends keyof BackendCapabilities>(
	field: K,
	scale: readonly NonNullable<BackendCapabilities[K]>[]
): Rule<K> {
	return (a, b) => {
		const left = a[field] as NonNullable<BackendCapabilities[K]>;
		const right = b[field] as NonNullable<BackendCapabilities[K]>;
		return { value: scale.indexOf(left) <= scale.indexOf(right) ? left : right };
	};
}

/** Both sides, or no claim: an optional capability a side leaves out is false (the port's reading of absent). */
function both<K extends 'labels' | 'meta' | 'comments' | 'priority' | 'assignee' | 'claim' | 'indexedGraph'>(
	field: K
): Rule<K> {
	return (a, b) => ({ value: (a[field] === true && b[field] === true) as NonNullable<BackendCapabilities[K]> });
}

/**
 * History and activity: the weaker form, but a side with none and a side with something cannot be combined (the wrapper would have to
 * strip what the other side records from every record it answers).
 */
function weakerNotStripped<K extends 'history' | 'activity'>(
	field: K,
	scale: readonly NonNullable<BackendCapabilities[K]>[]
): Rule<K> {
	const pick = weaker(field, scale);
	return (a, b) => {
		const result = pick(a, b);
		const none = scale[0];
		const sides = [a[field], b[field]];
		if (sides.includes(none) && sides.some(side => side !== none)) {
			return {
				...result,
				conflict: `${field}: one side records none and the other records something (${String(a[field])} and ${String(b[field])}); the records would have to be stripped, which is not supported`,
			};
		}
		return result;
	};
}

export const INTERSECTION_RULES: { [K in keyof BackendCapabilities]-?: Rule<K> } = {
	hierarchy: weaker('hierarchy', ['none', 'limited', 'unlimited']),
	// The types both sides store, in the order of the first side.
	linkTypes: (a, b) => ({ value: a.linkTypes.filter(type => b.linkTypes.includes(type)) }),
	status: weaker('status', ['open-closed', 'mapped', 'free']),
	history: weakerNotStripped('history', ['none', 'derived', 'stored']),
	activity: weakerNotStripped('activity', ['none', 'native', 'stored']),
	// A removal and a closing are different promises: only the same one survives.
	delete: (a, b) => ({ value: a.delete === b.delete ? a.delete : 'no' }),
	search: weaker('search', ['none', 'native', 'index']),
	concurrency: weaker('concurrency', ['none', 'check-then-write', 'revision']),
	// A prefix lookup needs ids task generates, on both sides.
	ids: (a, b) => ({ value: a.ids === 'generated' && b.ids === 'generated' ? 'generated' : 'assigned' }),
	labels: both('labels'),
	meta: both('meta'),
	comments: both('comments'),
	// A migrating project never attaches images (the copy to the other side would upload them twice): MigratingBackend refuses them.
	commentAttachments: () => ({ value: false }),
	priority: both('priority'),
	assignee: both('assignee'),
	claim: both('claim'),
	writes: (a, b) => ({ value: a.writes === 'full' && b.writes === 'full' ? 'full' : 'none' }),
	indexedGraph: both('indexedGraph'),
	// On a conflict the value is only there to keep the answer total (and commutative): the caller refuses the pair.
	events: (a, b) => ({
		value: a.events === b.events ? a.events : 'client',
		...(a.events === b.events
			? {}
			: {
					conflict:
						'events: one side raises the queue events of a change in this process and the other by a server; no event could be raised exactly once',
				}),
	}),
};

export interface CapabilityIntersection {
	capabilities: BackendCapabilities;
	/** What cannot be combined, one sentence each starting with the capability. The capabilities are then not usable. */
	conflicts: string[];
}

/** The capabilities both sides have, in the weaker form where they differ. Pure; commutative apart from the order of link types. */
export function intersectCapabilities(a: BackendCapabilities, b: BackendCapabilities): CapabilityIntersection {
	const conflicts: string[] = [];
	const capabilities: Record<string, unknown> = {};
	for (const [name, rule] of Object.entries(INTERSECTION_RULES) as Array<
		[string, (x: BackendCapabilities, y: BackendCapabilities) => RuleResult<unknown>]
	>) {
		const result = rule(a, b);
		capabilities[name] = result.value;
		if (result.conflict !== undefined) conflicts.push(result.conflict);
	}
	return { capabilities: capabilities as unknown as BackendCapabilities, conflicts };
}

/** What is promised when nothing is known about the sides: nothing. Only the static answer of the plugin (a caller that has the sides never sees it). */
export const NOTHING_PROMISED: BackendCapabilities = Object.freeze({
	hierarchy: 'none',
	linkTypes: Object.freeze([]),
	status: 'open-closed',
	history: 'none',
	activity: 'none',
	delete: 'no',
	search: 'none',
	concurrency: 'none',
	ids: 'assigned',
	labels: false,
	meta: false,
	comments: false,
	commentAttachments: false,
	priority: false,
	assignee: false,
	claim: false,
	writes: 'none',
	indexedGraph: false,
	events: 'client',
});

/** The value of a capability as the port reads it: an optional one that is absent is false. */
function valueOf(capabilities: BackendCapabilities, name: keyof BackendCapabilities): unknown {
	const value = capabilities[name];
	return value === undefined ? false : value;
}

/**
 * For each capability the intersection holds back (the sides do not all have the value that survives), the sides (by the name they are
 * given) that hold it back: the ones whose own value IS the weaker one that survives, so those are the sides to change to get the
 * capability. When no side has the surviving value (a removal and a closing give neither), every side is named.
 */
export function heldBackBy(
	sides: Readonly<Record<string, BackendCapabilities>>,
	intersection: BackendCapabilities
): Partial<Record<keyof BackendCapabilities, string[]>> {
	const held: Partial<Record<keyof BackendCapabilities, string[]>> = {};
	for (const name of Object.keys(INTERSECTION_RULES) as Array<keyof BackendCapabilities>) {
		const wanted = JSON.stringify(valueOf(intersection, name));
		const entries = Object.entries(sides);
		const same = entries.filter(([, capabilities]) => JSON.stringify(valueOf(capabilities, name)) === wanted);
		// Every side has the value that survives: nothing is held back.
		if (same.length === entries.length) continue;
		held[name] = (same.length === 0 ? entries : same).map(([side]) => side);
	}
	return held;
}
