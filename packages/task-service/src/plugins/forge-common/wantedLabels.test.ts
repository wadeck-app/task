import { describe, expect, it } from 'vitest';

import type { DeclaredFills } from '../kinds.js';
import { wantedLabelsOf } from './wantedLabels.js';

const settings = {
	statusMap: { todo: {}, review: { label: 'Status:Review' }, doing: { label: 'status:review' } },
	typeMap: { bug: { issueType: 'incident' }, feature: { label: 'kind:feature' } },
	typePrefix: 'type:',
};

describe('wantedLabelsOf', () => {
	it('lists statuses, then types, then the tombstone; a native type needs no label', () => {
		const fills = { delete: { use: 'tombstone' } } as unknown as DeclaredFills;
		const wanted = wantedLabelsOf(settings, ['bug', 'feature', 'chore'], fills, 'task:deleted', n => n);
		expect(wanted.map(label => `${label.kind}:${label.name}`)).toEqual([
			'status:Status:Review',
			'status:status:review',
			'type:kind:feature',
			'type:type:chore',
			'deleted:task:deleted',
		]);
	});

	it('two names are one label when the identity says so (first wins)', () => {
		const wanted = wantedLabelsOf(settings, [], {}, 'task:deleted', n => n.toLowerCase());
		expect(wanted.map(label => label.name)).toEqual(['Status:Review']);
	});
});

describe('wantedLabelsOf: priority labels', () => {
	it('come after the types and before the tombstone, in the order given; a name seen twice is one label', () => {
		const fills = { delete: { use: 'tombstone' } } as unknown as DeclaredFills;
		const wanted = wantedLabelsOf(settings, ['chore'], fills, 'task:deleted', n => n.toLowerCase(), [
			{ name: 'priority:urgent', why: 'priority "urgent"' },
			{ name: 'Priority:URGENT', why: 'again' },
			{ name: 'priority:low', why: 'priority "low"' },
		]);
		expect(wanted.map(label => `${label.kind}:${label.name}`)).toEqual([
			'status:Status:Review',
			'type:type:chore',
			'priority:priority:urgent',
			'priority:priority:low',
			'deleted:task:deleted',
		]);
	});
});
