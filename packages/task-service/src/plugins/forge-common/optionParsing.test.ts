import { describe, expect, it } from 'vitest';

import { found, isMapping, parseNumber, parseTtlCache } from './optionParsing.js';

describe('option parsing', () => {
	it('found shows a list as a list and a value as JSON', () => {
		expect(found([1])).toBe('a list');
		expect(found('x')).toBe('"x"');
		expect(found(undefined)).toBe('undefined');
	});

	it('isMapping refuses null and lists', () => {
		expect([{}, null, [], 'x'].map(isMapping)).toEqual([true, false, false, false]);
	});

	it('parseNumber: fallback, accepted, refused', () => {
		const positive = (n: number): boolean => n > 0;
		expect(parseNumber({}, 'k', 5, positive, 'positive')).toEqual({ value: 5 });
		expect(parseNumber({ k: 2 }, 'k', 5, positive, 'positive')).toEqual({ value: 2 });
		expect(parseNumber({ k: 0 }, 'k', 5, positive, 'positive')).toEqual({
			problem: 'k: must be positive, found 0',
		});
		expect(parseNumber({ k: 'x' }, 'k', 5, positive, 'positive')).toEqual({
			problem: 'k: must be positive, found "x"',
		});
	});

	it('parseTtlCache: the fallback is the default and appears in the message', () => {
		expect(parseTtlCache(undefined, 30)).toEqual({ value: 30 });
		expect(parseTtlCache({}, 30)).toEqual({ value: 30 });
		expect(parseTtlCache({ ttlSeconds: 0 }, 30)).toEqual({ value: 0 });
		expect(parseTtlCache('x', 30)).toEqual({
			problem: 'cache: must be a mapping like { ttlSeconds: 30 }, found "x"',
		});
		expect(parseTtlCache({ other: 1 }, 30)).toEqual({ problem: 'cache.other: unknown key (valid: ttlSeconds)' });
		expect(parseTtlCache({ ttlSeconds: -1 }, 30)).toEqual({
			problem: 'cache.ttlSeconds: must be zero or a positive number of seconds, found -1',
		});
	});
});
