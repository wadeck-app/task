import { BACKEND_CAPABILITY_NAMES, LOCAL_CAPABILITIES, REMOTE_CAPABILITIES } from '@wadeck-app/task-core';
import type { BackendCapabilities } from '@wadeck-app/task-core';

import { heldBackBy, INTERSECTION_RULES, intersectCapabilities } from './capabilityIntersection.js';

// What the wrapper may promise: only what both sides do, in the weaker form where they differ. Tested for every capability of
// task-core, so a capability added there without a rule here fails this file.
const ENUMS: Partial<Record<keyof BackendCapabilities, readonly string[]>> = {
	hierarchy: ['none', 'limited', 'unlimited'],
	status: ['open-closed', 'mapped', 'free'],
	history: ['none', 'derived', 'stored'],
	activity: ['none', 'native', 'stored'],
	delete: ['no', 'close-only', 'yes'],
	search: ['none', 'native', 'index'],
	concurrency: ['none', 'check-then-write', 'revision'],
	ids: ['assigned', 'generated'],
	writes: ['none', 'full'],
	events: ['client', 'server'],
};
const BOOLEANS = ['labels', 'meta', 'comments', 'priority', 'assignee', 'claim', 'indexedGraph'] as const;

const FULL: BackendCapabilities = LOCAL_CAPABILITIES;

function intersect(a: Partial<BackendCapabilities>, b: Partial<BackendCapabilities>) {
	return intersectCapabilities({ ...FULL, ...a }, { ...FULL, ...b });
}

describe('intersectCapabilities: every capability has a rule', () => {
	it('the rules cover exactly the capabilities of task-core', () => {
		expect(Object.keys(INTERSECTION_RULES).sort()).toEqual([...BACKEND_CAPABILITY_NAMES].sort());
	});

	it('commentAttachments is never promised by a migrating pair (the wrapper would upload twice), whatever the sides', () => {
		const github = { ...LOCAL_CAPABILITIES, commentAttachments: true };
		expect(intersectCapabilities(github, github).capabilities.commentAttachments).toBe(false);
	});

	it('the table of this test covers every capability too (a new one needs its cases here)', () => {
		expect([...Object.keys(ENUMS), ...BOOLEANS, 'linkTypes', 'commentAttachments'].sort()).toEqual([...BACKEND_CAPABILITY_NAMES].sort());
	});

	it('the same capabilities on both sides give the same capabilities and no conflict', () => {
		for (const caps of [LOCAL_CAPABILITIES, REMOTE_CAPABILITIES]) {
			const result = intersectCapabilities(caps, caps);
			expect(result.capabilities).toEqual(caps);
			expect(result.conflicts).toEqual([]);
		}
	});
});

describe('intersectCapabilities: enum capabilities take the weaker promise', () => {
	it.each([
		['hierarchy', 'unlimited', 'limited', 'limited'],
		['hierarchy', 'limited', 'none', 'none'],
		['hierarchy', 'unlimited', 'none', 'none'],
		['status', 'free', 'mapped', 'mapped'],
		['status', 'mapped', 'open-closed', 'open-closed'],
		['history', 'stored', 'derived', 'derived'],
		['activity', 'stored', 'native', 'native'],
		['search', 'index', 'native', 'native'],
		['concurrency', 'revision', 'check-then-write', 'check-then-write'],
		['concurrency', 'check-then-write', 'none', 'none'],
		['ids', 'generated', 'assigned', 'assigned'],
		['writes', 'full', 'none', 'none'],
	] as const)('%s: %s with %s gives %s (both orders)', (field, a, b, expected) => {
		expect(intersect({ [field]: a }, { [field]: b }).capabilities[field]).toBe(expected);
		expect(intersect({ [field]: b }, { [field]: a }).capabilities[field]).toBe(expected);
	});

	it('delete: only an equal promise survives; yes with close-only is no (a removal and a closing are not the same)', () => {
		expect(intersect({ delete: 'yes' }, { delete: 'yes' }).capabilities.delete).toBe('yes');
		expect(intersect({ delete: 'close-only' }, { delete: 'close-only' }).capabilities.delete).toBe('close-only');
		expect(intersect({ delete: 'yes' }, { delete: 'close-only' }).capabilities.delete).toBe('no');
		expect(intersect({ delete: 'yes' }, { delete: 'no' }).capabilities.delete).toBe('no');
		expect(intersect({ delete: 'close-only' }, { delete: 'no' }).capabilities.delete).toBe('no');
	});

	it('every pair of values of every enum: commutative, idempotent, and never above either side', () => {
		for (const [field, values] of Object.entries(ENUMS)) {
			for (const a of values!) {
				for (const b of values!) {
					const ab = intersect({ [field]: a }, { [field]: b });
					const ba = intersect({ [field]: b }, { [field]: a });
					expect(ab.capabilities, `${field}: ${a} with ${b}`).toEqual(ba.capabilities);
					if (a === b) expect((ab.capabilities as unknown as Record<string, unknown>)[field]).toBe(a);
					const rank = (value: string): number => values!.indexOf(value);
					const got = (ab.capabilities as unknown as Record<string, string>)[field]!;
					if (field !== 'events')
						expect(rank(got), `${field}: ${a} with ${b} gave ${got}`).toBeLessThanOrEqual(
							Math.min(rank(a), rank(b))
						);
				}
			}
		}
	});
});

describe('intersectCapabilities: booleans and link types', () => {
	it.each(BOOLEANS)('%s needs both sides', field => {
		expect(intersect({ [field]: true }, { [field]: true }).capabilities[field]).toBe(true);
		expect(intersect({ [field]: true }, { [field]: false }).capabilities[field]).toBe(false);
		expect(intersect({ [field]: false }, { [field]: true }).capabilities[field]).toBe(false);
	});

	it('an optional capability that a side leaves out is false: absent means false in the port', () => {
		const { priority: _priority, assignee: _assignee, claim: _claim, ...without } = FULL;
		const result = intersectCapabilities(FULL, without as BackendCapabilities);
		expect(result.capabilities.priority).toBe(false);
		expect(result.capabilities.assignee).toBe(false);
		expect(result.capabilities.claim).toBe(false);
	});

	it('link types: the types both sides store, in the order of the first side', () => {
		expect(intersect({ linkTypes: ['blockedBy'] }, {}).capabilities.linkTypes).toEqual(['blockedBy']);
		expect(
			intersect({ linkTypes: ['blockedBy', 'duplicateOf'] }, { linkTypes: ['duplicateOf', 'causedBy'] })
				.capabilities.linkTypes
		).toEqual(['duplicateOf']);
		expect(intersect({ linkTypes: [] }, {}).capabilities.linkTypes).toEqual([]);
	});
});

describe('intersectCapabilities: what cannot be combined is a conflict, never a guess', () => {
	it('events raised here on one side and by a server on the other', () => {
		const result = intersect({ events: 'client' }, { events: 'server' });
		expect(result.conflicts).toEqual([
			expect.stringContaining(
				'events: one side raises the queue events of a change in this process and the other by a server'
			),
		]);
	});

	it.each([
		['history', 'stored', 'none'],
		['activity', 'stored', 'none'],
		['activity', 'native', 'none'],
	] as const)('%s: %s on one side and none on the other (the record would have to be stripped)', (field, a, b) => {
		const result = intersect({ [field]: a }, { [field]: b });
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0]).toContain(`${field}: `);
		expect(intersect({ [field]: b }, { [field]: a }).conflicts).toHaveLength(1);
	});

	it('none on both sides is no conflict', () => {
		expect(
			intersect({ history: 'none', activity: 'none' }, { history: 'none', activity: 'none' }).conflicts
		).toEqual([]);
	});

	it('a restricted pair that differs only in what the wrapper can refuse has no conflict', () => {
		const result = intersect(
			{},
			{
				hierarchy: 'limited',
				meta: false,
				delete: 'no',
				linkTypes: ['blockedBy'],
				concurrency: 'check-then-write',
			}
		);
		expect(result.conflicts).toEqual([]);
	});
});

describe('heldBackBy: which side to change to get a capability back', () => {
	function held(current: Partial<BackendCapabilities>, next: Partial<BackendCapabilities>) {
		const a = { ...FULL, ...current };
		const b = { ...FULL, ...next };
		return heldBackBy({ current: a, new: b }, intersectCapabilities(a, b).capabilities);
	}

	it('is empty when the sides agree', () => {
		expect(held({}, {})).toEqual({});
	});

	it('names the side that lacks a capability the other has', () => {
		expect(held({}, { meta: false })).toEqual({ meta: ['new'] });
		expect(held({ meta: false }, {})).toEqual({ meta: ['current'] });
	});

	it('names the side with the weaker value of an enum', () => {
		expect(held({}, { hierarchy: 'limited', concurrency: 'check-then-write' })).toEqual({
			hierarchy: ['new'],
			concurrency: ['new'],
		});
	});

	it('names both sides when neither has the value that survives (a removal and a closing)', () => {
		expect(held({ delete: 'yes' }, { delete: 'close-only' })).toEqual({ delete: ['current', 'new'] });
	});

	it('does not name a side when both lack the capability: nothing is held back that the other could give', () => {
		expect(held({ meta: false }, { meta: false })).toEqual({});
	});

	it('an optional capability left out is read as false', () => {
		const { priority: _priority, ...without } = FULL;
		expect(
			heldBackBy(
				{ current: FULL, new: without as BackendCapabilities },
				intersectCapabilities(FULL, without as BackendCapabilities).capabilities
			)
		).toEqual({ priority: ['new'] });
	});
});
