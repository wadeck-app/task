import { levenshtein, matchGlob, suggest } from './text.js';

describe('levenshtein', () => {
	it('is 0 for identical strings and counts single edits', () => {
		expect(levenshtein('done', 'done')).toBe(0);
		expect(levenshtein('done', 'dome')).toBe(1);
		expect(levenshtein('', 'abc')).toBe(3);
		expect(levenshtein('kitten', 'sitting')).toBe(3);
	});
});

describe('suggest', () => {
	it('returns the closest candidate within distance 3, case-insensitively', () => {
		expect(suggest('DONNE', ['backlog', 'done'])).toBe('done');
	});

	it('returns undefined when nothing is close enough', () => {
		expect(suggest('zzzzzzzz', ['backlog', 'done'])).toBeUndefined();
	});
});

describe('matchGlob', () => {
	it('treats * as a wildcard and anchors the whole value', () => {
		expect(matchGlob('fix*', 'fix bug')).toBe(true);
		expect(matchGlob('fix', 'fix bug')).toBe(false);
		expect(matchGlob('*bug', 'fix bug')).toBe(true);
	});

	it('escapes regex metacharacters and is case-sensitive', () => {
		expect(matchGlob('a.b', 'axb')).toBe(false);
		expect(matchGlob('a.b', 'a.b')).toBe(true);
		expect(matchGlob('Fix', 'fix')).toBe(false);
	});
});
