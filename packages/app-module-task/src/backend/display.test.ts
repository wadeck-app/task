import { describe, expect, it } from 'vitest';
import { firstSentence, shortTitle } from './display.js';

describe('firstSentence', () => {
	it('keeps a short title as it is', () => {
		expect(firstSentence('Fix login redirect')).toBe('Fix login redirect');
	});

	it('cuts a long description after its first sentence', () => {
		const text =
			'Add a Dashboard page as the new home page of the frontend. Server: a GET /dashboard endpoint aggregating the number of books.';
		expect(firstSentence(text)).toBe('Add a Dashboard page as the new home page of the frontend.');
	});

	it('does not take a dot inside a word or a path for the end of a sentence', () => {
		expect(firstSentence('Rename config.yml to settings.yml in v1.2 of the docs, then ship it. Later.')).toBe(
			'Rename config.yml to settings.yml in v1.2 of the docs, then ship it.'
		);
	});

	it('keeps the question or exclamation mark', () => {
		expect(firstSentence('Why does the build fail? Because of the cache.')).toBe('Why does the build fail?');
	});

	it('uses the first line only', () => {
		expect(firstSentence('Title line\nSecond line with the details.')).toBe('Title line');
	});

	it('cuts at a word boundary with an ellipsis when the first sentence is longer than the limit', () => {
		const words = 'word '.repeat(60).trim();
		const short = firstSentence(words, 90);
		expect(short.length).toBeLessThanOrEqual(90);
		expect(short.endsWith('…')).toBe(true);
		expect(short).not.toMatch(/\s…$/);
		expect(words.startsWith(short.slice(0, -1))).toBe(true);
	});

	it('cuts one unbroken word hard at the limit', () => {
		const short = firstSentence('x'.repeat(300), 90);
		expect(short).toBe(`${'x'.repeat(89)}…`);
	});

	it('trims the surrounding whitespace', () => {
		expect(firstSentence('  Padded title.  ')).toBe('Padded title.');
	});

	it('returns an empty string for a blank title', () => {
		expect(firstSentence('   ')).toBe('');
	});
});

describe('shortTitle (table cells) is unchanged', () => {
	it('still cuts at 90 characters', () => {
		expect(shortTitle('a'.repeat(120)).length).toBe(90);
	});
});
