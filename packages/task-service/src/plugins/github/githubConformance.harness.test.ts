// The machinery of the conformance harness itself (githubConformance.testkit.ts): big request bodies, the normal form of an answer and
// the comparison rules. The agreement of the fake with the live recording is githubConformance.test.ts.
import {
	LONG_TEXT,
	linkOf,
	normalizeAnswer,
	normalizeBody,
	normalizeHeaders,
	replayFixture,
	scenarioVariables,
	substitute,
} from './githubConformance.testkit.js';
import type { ConformanceFixture, NormalizeContext } from './githubConformance.testkit.js';
import { FakeGitHub } from './fakeGitHub.testkit.js';

const ctx: NormalizeContext = { run: 'abc123', apiBase: 'http://127.0.0.1:1' };

describe('$repeat in a request body', () => {
	it('expands to the unit repeated count times, with the optional prefix first', () => {
		expect(substitute({ body: { $repeat: ['d', 5] } }, {})).toEqual({ body: 'ddddd' });
		const title = substitute({ title: { $repeat: ['t', 310, '[task-api-test] '] } }, {}).title as unknown as string;
		expect(title.startsWith('[task-api-test] t')).toBe(true);
		expect(title).toHaveLength(326);
	});

	it('substitutes the variables of the prefix, in nested objects and arrays', () => {
		expect(substitute({ a: [{ b: { $repeat: ['x', 2, 'run {{run}} '] } }] }, { run: 'r1' })).toEqual({
			a: [{ b: 'run r1 xx' }],
		});
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
	])('refuses %s with an error naming the forms allowed', (_name, value) => {
		expect(() => substitute(value, {})).toThrow(/"\$repeat" must be \[unit, count\] or \[unit, count, prefix\]/);
	});

	it('names the variable a step needed and an earlier step did not save', () => {
		expect(() => substitute('issues/{{a}}', {})).toThrow('variable "a" is not set');
		expect(substitute({ id: '{{n:n}}' }, { n: '12' })).toEqual({ id: 12 });
	});
});

describe('the normal form of an answer', () => {
	it('replaces volatile ids, node ids, instants and users and keeps the rest', () => {
		expect(
			normalizeBody(
				{
					id: 4211,
					node_id: 'I_kwDOabc',
					number: 12,
					comments: 3,
					user: { login: 'someone', id: 9 },
					title: 'abc123 title',
					created_at: '2026-11-09T10:00:00Z',
					url: 'http://127.0.0.1:1/repos/o/r/issues/12',
					html_url: 'https://github.com/o/r/issues/12',
				},
				ctx
			)
		).toEqual({
			id: '<n>',
			node_id: '<node>',
			number: '<n>',
			comments: 3,
			user: '<user>',
			title: '{{run}} title',
			created_at: '<time>',
			url: '<api>/repos/o/r/issues/N',
			html_url: '<web>/o/r/issues/N',
		});
	});

	it('keeps how updated_at relates to created_at', () => {
		const same = normalizeBody({ created_at: '2026-11-09T10:00:00Z', updated_at: '2026-11-09T10:00:00Z' }, ctx);
		const later = normalizeBody({ created_at: '2026-11-09T10:00:00Z', updated_at: '2026-11-09T10:00:07Z' }, ctx);
		expect(same).toEqual({ created_at: '<time>', updated_at: '<time same>' });
		expect(later).toEqual({ created_at: '<time>', updated_at: '<time later>' });
	});

	it('keeps how the events of one answer relate, whatever the distance', () => {
		const event = (at: string): Record<string, unknown> => ({ id: 1, event: 'labeled', created_at: at });
		const live = normalizeBody(
			[event('2026-11-09T10:00:00Z'), event('2026-11-09T10:00:00Z'), event('2026-11-09T10:00:01Z')],
			ctx
		) as Array<{ created_at: string }>;
		const fake = normalizeBody(
			[event('2026-11-09T10:00:00Z'), event('2026-11-09T10:00:00Z'), event('2026-11-09T10:00:05Z')],
			ctx
		) as Array<{ created_at: string }>;
		expect(live.map(item => item.created_at)).toEqual(['<time>', '<time same>', '<time later>']);
		expect(fake).toEqual(live);
	});

	it('does not touch the instants of a list that is not made of events', () => {
		const issues = normalizeBody(
			[
				{ number: 1, created_at: '2026-11-09T10:00:00Z' },
				{ number: 2, created_at: '2026-11-09T10:00:00Z' },
			],
			ctx
		) as Array<{ created_at: string }>;
		expect(issues.map(item => item.created_at)).toEqual(['<time>', '<time>']);
	});

	it('replaces a string longer than LONG_TEXT by its length, idempotently', () => {
		expect(normalizeBody({ body: 'a'.repeat(LONG_TEXT) }, ctx)).toEqual({ body: 'a'.repeat(LONG_TEXT) });
		const once = normalizeBody({ body: 'a'.repeat(65537) }, ctx);
		expect(once).toEqual({ body: '<string of 65537 characters>' });
		expect(normalizeBody(once, ctx)).toEqual(once);
	});

	it('gives an empty answer as null and a plain text answer as text', () => {
		expect(normalizeAnswer({ status: 204, headers: {}, text: '', json: undefined }, ctx).body).toBeNull();
		expect(normalizeAnswer({ status: 502, headers: {}, text: 'bad gateway', json: undefined }, ctx).body).toBe(
			'bad gateway'
		);
	});
});

describe('the key headers', () => {
	it('normalize the volatile parts and keep the contract', () => {
		const headers: Record<string, string> = {
			etag: 'W/"abc123def"',
			'x-ratelimit-limit': '5000',
			'x-ratelimit-remaining': '4990',
			'x-ratelimit-reset': '1790000000',
			'x-ratelimit-resource': 'core',
			'github-authentication-token-expiration': '2026-11-15 14:04:02 UTC',
			'cache-control': 'private',
			link: '<https://api.github.com/repositories/123/issues?state=all&per_page=2&after=Y3Vyc29y&page=2>; rel="next"',
		};
		expect(normalizeHeaders(name => headers[name], { run: '', apiBase: 'https://api.github.com' })).toEqual({
			etag: '"<hash>"',
			'x-ratelimit-limit': '5000',
			'x-ratelimit-remaining': '<n>',
			'x-ratelimit-reset': '<n>',
			'x-ratelimit-resource': 'core',
			'github-authentication-token-expiration': '<expiration>',
			link: '<<api>/repo/issues?state=all&per_page=N&after=<cursor>&page=N>; rel="next"',
		});
	});

	it('gives the same Link whether the path is /repositories/<id>/ or /repos/<owner>/<name>/', () => {
		const live = normalizeHeaders(
			name => (name === 'link' ? '<https://api.github.com/repositories/9/issues?page=2>; rel="next"' : undefined),
			{ run: '', apiBase: 'https://api.github.com' }
		);
		const fake = normalizeHeaders(
			name => (name === 'link' ? '<http://127.0.0.1:1/repos/o/r/issues?page=2>; rel="next"' : undefined),
			ctx
		);
		expect(fake).toEqual(live);
	});

	it('finds the url of a Link rel', () => {
		const header = '<http://x/a?page=2>; rel="next", <http://x/a?page=5>; rel="last"';
		expect(linkOf(header, 'last')).toBe('http://x/a?page=5');
		expect(linkOf(header, 'prev')).toBeUndefined();
		expect(linkOf(undefined, 'next')).toBeUndefined();
	});
});

describe('scenario variables', () => {
	it('derive the upper case form of the repository', () => {
		expect(scenarioVariables('wadeck-app/r', 'x')).toEqual({
			repo: 'wadeck-app/r',
			repoU: 'WADECK-APP/R',
			run: 'x',
		});
	});
});

describe('the comparison of a replayed step', () => {
	let fake: FakeGitHub;
	beforeAll(async () => {
		fake = await FakeGitHub.start({ repo: 'o/r' });
	});
	afterAll(async () => {
		await fake.stop();
	});

	const fixtureOf = (step: Record<string, unknown>): ConformanceFixture =>
		({ format: 1, recordedAt: '2026-11-09', source: 'test', steps: [step] }) as unknown as ConformanceFixture;
	const replay = (step: Record<string, unknown>) =>
		replayFixture(fixtureOf(step), { apiBase: fake.baseUrl, token: fake.token, repo: 'o/r', run: 'abc123' });

	it('reports a difference of status, of header and of body', async () => {
		const [outcome] = await replay({
			name: 'rate limit',
			request: { method: 'GET', path: 'rate_limit' },
			expect: { status: 404, headers: {}, body: null },
		});
		expect(outcome!.problems[0]).toContain('status: live 404 but mock 200');
		const [other] = await replay({
			name: 'rate limit',
			request: { method: 'GET', path: 'rate_limit' },
			expect: { status: 200, headers: { 'x-ratelimit-resource': 'search' }, body: {} },
			subset: true,
		});
		expect(other!.problems.join('\n')).toContain('header x-ratelimit-resource: live "search" but mock "core"');
	});

	it('lets a key only the real answer has through when the strategy never reads it, never one the strategy reads', async () => {
		fake.addIssue({ title: 'one' });
		const base = { name: 'issue', request: { method: 'GET', path: 'repos/o/r/issues/1' } };
		const live = { title: 'one', state: 'open' };
		const [fine] = await replay({
			...base,
			expect: { status: 200, headers: {}, body: { ...live, reactions: { total_count: 0 } } },
			subset: true,
		});
		expect(fine!.problems.filter(p => p.startsWith('body'))).not.toContain('reactions');
		const [strict] = await replay({
			...base,
			expect: { status: 200, headers: {}, body: { ...live, state_reason_extra: 'x' } },
		});
		expect(strict!.problems.join('\n')).toContain('state_reason_extra');
	});

	it('reports a key only the fake sends', async () => {
		const [outcome] = await replay({
			name: 'repo',
			request: { method: 'GET', path: 'repos/o/r' },
			expect: { status: 200, headers: {}, body: { name: 'r' } },
		});
		expect(outcome!.problems.join('\n')).toContain('mock');
	});

	it('does not send a step whose variable an earlier step failed to save', async () => {
		const [outcome] = await replay({
			name: 'needs a',
			request: { method: 'GET', path: 'repos/o/r/issues/{{a}}' },
			expect: { status: 404, headers: {}, body: {} },
		});
		expect(outcome!.problems[0]).toContain('not sent: conformance: variable "a" is not set');
	});
});
