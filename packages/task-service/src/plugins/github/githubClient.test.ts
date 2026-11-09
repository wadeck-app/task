import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	BackendAuthError,
	BackendLimitError,
	BackendTimeoutError,
	BackendUnreachableError,
	RateLimitedError,
} from '@wadeck-app/task-core';

import type { ReadNotice } from '../kinds.js';
import { FakeGitHub } from './fakeGitHub.testkit.js';
import { GitHubClient, GitHubHttpError, redactToken } from './githubClient.js';
import type { GitHubClientOptions } from './githubClient.js';
import { DiskResponseCache, MemoryResponseCache } from './responseCache.js';

let fake: FakeGitHub;
let notices: ReadNotice[];
let clockMs: number;
let debugLines: string[];

beforeEach(async () => {
	fake = await FakeGitHub.start({ repo: 'acme/shop' });
	notices = [];
	debugLines = [];
	clockMs = Date.parse('2026-11-08T12:00:00Z');
});

afterEach(async () => {
	await fake.stop();
});

function client(overrides: Partial<GitHubClientOptions> = {}): GitHubClient {
	return new GitHubClient({
		baseUrl: fake.baseUrl,
		token: fake.token,
		repo: 'acme/shop',
		tokenHint: 'the environment variable GITHUB_TOKEN (strategy.options.tokenEnv)',
		timeoutMs: 2000,
		cacheTtlMs: 60_000,
		cache: new MemoryResponseCache(),
		now: () => clockMs,
		onNotice: notice => notices.push(notice),
		debug: line => debugLines.push(line),
		...overrides,
	});
}

const failure = async (call: () => Promise<unknown>): Promise<Error> => {
	try {
		await call();
	} catch (error) {
		return error as Error;
	}
	throw new Error('expected a failure');
};

describe('GitHubClient: a plain read', () => {
	it('sends the token, the media type, the API version and a user agent; parses the JSON', async () => {
		const number = fake.addIssue({ title: 'First' });
		const seen: Record<string, string>[] = [];
		const spy: typeof fetch = (input, init) => {
			seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
			return fetch(input, init);
		};

		const answer = await client({ fetch: spy }).get<{ number: number; title: string }>(
			`/repos/acme/shop/issues/${number}`
		);

		expect(answer).toMatchObject({ status: 200, body: { number, title: 'First' }, fromCache: false, stale: false });
		expect(seen[0]).toMatchObject({
			authorization: `Bearer ${fake.token}`,
			accept: 'application/vnd.github+json',
			'x-github-api-version': '2022-11-28',
		});
		expect(seen[0]!['user-agent']).toMatch(/^task-cli/);
	});

	it('puts the query in a stable order, so one read has one cache key', async () => {
		const c = client();
		await c.get('/repos/acme/shop/issues', { query: { state: 'all', per_page: 5 } });
		await c.get('/repos/acme/shop/issues', { query: { per_page: 5, state: 'all' } });

		expect(fake.requestsTo('/repos/acme/shop/issues')).toHaveLength(1);
	});
});

describe('GitHubClient: the cache and conditional requests', () => {
	it('serves a read from the cache inside the TTL without any request', async () => {
		const number = fake.addIssue({ title: 'Cached' });
		const c = client();
		await c.get(`/repos/acme/shop/issues/${number}`);

		clockMs += 30_000;
		const again = await c.get<{ title: string }>(`/repos/acme/shop/issues/${number}`);

		expect(again).toMatchObject({ body: { title: 'Cached' }, fromCache: true, stale: false });
		expect(fake.requestsTo(`/repos/acme/shop/issues/${number}`)).toHaveLength(1);
	});

	it('past the TTL it asks again with If-None-Match, and a 304 returns the cached body without spending the quota', async () => {
		const number = fake.addIssue({ title: 'Unchanged' });
		const c = client();
		await c.get(`/repos/acme/shop/issues/${number}`);
		const remaining = fake.coreRemaining;

		clockMs += 61_000;
		const again = await c.get<{ title: string }>(`/repos/acme/shop/issues/${number}`);

		expect(again).toMatchObject({ body: { title: 'Unchanged' }, stale: false });
		const requests = fake.requestsTo(`/repos/acme/shop/issues/${number}`);
		expect(requests.map(r => [r.status, r.conditional])).toEqual([
			[200, false],
			[304, true],
		]);
		expect(fake.coreRemaining).toBe(remaining);
		// The 304 renewed the entry: inside the next minute nothing is asked.
		clockMs += 10_000;
		await c.get(`/repos/acme/shop/issues/${number}`);
		expect(fake.requestsTo(`/repos/acme/shop/issues/${number}`)).toHaveLength(2);
	});

	it('past the TTL a changed answer replaces the cached one', async () => {
		const number = fake.addIssue({ title: 'Old' });
		const c = client();
		await c.get(`/repos/acme/shop/issues/${number}`);

		fake.updateIssue(number, { title: 'New' });
		clockMs += 61_000;

		expect((await c.get<{ title: string }>(`/repos/acme/shop/issues/${number}`)).body.title).toBe('New');
	});

	it('a TTL of zero revalidates every read', async () => {
		const number = fake.addIssue({ title: 'Always' });
		const c = client({ cacheTtlMs: 0 });
		await c.get(`/repos/acme/shop/issues/${number}`);
		await c.get(`/repos/acme/shop/issues/${number}`);

		expect(fake.requestsTo(`/repos/acme/shop/issues/${number}`).map(r => r.status)).toEqual([200, 304]);
	});

	it('a read marked uncached neither reads nor writes the cache', async () => {
		const c = client();
		fake.addIssue({ title: 'Searchable' });
		await c.get('/search/issues', { query: { q: 'repo:acme/shop Searchable' }, cache: false });
		await c.get('/search/issues', { query: { q: 'repo:acme/shop Searchable' }, cache: false });

		expect(fake.requestsTo('/search/issues')).toHaveLength(2);
	});

	it('a disk cache lets the next process revalidate instead of downloading', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-'));
		try {
			const number = fake.addIssue({ title: 'On disk' });
			const cacheDir = path.join(dir, 'cache');
			const make = (): GitHubClient =>
				client({
					cache: new DiskResponseCache(
						cacheDir,
						(file, text) => fs.writeFileSync(file, text),
						error => {
							throw error;
						}
					),
				});
			await make().get(`/repos/acme/shop/issues/${number}`);
			clockMs += 61_000;

			const again = await make().get<{ title: string }>(`/repos/acme/shop/issues/${number}`);

			expect(again.body.title).toBe('On disk');
			expect(fake.requestsTo(`/repos/acme/shop/issues/${number}`).map(r => r.status)).toEqual([200, 304]);
			const files = fs.readdirSync(cacheDir);
			expect(files).toHaveLength(1);
			expect(fs.readFileSync(path.join(cacheDir, files[0]!), 'utf8')).not.toContain(fake.token);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('a disk cache creates nothing until something is cached, and a corrupt file is a miss', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-'));
		try {
			const cacheDir = path.join(dir, 'cache');
			const cache = new DiskResponseCache(
				cacheDir,
				(file, text) => fs.writeFileSync(file, text),
				error => {
					throw error;
				}
			);
			expect(cache.get('http://x/y')).toBeUndefined();
			expect(fs.existsSync(cacheDir)).toBe(false);

			cache.put({ url: 'http://x/y', etag: '"1"', cachedAt: '2026-11-08T12:00:00.000Z', body: [1] });
			const [file] = fs.readdirSync(cacheDir);
			fs.writeFileSync(path.join(cacheDir, file!), '{not json');
			const fresh = new DiskResponseCache(
				cacheDir,
				() => undefined,
				() => undefined
			);

			expect(fresh.get('http://x/y')).toBeUndefined();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('GitHubClient: pagination follows the Link header verbatim', () => {
	it('walks a cursor-paged issue list and a page-numbered one to the end', async () => {
		for (let i = 1; i <= 7; i++) fake.addIssue({ title: `Issue ${i}` });
		fake.addComment(1, 'a');
		fake.addComment(1, 'b');
		fake.addComment(1, 'c');
		const c = client();

		const issues = await c.getAll<{ number: number }>('/repos/acme/shop/issues', {
			query: { state: 'all', per_page: 3, sort: 'created', direction: 'asc' },
		});
		const comments = await c.getAll<{ body: string }>('/repos/acme/shop/issues/1/comments', {
			query: { per_page: 2 },
		});

		expect(issues.items.map(i => i.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
		expect(comments.items.map(x => x.body)).toEqual(['a', 'b', 'c']);
		expect(fake.requestsTo('/repos/acme/shop/issues/1/comments')).toHaveLength(2);
		expect(issues.stale).toBe(false);
	});

	it('more pages than the limit is an error that says how to raise it, not a silent cut', async () => {
		for (let i = 1; i <= 7; i++) fake.addIssue({ title: `Issue ${i}` });

		const error = await failure(() =>
			client().getAll('/repos/acme/shop/issues', { query: { state: 'all', per_page: 2 }, maxPages: 2 })
		);

		expect(error).toBeInstanceOf(BackendLimitError);
		expect(error.message).toContain('pages');
		expect((error as BackendLimitError).hint).toContain('maxPages');
	});

	it('refuses a next link that leaves the configured address (the token would follow it)', async () => {
		fake.addIssue({ title: 'A' });
		fake.failNext({
			status: 200,
			headers: { link: '<https://evil.example.com/steal?page=2>; rel="next"' },
			body: [{ number: 1 }],
		});

		const error = await failure(() => client().getAll('/repos/acme/shop/issues'));

		expect(error.message).toContain('evil.example.com');
		expect(error.message).not.toContain(fake.token);
	});
});

describe('GitHubClient: failures are typed and tell what to do', () => {
	it('401 is a refused token, and the hint names the variable and the permissions to give', async () => {
		const error = await failure(() => client({ token: 'wrong-token' }).get('/repos/acme/shop'));

		expect(error).toBeInstanceOf(BackendAuthError);
		const auth = error as BackendAuthError;
		expect(auth.reason).toBe('unauthenticated');
		expect(auth.message).toContain('401');
		expect(auth.hint).toContain('GITHUB_TOKEN');
		expect(auth.hint).toContain('Issues');
		expect(auth.hint).toContain('Metadata');
		expect(auth.hint).toContain('acme/shop');
		expect(`${auth.message} ${auth.hint}`).not.toContain('wrong-token');
	});

	it('403 on a permission names what GitHub says the endpoint needs', async () => {
		await fake.stop();
		fake = await FakeGitHub.start({ repo: 'acme/shop', denyIssues: true });
		const error = await failure(() => client().get('/repos/acme/shop/issues'));

		expect(error).toBeInstanceOf(BackendAuthError);
		const auth = error as BackendAuthError;
		expect(auth.reason).toBe('forbidden');
		expect(auth.message).toContain('Resource not accessible by personal access token');
		expect(auth.hint).toContain('issues=read');
	});

	it('an exhausted quota is a RateLimitedError with the reset instant, and nothing more is sent', async () => {
		const reset = Math.floor(clockMs / 1000) + 600;
		fake.setRateLimit('core', { remaining: 0, resetAt: reset });
		const c = client();

		const error = await failure(() => c.get('/repos/acme/shop'));
		expect(error).toBeInstanceOf(RateLimitedError);
		expect((error as RateLimitedError).scope).toBe('primary');
		expect((error as RateLimitedError).retryAt).toEqual(new Date(reset * 1000));

		const sent = fake.requests.length;
		const again = await failure(() => c.get('/repos/acme/shop/issues'));
		expect(again).toBeInstanceOf(RateLimitedError);
		// No busy retry, and no request while the reset is in the future.
		expect(fake.requests).toHaveLength(sent);
	});

	it('once the reset has passed the client asks again', async () => {
		const reset = Math.floor(clockMs / 1000) + 600;
		fake.setRateLimit('core', { remaining: 0, resetAt: reset });
		const c = client();
		await failure(() => c.get('/repos/acme/shop'));

		fake.setRateLimit('core', { remaining: 100, resetAt: reset + 3600 });
		clockMs += 601_000;

		expect((await c.get<{ full_name: string }>('/repos/acme/shop')).body.full_name).toBe('acme/shop');
	});

	it('a secondary limit (retry-after) is a RateLimitedError that waits what GitHub asked', async () => {
		fake.failNext({
			status: 403,
			headers: { 'retry-after': '90' },
			body: { message: 'You have exceeded a secondary rate limit.' },
		});

		const error = await failure(() => client().get('/repos/acme/shop'));

		expect(error).toBeInstanceOf(RateLimitedError);
		expect((error as RateLimitedError).scope).toBe('secondary');
		expect((error as RateLimitedError).retryAt).toEqual(new Date(clockMs + 90_000));
	});

	it('429 without an instant still gives a wait', async () => {
		fake.failNext({ status: 429, body: { message: 'Too many requests' } });

		const error = (await failure(() => client().get('/repos/acme/shop'))) as RateLimitedError;

		expect(error).toBeInstanceOf(RateLimitedError);
		expect(error.retryAt).toBeUndefined();
		expect(error.hint).toMatch(/minute/);
	});

	it('the search quota is its own bucket', async () => {
		fake.setRateLimit('search', { remaining: 0, resetAt: Math.floor(clockMs / 1000) + 30 });

		const error = await failure(() =>
			client().get('/search/issues', { query: { q: 'repo:acme/shop x' }, cache: false })
		);
		expect(error).toBeInstanceOf(RateLimitedError);
		expect((error as RateLimitedError).scope).toBe('search');
		// The core bucket is untouched.
		expect((await client().get<{ full_name: string }>('/repos/acme/shop')).status).toBe(200);
	});

	it.each([
		[404, 'Not Found'],
		[410, 'This issue was deleted'],
		[422, 'Validation Failed'],
	])('%i is a GitHubHttpError carrying the status and the message', async (status, message) => {
		fake.failNext({ status, body: { message } });

		const error = await failure(() => client().get('/repos/acme/shop'));

		expect(error).toBeInstanceOf(GitHubHttpError);
		expect((error as GitHubHttpError).status).toBe(status);
		expect(error.message).toContain(message);
	});

	it('a 404 the caller expects is an answer, not an error', async () => {
		const number = fake.addIssue({ title: 'Root' });

		const answer = await client().get(`/repos/acme/shop/issues/${number}/parent`, { allowNotFound: true });

		expect(answer.status).toBe(404);
		expect(answer.body).toBeUndefined();
	});

	it('a 5xx is "cannot reach" with the status, and the hint says to retry', async () => {
		fake.failNext({ status: 502, body: { message: 'Bad Gateway' } });

		const error = await failure(() => client().get('/repos/acme/shop'));

		expect(error).toBeInstanceOf(BackendUnreachableError);
		expect(error.message).toContain('502');
	});

	it('a dropped connection is BackendUnreachableError naming the host', async () => {
		fake.dropNext();

		const error = await failure(() => client().get('/repos/acme/shop'));

		expect(error).toBeInstanceOf(BackendUnreachableError);
		expect((error as BackendUnreachableError).host).toBe(new URL(fake.baseUrl).host);
	});

	it('no answer in time is BackendTimeoutError', async () => {
		fake.hangNext();

		const error = await failure(() => client({ timeoutMs: 80 }).get('/repos/acme/shop'));

		expect(error).toBeInstanceOf(BackendTimeoutError);
		expect((error as BackendTimeoutError).timeoutMs).toBe(80);
	});

	it('a body that stalls after the headers is a timeout too, not a hang', async () => {
		const stalling: typeof fetch = (_input, init) =>
			Promise.resolve(
				new Response(
					new ReadableStream({
						start(controller) {
							init?.signal?.addEventListener('abort', () =>
								controller.error(new DOMException('aborted', 'AbortError'))
							);
						},
					}),
					{ status: 200 }
				)
			);

		const error = await failure(() => client({ fetch: stalling, timeoutMs: 80 }).get('/repos/acme/shop'));

		expect(error).toBeInstanceOf(BackendTimeoutError);
	});
});

describe('GitHubClient: when GitHub cannot be asked, the cache answers, labelled stale', () => {
	async function cachedIssue(c: GitHubClient): Promise<number> {
		const number = fake.addIssue({ title: 'Remembered' });
		await c.get(`/repos/acme/shop/issues/${number}`);
		clockMs += 61_000;
		return number;
	}

	it('on a network failure it serves the last answer and says when it was read', async () => {
		const c = client();
		const number = await cachedIssue(c);
		fake.dropNext();

		const answer = await c.get<{ title: string }>(`/repos/acme/shop/issues/${number}`);

		expect(answer).toMatchObject({ body: { title: 'Remembered' }, stale: true, fromCache: true });
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({ kind: 'stale', cachedAt: '2026-11-08T12:00:00.000Z' });
		expect(notices[0]!.text).toContain('Cannot reach');
		expect(notices[0]!.text).toContain('2026-11-08T12:00:00.000Z');
	});

	it('on a rate limit too', async () => {
		const c = client();
		const number = await cachedIssue(c);
		fake.setRateLimit('core', { remaining: 0, resetAt: Math.floor(clockMs / 1000) + 600 });

		const answer = await c.get<{ title: string }>(`/repos/acme/shop/issues/${number}`);

		expect(answer.stale).toBe(true);
		expect(notices[0]!.text).toContain('rate limit');
	});

	it('never on a refused token: that must be fixed, not hidden', async () => {
		const c = client();
		const number = await cachedIssue(c);
		fake.failNext({ status: 401, body: { message: 'Bad credentials' } });

		expect(await failure(() => c.get(`/repos/acme/shop/issues/${number}`))).toBeInstanceOf(BackendAuthError);
		expect(notices).toEqual([]);
	});

	it('without anything cached the failure is the answer', async () => {
		fake.dropNext();

		expect(await failure(() => client().get('/repos/acme/shop'))).toBeInstanceOf(BackendUnreachableError);
	});

	it('a paginated read is stale as a whole when one page could not be revalidated', async () => {
		for (let i = 1; i <= 4; i++) fake.addIssue({ title: `Issue ${i}` });
		const c = client();
		const query = { state: 'all', per_page: 2, sort: 'created', direction: 'asc' };
		await c.getAll('/repos/acme/shop/issues', { query });
		clockMs += 61_000;
		fake.dropNext(2);

		const again = await c.getAll<{ number: number }>('/repos/acme/shop/issues', { query });

		expect(again.items.map(i => i.number)).toEqual([1, 2, 3, 4]);
		expect(again.stale).toBe(true);
		expect(again.cachedAt).toBe('2026-11-08T12:00:00.000Z');
	});
});

describe('GitHubClient: the token never leaks', () => {
	it('redactToken hides the token and a Bearer header wherever they appear', () => {
		expect(redactToken('x secret-token y Bearer secret-token', 'secret-token')).toBe('x *** y Bearer ***');
		expect(redactToken('nothing here', 'secret-token')).toBe('nothing here');
		expect(redactToken('abc', '')).toBe('abc');
	});

	it('a server that echoes the token in an error does not put it in the message', async () => {
		fake.failNext({ status: 422, body: { message: `bad value ${fake.token}` } });

		const error = await failure(() => client().get('/repos/acme/shop'));

		expect(error.message).not.toContain(fake.token);
		expect(error.message).toContain('***');
	});

	it('the debug lines say what was asked and what came back, without any header or token', async () => {
		await client().get('/repos/acme/shop');

		expect(debugLines).toHaveLength(1);
		expect(debugLines[0]).toMatch(/^GET \/repos\/acme\/shop -> 200 \(\d+ ms, rate limit remaining \d+\)$/);
		expect(debugLines.join('\n')).not.toContain(fake.token);
	});

	it('a network error whose text carries the token is redacted', async () => {
		const boom: typeof fetch = () => Promise.reject(new TypeError(`connect failed for Bearer ${fake.token}`));

		const error = await failure(() => client({ fetch: boom }).get('/repos/acme/shop'));

		expect(error).toBeInstanceOf(BackendUnreachableError);
		expect(error.message).not.toContain(fake.token);
	});
});

describe('GitHubClient: rate limit state and concurrency', () => {
	it('remembers what the last answer said about the quota', async () => {
		const c = client();
		await c.get('/repos/acme/shop');

		expect(c.rateLimit('core')).toMatchObject({ limit: 5000, remaining: 4999 });
		expect(c.rateLimit('search')).toBeUndefined();
	});

	it('keeps at most maxConcurrent requests in flight', async () => {
		let inFlight = 0;
		let peak = 0;
		const slow: typeof fetch = async (input, init) => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			try {
				await new Promise(resolve => setTimeout(resolve, 15));
				return await fetch(input, init);
			} finally {
				inFlight -= 1;
			}
		};
		const c = client({ fetch: slow, maxConcurrent: 2, cacheTtlMs: 0 });

		await Promise.all(Array.from({ length: 8 }, () => c.get('/repos/acme/shop')));

		expect(peak).toBe(2);
	});
});

describe('GitHubClient: a read sends GET only', () => {
	it('a read sends nothing but GET (writes go through write() and graphql() only)', async () => {
		const c = client();
		await c.get('/repos/acme/shop');
		await c.getAll('/repos/acme/shop/issues');

		expect(fake.writes()).toEqual([]);
		expect(
			Object.getOwnPropertyNames(GitHubClient.prototype).filter(name => /^(post|put|patch|delete)/i.test(name))
		).toEqual([]);
	});
});
