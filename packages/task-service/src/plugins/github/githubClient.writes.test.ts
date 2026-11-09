import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { BackendAuthError, BackendUnreachableError, RateLimitedError } from '@wadeck-app/task-core';

import { FakeGitHub } from './fakeGitHub.testkit.js';
import { GitHubClient, GitHubHttpError, graphqlUrlOf } from './githubClient.js';
import type { GitHubClientOptions, GitHubServerFailure } from './githubClient.js';
import { DiskResponseCache, MemoryResponseCache } from './responseCache.js';

let fake: FakeGitHub;
let clockMs: number;
let debugLines: string[];

beforeEach(async () => {
	fake = await FakeGitHub.start({ repo: 'acme/shop' });
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
		debug: line => debugLines.push(line),
		writeSpacingMs: 0,
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

function sleeper(): { waits: number[]; sleep: (ms: number) => Promise<void> } {
	const waits: number[] = [];
	return {
		waits,
		sleep: ms => {
			waits.push(ms);
			return Promise.resolve();
		},
	};
}

describe('GitHubClient: writes', () => {
	it('sends the method, the JSON body and the content type with the same headers as a read, and parses the answer', async () => {
		const number = fake.addIssue({ title: 'First' });
		const seen: Array<{ method?: string; body?: unknown; headers: Record<string, string> }> = [];
		const spy: typeof fetch = (input, init) => {
			seen.push({
				method: init?.method,
				body: init?.body,
				headers: Object.fromEntries(new Headers(init?.headers).entries()),
			});
			return fetch(input, init);
		};

		const answer = await client({ fetch: spy }).write<{ title: string }>(
			'PATCH',
			`/repos/acme/shop/issues/${number}`,
			{
				title: 'Renamed',
			}
		);

		expect(answer).toMatchObject({ status: 200, body: { title: 'Renamed' } });
		expect(seen[0]).toMatchObject({ method: 'PATCH', body: JSON.stringify({ title: 'Renamed' }) });
		expect(seen[0]!.headers).toMatchObject({
			authorization: `Bearer ${fake.token}`,
			'content-type': 'application/json',
			accept: 'application/vnd.github+json',
			'x-github-api-version': '2022-11-28',
		});
	});

	it('a 201 and a 204 are answers; a 204 has no body', async () => {
		const number = fake.addIssue({ title: 'First' });
		const c = client();

		const created = await c.write<{ id: number }>('POST', `/repos/acme/shop/issues/${number}/comments`, {
			body: 'hi',
		});
		const removed = await c.write('DELETE', `/repos/acme/shop/issues/comments/${created.body.id}`);

		expect(created.status).toBe(201);
		expect(removed.status).toBe(204);
		expect(removed.body).toBeUndefined();
	});

	it('serializes writes: at least writeSpacingMs between the start of two of them', async () => {
		fake.addIssue({ title: 'First' });
		const { waits, sleep } = sleeper();
		const c = client({ writeSpacingMs: 1000, sleep });

		await Promise.all([
			c.write('POST', '/repos/acme/shop/issues/1/comments', { body: 'a' }),
			c.write('POST', '/repos/acme/shop/issues/1/comments', { body: 'b' }),
			c.write('POST', '/repos/acme/shop/issues/1/comments', { body: 'c' }),
		]);

		// The first write goes at once; each of the two others waited the spacing (the clock is frozen).
		expect(waits).toEqual([1000, 1000]);
		expect(fake.writes().map(request => (request.body as { body: string }).body)).toEqual(['a', 'b', 'c']);
	});

	it('never has two writes in flight', async () => {
		const slow = await FakeGitHub.start({ repo: 'acme/shop', latencyMs: 30 });
		try {
			slow.addIssue({ title: 'First' });
			let inFlight = 0;
			let peak = 0;
			const spy: typeof fetch = async (input, init) => {
				inFlight += 1;
				peak = Math.max(peak, inFlight);
				try {
					return await fetch(input, init);
				} finally {
					inFlight -= 1;
				}
			};
			const c = client({ baseUrl: slow.baseUrl, token: slow.token, fetch: spy });

			await Promise.all(
				[1, 2, 3].map(i => c.write('POST', '/repos/acme/shop/issues/1/comments', { body: `n${i}` }))
			);

			expect(peak).toBe(1);
		} finally {
			await slow.stop();
		}
	});

	it('a failed write does not block the next one', async () => {
		fake.addIssue({ title: 'First' });
		fake.failNext({ status: 422, body: { message: 'Validation Failed' } });
		const c = client();

		await failure(() => c.write('POST', '/repos/acme/shop/issues/1/comments', { body: 'a' }));
		const next = await c.write('POST', '/repos/acme/shop/issues/1/comments', { body: 'b' });

		expect(next.status).toBe(201);
	});

	it('a write expires the cache: the next read asks again (conditionally) even inside the TTL', async () => {
		fake.addIssue({ title: 'First' });
		const c = client();
		await c.get('/repos/acme/shop/issues/1');
		await c.get('/repos/acme/shop/issues/1');
		expect(fake.requestsTo('/repos/acme/shop/issues/1')).toHaveLength(1);

		clockMs += 1000;
		await c.write('PATCH', '/repos/acme/shop/issues/1', { title: 'Renamed' });
		clockMs += 1000;
		const after = await c.get<{ title: string }>('/repos/acme/shop/issues/1');

		expect(after.body.title).toBe('Renamed');
		expect(after.fromCache).toBe(false);
	});

	it('the expiry survives the process: a disk cache written before a write is revalidated by the next process', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-github-expiry-'));
		try {
			fake.addIssue({ title: 'First' });
			const open = (): GitHubClient =>
				client({
					cache: new DiskResponseCache(
						dir,
						(file, content) => fs.writeFileSync(file, content),
						() => undefined
					),
				});
			await open().get('/repos/acme/shop/issues/1');
			clockMs += 1000;
			await open().write('PATCH', '/repos/acme/shop/issues/1', { title: 'Renamed' });
			clockMs += 1000;

			const next = await open().get<{ title: string }>('/repos/acme/shop/issues/1');

			expect(next.fromCache).toBe(false);
			expect(next.body.title).toBe('Renamed');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('revalidate: true skips the TTL fast path and asks with If-None-Match', async () => {
		fake.addIssue({ title: 'First' });
		const c = client();
		await c.get('/repos/acme/shop/issues/1');

		const again = await c.get('/repos/acme/shop/issues/1', { revalidate: true });

		expect(again.status).toBe(200);
		expect(fake.requestsTo('/repos/acme/shop/issues/1').map(request => request.conditional)).toEqual([false, true]);
	});

	it('a secondary limit with a short retry-after is waited out and the write retried', async () => {
		fake.addIssue({ title: 'First' });
		fake.failNext({
			status: 403,
			headers: { 'retry-after': '3' },
			body: { message: 'You have exceeded a secondary rate limit.' },
		});
		const { waits, sleep } = sleeper();

		const answer = await client({ sleep }).write('POST', '/repos/acme/shop/issues/1/comments', { body: 'hi' });

		expect(answer.status).toBe(201);
		expect(waits).toEqual([3000]);
		expect(fake.writes()).toHaveLength(2);
		expect(debugLines.join('\n')).toContain('secondary rate limit');
	});

	it('a long retry-after is a RateLimitedError at once, with the instant, and nothing is retried', async () => {
		fake.addIssue({ title: 'First' });
		fake.failNext({
			status: 403,
			headers: { 'retry-after': '120' },
			body: { message: 'You have exceeded a secondary rate limit.' },
		});
		const { waits, sleep } = sleeper();

		const error = await failure(() =>
			client({ sleep }).write('POST', '/repos/acme/shop/issues/1/comments', { body: 'hi' })
		);

		expect(error).toBeInstanceOf(RateLimitedError);
		expect((error as RateLimitedError).retryAt).toEqual(new Date(clockMs + 120_000));
		expect(waits).toEqual([]);
		expect(fake.writes()).toHaveLength(1);
	});

	it('gives up after two waits when the limit keeps answering', async () => {
		fake.addIssue({ title: 'First' });
		fake.failNext({ status: 403, headers: { 'retry-after': '1' }, body: { message: 'secondary rate limit' } }, 5);
		const { sleep } = sleeper();

		const error = await failure(() =>
			client({ sleep }).write('POST', '/repos/acme/shop/issues/1/comments', { body: 'hi' })
		);

		expect(error).toBeInstanceOf(RateLimitedError);
		expect(fake.writes()).toHaveLength(3);
	});

	it('a 5xx on a write is an unreachable error that carries the status, and is never retried', async () => {
		fake.addIssue({ title: 'First' });
		fake.failNext({ status: 502, body: { message: 'Server Error' } });

		const error = await failure(() =>
			client().write('POST', '/repos/acme/shop/issues/1/labels', { labels: ['a'] })
		);

		expect(error).toBeInstanceOf(BackendUnreachableError);
		expect((error as GitHubServerFailure).status).toBe(502);
		expect(fake.writes()).toHaveLength(1);
	});

	it('a 422 is a GitHubHttpError with the status, the message and every error text', async () => {
		const error = await failure(() =>
			client().write('POST', '/repos/acme/shop/labels', { name: 'x'.repeat(51), color: 'ededed' })
		);

		expect(error).toBeInstanceOf(GitHubHttpError);
		const http = error as GitHubHttpError;
		expect(http.status).toBe(422);
		expect(http.detail).toBe('Validation Failed');
		expect(http.errors).toEqual(['name is too long (maximum is 50 characters)']);
	});

	it('a 403 on a write names what GitHub says the endpoint needs', async () => {
		const readOnly = await FakeGitHub.start({ repo: 'acme/shop', readOnlyToken: true });
		try {
			const error = await failure(() =>
				client({ baseUrl: readOnly.baseUrl, token: readOnly.token }).write('POST', '/repos/acme/shop/issues', {
					title: 'x',
				})
			);

			expect(error).toBeInstanceOf(BackendAuthError);
			expect((error as BackendAuthError).reason).toBe('forbidden');
			expect((error as BackendAuthError).hint).toContain('issues=write');
		} finally {
			await readOnly.stop();
		}
	});

	it('a 403 on a write without that header still asks for Issues read and write', async () => {
		fake.failNext({ status: 403, body: { message: 'Resource not accessible by personal access token' } });

		const error = await failure(() => client().write('POST', '/repos/acme/shop/issues', { title: 'x' }));

		expect((error as BackendAuthError).hint).toContain('Issues: Read and write');
	});

	it('a 401 on a write asks for Issues read and write', async () => {
		const error = await failure(() =>
			client({ token: 'wrong' }).write('POST', '/repos/acme/shop/issues', { title: 'x' })
		);

		expect(error).toBeInstanceOf(BackendAuthError);
		expect((error as BackendAuthError).hint).toContain('Issues: Read and write');
	});

	it('an empty quota stops a write before it is sent', async () => {
		// The fake's quota resets at 11:00: the clock must be before it for the client to hold back.
		clockMs = Date.parse('2026-11-08T10:30:00Z');
		fake.setRateLimit('core', { remaining: 0 });
		const c = client();
		await failure(() => c.get('/repos/acme/shop'));
		fake.setRateLimit('core', { remaining: 5000 });
		const before = fake.requests.length;

		const error = await failure(() => c.write('POST', '/repos/acme/shop/issues', { title: 'x' }));

		expect(error).toBeInstanceOf(RateLimitedError);
		expect(fake.requests.length).toBe(before);
	});

	it('the token appears in no error of a write', async () => {
		fake.addIssue({ title: 'First' });
		fake.failNext({ status: 422, body: { message: `bad ${fake.token}`, errors: [`echo ${fake.token}`] } });

		const error = await failure(() => client().write('POST', '/repos/acme/shop/issues/1/comments', { body: 'x' }));

		const http = error as GitHubHttpError;
		expect(JSON.stringify([http.message, http.detail, http.errors])).not.toContain(fake.token);
	});

	it('the debug line of a write says the method and path, never the body', async () => {
		fake.addIssue({ title: 'First' });

		await client().write('POST', '/repos/acme/shop/issues/1/comments', { body: 'secret text' });

		const lines = debugLines.join('\n');
		expect(lines).toContain('POST /repos/acme/shop/issues/1/comments -> 201');
		expect(lines).not.toContain('secret text');
	});

	it('has no method named after an HTTP verb: writes go through write() and graphql() only', () => {
		expect(
			Object.getOwnPropertyNames(GitHubClient.prototype).filter(name => /^(post|put|patch|delete)/i.test(name))
		).toEqual([]);
	});
});

describe('GitHubClient: GraphQL', () => {
	it('posts the query to /graphql and returns data and errors; a FORBIDDEN error is data, not an exception', async () => {
		const restricted = await FakeGitHub.start({ repo: 'acme/shop', admin: false });
		try {
			restricted.addIssue({ title: 'Mine' });
			const c = client({ baseUrl: restricted.baseUrl, token: restricted.token });

			const answer = await c.graphql<{ deleteIssue: unknown }>(
				'mutation($id: ID!) { deleteIssue(input: {issueId: $id}) { clientMutationId } }',
				{ id: `I_${restricted.issues.get(1)!.id}` }
			);

			expect(answer.errors?.[0]).toMatchObject({ type: 'FORBIDDEN' });
			expect(restricted.writes()[0]).toMatchObject({ method: 'POST', path: '/graphql' });
		} finally {
			await restricted.stop();
		}
	});

	it('the GraphQL address of a GitHub Enterprise Server is /api/graphql, next to /api/v3', () => {
		expect(graphqlUrlOf('https://api.github.com')).toBe('https://api.github.com/graphql');
		expect(graphqlUrlOf('https://git.example.com/api/v3')).toBe('https://git.example.com/api/graphql');
		expect(graphqlUrlOf('http://127.0.0.1:4000')).toBe('http://127.0.0.1:4000/graphql');
	});
});
