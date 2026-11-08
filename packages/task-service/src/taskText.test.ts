import { bodyAddsInfo, headlineOf, HEADLINE_MAX_LENGTH, splitHeadline, taskDescription } from './taskText.js';

describe('splitHeadline', () => {
	it('exports the threshold', () => {
		expect(HEADLINE_MAX_LENGTH).toBe(90);
	});

	it('keeps a short text as the title, with no description', () => {
		expect(splitHeadline('Fix the login redirect loop')).toEqual({ title: 'Fix the login redirect loop' });
	});

	it('keeps a text of exactly 90 characters unchanged and splits one of 91', () => {
		const ninety = 'a'.repeat(90);
		expect(splitHeadline(ninety)).toEqual({ title: ninety });
		const split = splitHeadline(`${'word '.repeat(18)}x`);
		expect(split.description).toBe(`${'word '.repeat(18)}x`);
		expect(split.title.length).toBeLessThanOrEqual(90);
	});

	it('takes the first line of a long multi-line text; description keeps the full text', () => {
		const text = `Refactor the importer\n\n${'Details of the refactoring. '.repeat(10)}`;
		expect(splitHeadline(text)).toEqual({ title: 'Refactor the importer', description: text });
	});

	it('takes the first sentence when the first line is too long', () => {
		const text = `Fix the crash on startup. ${'It happens when the config is empty and the cache is cold. '.repeat(3)}`;
		expect(splitHeadline(text)).toEqual({ title: 'Fix the crash on startup.', description: text });
	});

	it('cuts at a word boundary with an ellipsis when there is no short line or sentence', () => {
		const text =
			'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon';
		const { title, description } = splitHeadline(text);
		expect(description).toBe(text);
		expect(title.length).toBeLessThanOrEqual(90);
		expect(title.endsWith('...')).toBe(true);
		expect(text.startsWith(title.slice(0, -3))).toBe(true);
		// Cut on a word boundary: the char after the kept part is a space.
		expect(text[title.length - 3]).toBe(' ');
	});

	it('hard-cuts a single very long word', () => {
		const { title } = splitHeadline('x'.repeat(200));
		expect(title).toBe(`${'x'.repeat(87)}...`);
	});

	it('skips leading blank lines and trims the headline', () => {
		const text = `\n\n   Headline here   \n${'body '.repeat(30)}`;
		expect(splitHeadline(text).title).toBe('Headline here');
	});
});

describe('headlineOf', () => {
	it('returns a short title as is and the headline of a long one', () => {
		expect(headlineOf('short')).toBe('short');
		expect(headlineOf(`First line\n${'x'.repeat(200)}`)).toBe('First line');
	});
});

describe('taskDescription and bodyAddsInfo', () => {
	it('reads description ?? title', () => {
		expect(taskDescription({ title: 'T' })).toBe('T');
		expect(taskDescription({ title: 'T', description: 'D' })).toBe('D');
	});

	it('bodyAddsInfo is false for the same text (ignoring surrounding whitespace), true otherwise', () => {
		expect(bodyAddsInfo('Same', ' Same\n')).toBe(false);
		expect(bodyAddsInfo('Short', 'Short and more')).toBe(true);
		expect(bodyAddsInfo('Short', undefined)).toBe(false);
	});
});
