import { describe, expect, it } from 'vitest';

import { blockMetaPart, checkRevisionParts, partsFromHashes, shortHash } from './revisionParts.js';

const GROUPS = ['title', 'body'] as const;
const partsOf = (revision: string) => partsFromHashes(revision.split('#')[1] ?? '', GROUPS);

describe('shortHash', () => {
	it('is six hex characters and depends on the text', () => {
		expect(shortHash('a')).toMatch(/^[0-9a-f]{6}$/);
		expect(shortHash('a')).toBe(shortHash('a'));
		expect(shortHash('a')).not.toBe(shortHash('b'));
	});
});

describe('blockMetaPart', () => {
	it('sorts the keys, treats no meta as empty, and gives a stable text for an unreadable block', () => {
		expect(blockMetaPart(() => ({ b: '2', a: '1' }))).toBe('[["a","1"],["b","2"]]');
		expect(blockMetaPart(() => undefined)).toBe('[]');
		expect(
			blockMetaPart(() => {
				throw new Error('broken');
			})
		).toBe('unreadable');
	});
});

describe('partsFromHashes', () => {
	it('reads one hash per group, and refuses a wrong count or a wrong shape', () => {
		expect(partsFromHashes('aaaaaa.bbbbbb', GROUPS)).toEqual({ title: 'aaaaaa', body: 'bbbbbb' });
		expect(partsFromHashes('aaaaaa', GROUPS)).toBeUndefined();
		expect(partsFromHashes('aaaaaa.bbbbbbb', GROUPS)).toBeUndefined();
		expect(partsFromHashes('aaaaaa.BBBBBB', GROUPS)).toBeUndefined();
	});
});

describe('checkRevisionParts', () => {
	const rev = (title: string, body: string): string => `t#${title}.${body}`;

	it('names only the parts of the write that changed', () => {
		const read = rev('aaaaaa', 'bbbbbb');
		const now = rev('aaaaaa', 'cccccc');
		expect(checkRevisionParts(read, now, ['title'], partsOf)).toEqual([]);
		expect(checkRevisionParts(read, now, ['title', 'body'], partsOf)).toEqual(['body']);
		expect(checkRevisionParts(read, read, GROUPS, partsOf)).toEqual([]);
	});

	it('a revision this backend did not issue is stale for any write', () => {
		expect(checkRevisionParts('foreign', rev('aaaaaa', 'bbbbbb'), ['title'], partsOf)).toEqual(['revision']);
	});
});
