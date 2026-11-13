// The machinery of the conformance harness itself (gitlabConformance.testkit.ts): big request bodies and the normal form of long
// strings. The agreement of the mock with the live recording is gitlabConformance.test.ts.
import {
	LONG_TEXT,
	normalizeAnswer,
	normalizeBody,
	scenarioVariables,
	substitute,
} from './gitlabConformance.testkit.js';
import type { NormalizeContext } from './gitlabConformance.testkit.js';

const ctx: NormalizeContext = { run: 'abc123', apiBase: 'http://127.0.0.1:1/api/v4' };

describe('$repeat in a request body', () => {
	it('expands to the unit repeated count times', () => {
		expect(substitute({ description: { $repeat: ['d', 5] } }, {})).toEqual({ description: 'ddddd' });
	});

	it('puts the optional prefix first and counts it in the text, not in the repeat', () => {
		const title = substitute({ title: { $repeat: ['t', 239, '[task-api-test] '] } }, {}).title as unknown as string;
		expect(title.startsWith('[task-api-test] t')).toBe(true);
		expect(title).toHaveLength(255);
	});

	it('substitutes the variables of the prefix, in nested objects and arrays', () => {
		expect(substitute({ a: [{ b: { $repeat: ['x', 2, 'run {{run}} '] } }] }, { run: 'r1' })).toEqual({
			a: [{ b: 'run r1 xx' }],
		});
	});

	it('expands multi-character units and a count of zero', () => {
		expect(substitute({ $repeat: ['ab', 3] }, {})).toBe('ababab');
		expect(substitute({ $repeat: ['ab', 0] }, {})).toBe('');
	});

	it('builds a string past one mebibyte without a stack problem', () => {
		const text = substitute({ $repeat: ['d', 1_048_577] }, {}) as unknown as string;
		expect(text).toHaveLength(1_048_577);
	});

	it('is only recognized as the single key of an object', () => {
		expect(substitute({ $repeat: ['d', 2], other: 1 }, {})).toEqual({ $repeat: ['d', 2], other: 1 });
	});

	it.each([
		['a non array', { $repeat: 'd' }],
		['a missing count', { $repeat: ['d'] }],
		['an empty unit', { $repeat: ['', 3] }],
		['a fractional count', { $repeat: ['d', 1.5] }],
		['a negative count', { $repeat: ['d', -1] }],
		['a count that would allocate too much', { $repeat: ['d', 1e9] }],
		['a prefix that is not text', { $repeat: ['d', 1, 5] }],
		['too many items', { $repeat: ['d', 1, 'p', 'q'] }],
	])('refuses %s with an error naming the forms allowed', (_name, value) => {
		expect(() => substitute(value, {})).toThrow(/"\$repeat" must be \[unit, count\] or \[unit, count, prefix\]/);
	});
});

describe('long strings in an answer', () => {
	it('keeps a string of exactly LONG_TEXT characters and replaces one more by its length', () => {
		expect(normalizeBody({ title: 'a'.repeat(LONG_TEXT) }, ctx)).toEqual({ title: 'a'.repeat(LONG_TEXT) });
		expect(normalizeBody({ title: 'a'.repeat(LONG_TEXT + 1) }, ctx)).toEqual({
			title: `<string of ${LONG_TEXT + 1} characters>`,
		});
	});

	it('replaces the big strings of nested objects and arrays and keeps the short ones', () => {
		const big = 'n'.repeat(1_000_001);
		expect(normalizeBody([{ body: big, id: 5, note: 'short' }], ctx)).toEqual([
			{ body: '<string of 1000001 characters>', id: '<n>', note: 'short' },
		]);
	});

	it('is idempotent: the recorded side is normalized again by the replay', () => {
		const once = normalizeBody({ description: 'd'.repeat(1_048_576), title: 'x' }, ctx);
		expect(normalizeBody(once, ctx)).toEqual(once);
	});

	it('counts the length after the run suffix is normalized, so the live and the mock run ids agree', () => {
		const live = { run: 'q9x8w7', apiBase: ctx.apiBase };
		const mock = { run: 'abc123', apiBase: ctx.apiBase };
		const textFor = (run: string): string => `${run} ${'z'.repeat(250)}`;
		expect(normalizeBody({ t: textFor('q9x8w7') }, live)).toEqual(normalizeBody({ t: textFor('abc123') }, mock));
	});

	it('applies to a plain text answer too', () => {
		const answer = normalizeAnswer({ status: 500, headers: {}, text: 'e'.repeat(300), json: undefined }, ctx);
		expect(answer.body).toBe('<string of 300 characters>');
	});

	it('leaves the numeric ids and times alone', () => {
		expect(normalizeBody({ iid: '42', created_at: '2026-11-09T10:00:00.000Z' }, ctx)).toEqual({
			iid: '<n>',
			created_at: '<time>',
		});
	});
});

describe('scenario variables', () => {
	it('derive the encoded path, its upper case form and the group from the project path', () => {
		expect(scenarioVariables('wadeck-app/test-task-gl', 'r')).toEqual({
			P: 'wadeck-app%2Ftest-task-gl',
			PU: 'WADECK-APP%2FTEST-TASK-GL',
			projectPath: 'wadeck-app/test-task-gl',
			group: 'wadeck-app',
			run: 'r',
		});
		expect(scenarioVariables('a/b/c', 'r').group).toBe('a/b');
		expect(scenarioVariables('solo', 'r').group).toBe('');
	});
});

describe('instants of the events of one answer', () => {
	const event = (id: number, at: string): Record<string, unknown> => ({
		id,
		created_at: at,
		resource_type: 'Issue',
		action: 'add',
	});

	it('keep only how they relate: the first, then same / later / earlier than the previous one', () => {
		const body = normalizeBody(
			[
				event(1, '2026-11-09T10:00:00.000Z'),
				event(2, '2026-11-09T10:00:00.000Z'),
				event(3, '2026-11-09T10:00:07.250Z'),
				event(4, '2026-11-09T10:00:06.000Z'),
			],
			ctx
		) as Array<{ created_at: string }>;
		expect(body.map(item => item.created_at)).toEqual(['<time>', '<time same>', '<time later>', '<time earlier>']);
	});

	it('are the same whatever the distance (the mock and GitLab do not wait the same time)', () => {
		const live = normalizeBody([event(1, '2026-11-09T10:00:00.000Z'), event(2, '2026-11-09T10:00:01.100Z')], ctx);
		const mock = normalizeBody([event(1, '2026-11-09T10:00:00.000Z'), event(2, '2026-11-09T10:00:05.000Z')], ctx);
		expect(live).toEqual(mock);
	});

	it('leave other lists alone: notes and issues keep <time>', () => {
		const notes = normalizeBody(
			[
				{ id: 1, created_at: '2026-11-09T10:00:00.000Z' },
				{ id: 2, created_at: '2026-11-09T10:00:00.000Z' },
			],
			ctx
		) as Array<{ created_at: string }>;
		expect(notes.map(item => item.created_at)).toEqual(['<time>', '<time>']);
	});

	it('are idempotent: a second pass leaves the relative forms alone', () => {
		const once = normalizeBody([event(1, '2026-11-09T10:00:00.000Z'), event(2, '2026-11-09T10:00:00.000Z')], ctx);
		expect(normalizeBody(once, ctx)).toEqual(once);
	});
});

describe('other normal forms of a recording', () => {
	it('ids under a *_ids key, Ruby addresses and the urls inside a sentence are volatile', () => {
		expect(normalizeBody({ add_label_ids: [55640996, 55640997] }, ctx)).toEqual({ add_label_ids: ['<n>', '<n>'] });
		expect(normalizeBody({ message: 'a #<GlobalID:0x00007ba7129ead88 @uri=1>' }, ctx)).toEqual({
			message: 'a #<GlobalID:0xN @uri=1>',
		});
		// The numbers of a url inside a sentence are ids.
		expect(normalizeBody({ summary: ['see http://127.0.0.1:1/g/p/-/work_items/102.'] }, ctx)).toEqual({
			summary: ['see <web>/g/p/-/work_items/N.'],
		});
	});
});
