import { BACKEND_CAPABILITY_NAMES, LOCAL_CAPABILITIES } from '@wadeck-app/task-core';

import { FILL_TECHNIQUES, fillKeys, fillableCapabilities } from './strategyFills.js';

describe('the fill table', () => {
	it('names only capabilities of BackendCapabilities', () => {
		for (const capability of Object.keys(FILL_TECHNIQUES)) {
			expect(BACKEND_CAPABILITY_NAMES, `fill table names "${capability}"`).toContain(capability);
		}
	});

	it('every technique has a known fidelity class', () => {
		for (const [capability, techniques] of Object.entries(FILL_TECHNIQUES)) {
			for (const [technique, fidelity] of Object.entries(techniques)) {
				expect(['exact', 'approximate', 'lossy'], `${capability}.${technique}`).toContain(fidelity);
			}
		}
	});

	it('linkTypes is filled per link type, and only for the link types of the design', () => {
		const keys = fillKeys();

		expect(keys).toContain('linkTypes.causedBy');
		expect(keys).not.toContain('linkTypes');
		for (const key of keys.filter(k => k.startsWith('linkTypes.'))) {
			expect(LOCAL_CAPABILITIES.linkTypes).toContain(key.slice('linkTypes.'.length));
		}
	});

	it('fillableCapabilities lists the capabilities that have at least one technique, sorted', () => {
		expect(fillableCapabilities()).toEqual(
			['activity', 'delete', 'hierarchy', 'history', 'ids', 'linkTypes', 'meta', 'search', 'status'].sort()
		);
	});

	it('the techniques of the design (2A.3) are there', () => {
		expect(FILL_TECHNIQUES['meta']).toEqual({
			labels: 'exact',
			'body-block': 'approximate',
			sidecar: 'approximate',
		});
		expect(FILL_TECHNIQUES['delete']).toEqual({ tombstone: 'approximate', hard: 'exact' });
	});
});
