import { describe, expect, it } from 'vitest';
import { shortTitle, shortUtcTime } from './display.js';

describe('shortTitle (the label of a list row, a tree row, a picker hit)', () => {
	it('keeps a short title as it is', () => {
		expect(shortTitle('Fix login redirect')).toBe('Fix login redirect');
	});

	it('is the headline of a long text: its first sentence when it fits', () => {
		const text =
			'Add a Dashboard page as the new home page of the frontend. Server: a GET /dashboard endpoint aggregating the number of books.';
		expect(shortTitle(text)).toBe('Add a Dashboard page as the new home page of the frontend.');
	});

	it('is the first line of a multi-line long text', () => {
		expect(shortTitle(`Title line\n${'detail '.repeat(40)}`)).toBe('Title line');
	});

	it('cuts a 700-character text without sentence at a word boundary, at most 90 characters, with an ellipsis', () => {
		const short = shortTitle('word '.repeat(140).trim());
		expect(short.length).toBeLessThanOrEqual(90);
		expect(short.endsWith('...')).toBe(true);
		expect(short).not.toMatch(/\s\.\.\.$/);
	});

	it('cuts further when the caller wants less', () => {
		const short = shortTitle('a'.repeat(120), 60);
		expect(short.length).toBe(60);
		expect(short.endsWith('...')).toBe(true);
	});

	it('cuts one unbroken word hard at 90 characters', () => {
		expect(shortTitle('x'.repeat(300)).length).toBe(90);
	});
});

describe('shortUtcTime', () => {
	it('shows the UTC date and minute of an ISO timestamp', () => {
		expect(shortUtcTime('2026-10-19T19:37:12.000Z')).toBe('2026-10-19 19:37');
	});

	it('returns a value that is not a timestamp as it is', () => {
		expect(shortUtcTime('yesterday')).toBe('yesterday');
	});
});
