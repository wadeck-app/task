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
