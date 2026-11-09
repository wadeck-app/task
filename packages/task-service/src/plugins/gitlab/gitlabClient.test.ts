import {
	BackendAuthError,
	BackendDataError,
	BackendLimitError,
	BackendTimeoutError,
	BackendUnreachableError,
	RateLimitedError,
} from '@wadeck-app/task-core';

import type { ReadNotice } from '../kinds.js';
import { GitLabClient, GitLabHttpError, GitLabServerFailure, redactToken } from './gitlabClient.js';
import type { GitLabClientOptions } from './gitlabClient.js';

const TOKEN = 'glpat-SECRET-TOKEN-123';
const BASE = 'https://gitlab.example/api/v4';

interface Call {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string | undefined;
}

type Reply = {
	status?: number;
	body?: unknown;
	/** Sent as is (not JSON-encoded). */
	text?: string;
	headers?: Record<string, string>;
};
type Handler = Reply | ((call: Call) => Reply | Promise<Reply>) | Error;

let calls: Call[];
let queue: Handler[];
let notices: ReadNotice[];
let debugLines: string[];
let waits: number[];
let clockMs: number;

beforeEach(() => {
	calls = [];
	queue = [];
	notices = [];
	debugLines = [];
	waits = [];
	clockMs = Date.parse('2026-11-08T12:00:00Z');
});

const stubFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
	const call: Call = {
		url: String(input),
		method: init?.method ?? 'GET',
		headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
		body: init?.body === undefined ? undefined : String(init.body),
	};
	calls.push(call);
	const handler = queue.shift();
	if (handler === undefined) throw new Error(`no reply queued for ${call.method} ${call.url}`);
	if (handler instanceof Error) throw handler;
	const reply = typeof handler === 'function' ? await handler(call) : handler;
	const text = reply.text ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
	return new Response(reply.status === 204 || reply.status === 304 ? null : text, {
		status: reply.status ?? 200,
		headers: reply.headers ?? {},
	});
}) as typeof fetch;

function client(overrides: Partial<GitLabClientOptions> = {}): GitLabClient {
	return new GitLabClient({
		baseUrl: BASE,
		token: TOKEN,
		project: 'acme/shop',
		tokenHint: 'the environment variable GITLAB_TOKEN (strategy.options.tokenEnv)',
		timeoutMs: 2000,
		cacheTtlMs: 60_000,
		now: () => clockMs,
		fetch: stubFetch,
		onNotice: notice => notices.push(notice),
		debug: line => debugLines.push(line),
		writeSpacingMs: 0,
		sleep: ms => {
			waits.push(ms);
			return Promise.resolve();
		},
		...overrides,
	});
}

async function failure(call: () => Promise<unknown>): Promise<Error> {
	try {
		await call();
	} catch (error) {
		return error as Error;
	}
	throw new Error('expected a failure');
}

describe('GitLabClient: a plain read', () => {
	it('sends PRIVATE-TOKEN (and no bearer) to the base address and parses the JSON', async () => {
		queue.push({ body: [{ iid: 1 }] });
		const response = await client().get<Array<{ iid: number }>>('/projects/acme%2Fshop/issues', {
			query: { state: 'all', per_page: 100 },
		});

		expect(response.body).toEqual([{ iid: 1 }]);
		expect(response.status).toBe(200);
		expect(response.fromCache).toBe(false);
		expect(calls[0]!.url).toBe(`${BASE}/projects/acme%2Fshop/issues?per_page=100&state=all`);
		expect(calls[0]!.headers['private-token']).toBe(TOKEN);
		expect(calls[0]!.headers['authorization']).toBeUndefined();
		expect(calls[0]!.headers['accept']).toBe('application/json');
	});

	it('writes one debug line per request without any header or token', async () => {
		queue.push({ body: [], headers: { 'ratelimit-remaining': '1999' } });
		await client().get('/version');
		expect(debugLines).toHaveLength(1);
		expect(debugLines[0]).toMatch(/^GET \/version -> 200 \(\d+ ms, rate limit remaining 1999\)$/);
		expect(debugLines.join('\n')).not.toContain(TOKEN);
	});

	it('answers an allowed 404 without a body and fails an unexpected one with the path', async () => {
		queue.push({ status: 404, body: { message: '404 Not found' } });
		const allowed = await client().get('/projects/1/issues/9', { allowNotFound: true });
		expect(allowed.status).toBe(404);
		expect(allowed.body).toBeUndefined();

		queue.push({ status: 404, body: { message: '404 Project Not Found' } });
		const error = await failure(() => client().get('/projects/1'));
		expect(error).toBeInstanceOf(GitLabHttpError);
		expect((error as GitLabHttpError).status).toBe(404);
		expect(error.message).toBe('GitLab answered 404 for GET /projects/1: 404 Project Not Found');
	});

	it('refuses an answer that is not JSON', async () => {
		queue.push({ text: '<html>' });
		const error = await failure(() => client().get('/version'));
		expect(error).toBeInstanceOf(GitLabHttpError);
		expect(error.message).toContain('not JSON');
	});
});

describe('GitLabClient: failures', () => {
	it('401 is a refused token whose hint names the variable and the scope, never the token', async () => {
		queue.push({ status: 401, body: { message: `401 Unauthorized ${TOKEN}` } });
		const error = (await failure(() => client().get('/user'))) as BackendAuthError;
		expect(error).toBeInstanceOf(BackendAuthError);
		expect(error.reason).toBe('unauthenticated');
		expect(error.hint).toContain('GITLAB_TOKEN');
		expect(error.hint).toContain('read_api');
		expect(error.hint).toContain('acme/shop');
		expect(`${error.message}${error.hint}`).not.toContain(TOKEN);
		expect(error.message).toContain('***');
	});

	it('a write 401 asks for the scope api', async () => {
		queue.push({ status: 401, body: { message: '401 Unauthorized' } });
		const error = (await failure(() =>
			client().write('POST', '/projects/1/issues', { title: 'x' })
		)) as BackendAuthError;
		expect(error.hint).toContain('scope api');
		expect(error.hint).not.toContain('read_api');
	});

	it('403 insufficient_scope names the scope to give', async () => {
		queue.push({
			status: 403,
			body: { error: 'insufficient_scope', error_description: 'needs api' },
			headers: {
				'www-authenticate':
					'Bearer realm="Protected by OAuth 2.0", error="insufficient_scope", scope="api read_api"',
			},
		});
		const error = (await failure(() => client().write('PUT', '/projects/1/issues/1', {}))) as BackendAuthError;
		expect(error).toBeInstanceOf(BackendAuthError);
		expect(error.reason).toBe('forbidden');
		expect(error.message).toContain('insufficient_scope');
		expect(error.hint).toContain('scope api');
	});

	it('403 otherwise names the role, the delete rule and the issues setting', async () => {
		queue.push({ status: 403, body: { message: '403 Forbidden' } });
		const error = (await failure(() => client().write('DELETE', '/projects/1/issues/1'))) as BackendAuthError;
		expect(error.reason).toBe('forbidden');
		expect(error.message).toBe('GitLab refused the request (403 403 Forbidden)');
		expect(error.hint).toContain('Planner or Owner');
		expect(error.hint).toContain('issues must be enabled');
		expect(error.hint).toContain('GITLAB_TOKEN');
	});

	it('429 with Retry-After is a secondary RateLimitedError with the instant', async () => {
		queue.push({ status: 429, text: 'Retry later', headers: { 'retry-after': '30' } });
		const error = (await failure(() => client().get('/version'))) as RateLimitedError;
		expect(error).toBeInstanceOf(RateLimitedError);
		expect(error.scope).toBe('secondary');
		expect(error.retryAt?.toISOString()).toBe('2026-11-08T12:00:30.000Z');
	});

	it('429 without Retry-After has no instant', async () => {
		queue.push({ status: 429, text: 'Retry later' });
		const error = (await failure(() => client().get('/version'))) as RateLimitedError;
		expect(error.retryAt).toBeUndefined();
	});

	it('an empty quota fails WITHOUT sending, until the reset instant', async () => {
		const resetAt = clockMs / 1000 + 60;
		queue.push({
			body: [],
			headers: { 'ratelimit-limit': '60', 'ratelimit-remaining': '0', 'ratelimit-reset': String(resetAt) },
		});
		const c = client({ cacheTtlMs: 0 });
		await c.get('/a');
		expect(c.rateLimit()).toEqual({ limit: 60, remaining: 0, resetAt });

		const error = (await failure(() => c.get('/b'))) as RateLimitedError;
		expect(error.scope).toBe('primary');
		expect(error.retryAt?.getTime()).toBe(resetAt * 1000);
		expect(calls).toHaveLength(1);

		clockMs += 61_000;
		queue.push({ body: [] });
		await c.get('/b');
		expect(calls).toHaveLength(2);
	});

	it('5xx is a GitLabServerFailure (unreachable) with the status and message, token redacted', async () => {
		queue.push({ status: 502, body: { message: `bad gateway ${TOKEN}` } });
		const error = (await failure(() => client().get('/version'))) as GitLabServerFailure;
		expect(error).toBeInstanceOf(GitLabServerFailure);
		expect(error).toBeInstanceOf(BackendUnreachableError);
		expect(error.status).toBe(502);
		expect(error.message).toContain('HTTP 502');
		expect(error.message).not.toContain(TOKEN);
	});

	it('a lost connection is unreachable with the cause code and without the token', async () => {
		const cause = Object.assign(new Error(`connect ECONNREFUSED ${TOKEN}`), { code: 'ECONNREFUSED' });
		queue.push(Object.assign(new TypeError('fetch failed'), { cause }));
		const error = await failure(() => client().get('/version'));
		expect(error).toBeInstanceOf(BackendUnreachableError);
		expect(error.message).toBe('Cannot reach gitlab.example (ECONNREFUSED)');

		queue.push(Object.assign(new TypeError(`fetch failed ${TOKEN}`), { cause: { message: `boom ${TOKEN}` } }));
		const second = await failure(() => client().get('/version'));
		expect(second.message).not.toContain(TOKEN);
	});

	it('a request that does not answer in time is a BackendTimeoutError', async () => {
		const hanging = ((_url: string, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
			})) as unknown as typeof fetch;
		const error = await failure(() => client({ fetch: hanging, timeoutMs: 20 }).get('/version'));
		expect(error).toBeInstanceOf(BackendTimeoutError);
		expect(error.message).toBe('gitlab.example did not answer within 0 s');
	});

	it('422 validation errors are listed field by field', async () => {
		queue.push({ status: 400, body: { message: { title: ["can't be blank", 'is too long'], labels: 'invalid' } } });
		const error = (await failure(() => client().write('POST', '/projects/1/issues', {}))) as GitLabHttpError;
		expect(error).toBeInstanceOf(GitLabHttpError);
		expect(error.errors).toEqual(["title can't be blank", 'title is too long', 'labels invalid']);
		expect(error.detail).toBe("title can't be blank; title is too long; labels invalid");
	});

	it('reads the OAuth style {"error": ...} body and a plain-text error', async () => {
		queue.push({ status: 409, body: { error: 'conflict', error_description: 'again' } });
		expect((await failure(() => client().get('/x'))).message).toBe(
			'GitLab answered 409 for GET /x: conflict: again'
		);
		queue.push({ status: 405, text: 'Non GET methods are not allowed for moved projects' });
		expect((await failure(() => client().get('/y'))).message).toContain('Non GET methods are not allowed');
	});
});

describe('GitLabClient: redirects', () => {
	it('follows a redirect inside the base address, keeping the token', async () => {
		queue.push({ status: 301, headers: { location: `${BASE}/projects/9/issues` } }, { body: [{ iid: 1 }] });
		const response = await client().get<unknown[]>('/projects/acme%2Fold/issues');
		expect(response.body).toEqual([{ iid: 1 }]);
		expect(calls[1]!.url).toBe(`${BASE}/projects/9/issues`);
		expect(calls[1]!.headers['private-token']).toBe(TOKEN);
	});

	it('refuses a redirect leaving the base address and never sends the token there', async () => {
		queue.push({ status: 302, headers: { location: 'https://evil.example/api/v4/projects' } });
		const error = await failure(() => client().get('/projects/1'));
		expect(error).toBeInstanceOf(BackendDataError);
		expect(error.message).toContain('evil.example');
		expect(calls).toHaveLength(1);
	});
});

describe('GitLabClient.getAll: pagination', () => {
	it('follows rel="next" verbatim and gathers the items', async () => {
		const next = `${BASE}/projects/1/issues?cursor=abc&page=2&per_page=2`;
		queue.push(
			{
				body: [{ iid: 1 }, { iid: 2 }],
				headers: { link: `<${BASE}/projects/1/issues?page=1>; rel="first", <${next}>; rel="next"` },
			},
			{ body: [{ iid: 3 }] }
		);
		const all = await client().getAll<{ iid: number }>('/projects/1/issues', { query: { per_page: 2 } });
		expect(all.items.map(item => item.iid)).toEqual([1, 2, 3]);
		expect(calls[1]!.url).toBe(next);
		expect(all.stale).toBe(false);
	});

	it('falls back to x-next-page when there is no Link header', async () => {
		queue.push(
			{ body: [{ iid: 1 }], headers: { 'x-next-page': '2' } },
			{ body: [{ iid: 2 }], headers: { 'x-next-page': '' } }
		);
		const all = await client().getAll<{ iid: number }>('/projects/1/issues', { query: { per_page: 1 } });
		expect(all.items).toHaveLength(2);
		expect(calls[1]!.url).toBe(`${BASE}/projects/1/issues?per_page=1&page=2`);
	});

	it('refuses a next link that leaves the base address, without sending the token there', async () => {
		queue.push({
			body: [{ iid: 1 }],
			headers: { link: '<https://evil.example/api/v4/projects/1/issues?page=2>; rel="next"' },
		});
		const error = await failure(() => client().getAll('/projects/1/issues'));
		expect(error).toBeInstanceOf(BackendDataError);
		expect(error.message).toContain('evil.example');
		expect(error.message).not.toContain(TOKEN);
		expect(calls).toHaveLength(1);

		queue.push({ body: [], headers: { link: '<https://gitlab.example/other/path?page=2>; rel="next"' } });
		expect((await failure(() => client().getAll('/projects/2/issues'))).message).toContain('not followed');
		queue.push({ body: [], headers: { link: '<not an address>; rel="next"' } });
		expect((await failure(() => client().getAll('/projects/3/issues'))).message).toContain('not an address');
	});

	it('more pages than maxPages is a BackendLimitError naming the option', async () => {
		const link = (page: number): string => `<${BASE}/projects/1/issues?page=${page}>; rel="next"`;
		queue.push(
			{ body: [{ iid: 1 }], headers: { link: link(2) } },
			{ body: [{ iid: 2 }], headers: { link: link(3) } },
			{ body: [{ iid: 3 }] }
		);
		const error = (await failure(() =>
			client().getAll('/projects/1/issues', { maxPages: 2 })
		)) as BackendLimitError;
		expect(error).toBeInstanceOf(BackendLimitError);
		expect(error.limit).toBe(2);
		expect(error.hint).toContain('strategy.options.maxPages');
		expect(calls).toHaveLength(2);
	});

	it('uses the maxPages of the options by default', async () => {
		queue.push({ body: [], headers: { link: `<${BASE}/a?page=2>; rel="next"` } }, { body: [] });
		const error = await failure(() => client({ maxPages: 1 }).getAll('/a'));
		expect(error).toBeInstanceOf(BackendLimitError);
	});
});

describe('GitLabClient: the read cache', () => {
	it('serves a read inside the TTL without asking, then asks again', async () => {
		queue.push({ body: { v: 1 } }, { body: { v: 2 } });
		const c = client();
		expect((await c.get<{ v: number }>('/a')).body.v).toBe(1);
		clockMs += 59_000;
		const cached = await c.get<{ v: number }>('/a');
		expect(cached.body.v).toBe(1);
		expect(cached.fromCache).toBe(true);
		expect(calls).toHaveLength(1);
		clockMs += 2_000;
		expect((await c.get<{ v: number }>('/a')).body.v).toBe(2);
		expect(calls).toHaveLength(2);
	});

	it('does not cache when the TTL is 0, when cache is false, or when revalidate is asked', async () => {
		queue.push({ body: 1 }, { body: 2 });
		const none = client({ cacheTtlMs: 0 });
		await none.get('/a');
		await none.get('/a');
		expect(calls).toHaveLength(2);

		queue.push({ body: 1 }, { body: 2 }, { body: 3 });
		const c = client();
		await c.get('/b', { cache: false });
		await c.get('/b', { cache: false });
		await c.get('/b');
		await c.get('/b', { revalidate: true });
		expect(calls).toHaveLength(2 + 4);
	});

	it('keys the cache by the sorted query', async () => {
		queue.push({ body: 1 });
		const c = client();
		await c.get('/a', { query: { b: 1, a: 2 } });
		const again = await c.get('/a', { query: { a: 2, b: 1 } });
		expect(again.fromCache).toBe(true);
		expect(calls).toHaveLength(1);
	});

	it('a write expires everything read before it', async () => {
		queue.push({ body: { v: 1 } }, { status: 200, body: {} }, { body: { v: 2 } });
		const c = client();
		await c.get('/a');
		clockMs += 1000;
		await c.write('PUT', '/a', { x: 1 });
		clockMs += 1000;
		expect((await c.get<{ v: number }>('/a')).body.v).toBe(2);
		expect(calls).toHaveLength(3);
	});

	it('a failed write expires the cache too (the write may have been applied)', async () => {
		queue.push({ body: { v: 1 } }, { status: 500, body: { message: 'boom' } }, { body: { v: 2 } });
		const c = client();
		await c.get('/a');
		clockMs += 1000;
		await failure(() => c.write('PUT', '/a', {}));
		clockMs += 1000;
		expect((await c.get<{ v: number }>('/a')).body.v).toBe(2);
	});

	it('revalidates with If-None-Match once the TTL is over, and a 304 renews the entry', async () => {
		queue.push({ body: { v: 1 }, headers: { etag: 'W/"abc"' } }, { status: 304 });
		const c = client();
		await c.get('/a');
		clockMs += 61_000;
		const response = await c.get<{ v: number }>('/a');
		expect(calls[1]!.headers['if-none-match']).toBe('W/"abc"');
		expect(response.body.v).toBe(1);
		expect(response.fromCache).toBe(true);
		expect(response.etag).toBe('W/"abc"');
		// Renewed: served without asking again.
		await c.get('/a');
		expect(calls).toHaveLength(2);
	});

	it('sends no If-None-Match when the server never sent an ETag', async () => {
		queue.push({ body: 1 }, { body: 2 });
		const c = client();
		await c.get('/a');
		clockMs += 61_000;
		await c.get('/a');
		expect(calls[1]!.headers['if-none-match']).toBeUndefined();
	});

	it('a 304 for a request that was not conditional is an error', async () => {
		queue.push({ status: 304 });
		const error = await failure(() => client().get('/a'));
		expect(error.message).toContain('304');
	});

	it('serves the old answer, labelled stale, when GitLab cannot be reached, is slow or rate limited', async () => {
		const c = client();
		queue.push({ body: { v: 1 } });
		await c.get('/a');
		for (const [index, handler] of [
			new TypeError('fetch failed'),
			{ status: 429, text: 'Retry later', headers: { 'retry-after': '5' } } as Handler,
		].entries()) {
			clockMs += 61_000;
			queue.push(handler);
			const response = await c.get<{ v: number }>('/a');
			expect(response.body.v).toBe(1);
			expect(response.stale).toBe(true);
			expect(notices).toHaveLength(index + 1);
		}
		expect(notices[0]).toMatchObject({ kind: 'stale', cachedAt: '2026-11-08T12:00:00.000Z' });
		expect(notices[0]!.text).toContain('showing what was read on 2026-11-08T12:00:00.000Z (/a)');
		expect(notices.map(n => n.text).join('')).not.toContain(TOKEN);
	});

	it('never serves a stale answer after a refused token or a server error', async () => {
		const c = client();
		queue.push({ body: { v: 1 } });
		await c.get('/a');
		clockMs += 61_000;
		queue.push({ status: 401, body: { message: '401 Unauthorized' } });
		expect(await failure(() => c.get('/a'))).toBeInstanceOf(BackendAuthError);
		queue.push({ status: 404, body: { message: 'gone' } });
		expect(await failure(() => c.get('/a'))).toBeInstanceOf(GitLabHttpError);
		expect(notices).toEqual([]);
	});

	it('getAll reports the pages served stale', async () => {
		const c = client();
		queue.push({ body: [{ iid: 1 }] });
		await c.getAll('/a');
		clockMs += 61_000;
		queue.push(new TypeError('fetch failed'));
		const all = await c.getAll<{ iid: number }>('/a');
		expect(all).toMatchObject({ stale: true, cachedAt: '2026-11-08T12:00:00.000Z' });
	});
});

describe('GitLabClient: writes', () => {
	it('sends a JSON body with its content type, and accepts 204 without a body', async () => {
		queue.push({ status: 201, body: { iid: 7 } }, { status: 204 });
		const c = client();
		const created = await c.write<{ iid: number }>('POST', '/projects/1/issues', { title: 'T', labels: 'a,b' });
		expect(created.body.iid).toBe(7);
		expect(calls[0]!.method).toBe('POST');
		expect(calls[0]!.body).toBe('{"title":"T","labels":"a,b"}');
		expect(calls[0]!.headers['content-type']).toBe('application/json');
		const deleted = await c.write('DELETE', '/projects/1/issues/7');
		expect(deleted.status).toBe(204);
		expect(deleted.body).toBeUndefined();
		expect(calls[1]!.headers['content-type']).toBeUndefined();
	});

	it('spaces the start of two writes by writeSpacingMs and never overlaps them', async () => {
		let running = 0;
		let peak = 0;
		queue.push(
			...[1, 2, 3].map((): Handler => async () => {
				running += 1;
				peak = Math.max(peak, running);
				await new Promise(resolve => setTimeout(resolve, 5));
				running -= 1;
				return { body: {} };
			})
		);
		const c = client({ writeSpacingMs: 1000 });
		await Promise.all([c.write('POST', '/a'), c.write('POST', '/b'), c.write('POST', '/c')]);
		expect(peak).toBe(1);
		expect(calls.map(call => call.url.slice(BASE.length))).toEqual(['/a', '/b', '/c']);
		// The fake clock does not move: the second and third start 1000 ms after the first.
		expect(waits).toEqual([1000, 1000]);
	});

	it('the next write still goes after a failed one', async () => {
		queue.push({ status: 500, body: { message: 'x' } }, { body: {} });
		const c = client();
		await failure(() => c.write('POST', '/a'));
		await c.write('POST', '/b');
		expect(calls).toHaveLength(2);
	});

	it('waits out a short Retry-After and sends the same request again, at most twice', async () => {
		queue.push(
			{ status: 429, text: 'Retry later', headers: { 'retry-after': '3' } },
			{ status: 429, text: 'Retry later', headers: { 'retry-after': '4' } },
			{ body: { ok: true } }
		);
		const response = await client().write<{ ok: boolean }>('POST', '/projects/1/issues', { title: 'T' });
		expect(response.body.ok).toBe(true);
		expect(waits).toEqual([3000, 4000]);
		expect(calls).toHaveLength(3);
		expect(calls[2]!.body).toBe(calls[0]!.body);
	});

	it('gives up after two waits, and at once for a Retry-After above the limit or absent', async () => {
		const throttled = (seconds?: string): Handler => ({
			status: 429,
			text: 'Retry later',
			...(seconds === undefined ? {} : { headers: { 'retry-after': seconds } }),
		});
		queue.push(throttled('1'), throttled('1'), throttled('1'));
		const third = (await failure(() => client().write('POST', '/a'))) as RateLimitedError;
		expect(third).toBeInstanceOf(RateLimitedError);
		expect(calls).toHaveLength(3);

		calls = [];
		waits = [];
		queue.push(throttled('16'));
		await failure(() => client().write('POST', '/a'));
		expect(calls).toHaveLength(1);
		expect(waits).toEqual([]);

		calls = [];
		queue.push(throttled());
		await failure(() => client().write('POST', '/a'));
		expect(calls).toHaveLength(1);
	});

	it('a 429 that also reports an empty quota is still retried after the wait', async () => {
		const reset = String(clockMs / 1000 + 3);
		queue.push(
			{
				status: 429,
				text: 'Retry later',
				headers: {
					'retry-after': '3',
					'ratelimit-limit': '60',
					'ratelimit-remaining': '0',
					'ratelimit-reset': reset,
				},
			},
			{ body: { ok: true } }
		);
		// The injected sleep does not move the clock: without the fix the retry would be refused as an empty quota.
		const response = await client().write<{ ok: boolean }>('POST', '/a');
		expect(response.body.ok).toBe(true);
		expect(calls).toHaveLength(2);
	});

	it('never retries a 5xx or a lost connection (the write may have been applied)', async () => {
		queue.push({ status: 503, body: { message: 'busy' } });
		expect(await failure(() => client().write('POST', '/a', {}))).toBeInstanceOf(GitLabServerFailure);
		expect(calls).toHaveLength(1);

		queue.push(new TypeError('fetch failed'));
		expect(await failure(() => client().write('POST', '/a', {}))).toBeInstanceOf(BackendUnreachableError);
		expect(calls).toHaveLength(2);
	});
});

describe('GitLabClient: concurrency', () => {
	it('keeps at most maxConcurrent requests in flight', async () => {
		let running = 0;
		let peak = 0;
		queue.push(
			...Array.from({ length: 6 }, (): Handler => async () => {
				running += 1;
				peak = Math.max(peak, running);
				await new Promise(resolve => setTimeout(resolve, 5));
				running -= 1;
				return { body: {} };
			})
		);
		const c = client({ maxConcurrent: 2, cacheTtlMs: 0 });
		await Promise.all(Array.from({ length: 6 }, (_, index) => c.get(`/r${index}`)));
		expect(peak).toBe(2);
		expect(calls).toHaveLength(6);
	});
});

describe('redactToken', () => {
	it('hides every occurrence and leaves a text without the token alone', () => {
		expect(redactToken(`a ${TOKEN} b ${TOKEN}`, TOKEN)).toBe('a *** b ***');
		expect(redactToken('nothing', TOKEN)).toBe('nothing');
		expect(redactToken('nothing', '')).toBe('nothing');
	});
});
