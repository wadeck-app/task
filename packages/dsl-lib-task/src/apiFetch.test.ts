import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem, getJson, isAbort } from './apiFetch.js';
import { jsonResponse, stubFetch } from './testHelpers.js';
import { configureTaskUi, resetTaskUiConfig } from './runtime-config.js';

beforeEach(() => configureTaskUi({ apiBase: '/api/modules/task' }));
afterEach(() => {
	resetTaskUiConfig();
	vi.unstubAllGlobals();
});

describe('getJson', () => {
	it('calls the configured api base with an encoded query and skips undefined values', async () => {
		const { calls } = stubFetch(() => jsonResponse([{ a: 1 }]));

		const result = await getJson('/tasks/search', { q: 'a b&c', limit: 8, skip: undefined, empty: '' });

		expect(result).toEqual([{ a: 1 }]);
		expect(calls[0]!.url.pathname).toBe('/api/modules/task/tasks/search');
		expect(calls[0]!.url.searchParams.get('q')).toBe('a b&c');
		expect(calls[0]!.url.searchParams.get('limit')).toBe('8');
		expect(calls[0]!.url.searchParams.has('skip')).toBe(false);
		expect(calls[0]!.url.searchParams.get('empty')).toBe('');
	});

	it('lets a prop override the configured api base', async () => {
		const { calls } = stubFetch(() => jsonResponse([]));

		await getJson('/labels', {}, { apiBase: '/other' });

		expect(calls[0]!.url.pathname).toBe('/other/labels');
	});

	it('turns an error answer into an ApiProblem with the message and the hint of the route', async () => {
		stubFetch(() => jsonResponse({ error: 'unknown project', hint: 'use the id' }, 404));

		const problem = await getJson('/labels', {}).catch((e: unknown) => e);

		expect(problem).toBeInstanceOf(ApiProblem);
		expect((problem as ApiProblem).message).toBe('unknown project');
		expect((problem as ApiProblem).hint).toBe('use the id');
		expect((problem as ApiProblem).status).toBe(404);
	});

	it('names the status when the error body is not JSON', async () => {
		stubFetch(() => new Response('boom', { status: 502 }));

		const problem = (await getJson('/labels', {}).catch((e: unknown) => e)) as ApiProblem;

		expect(problem.message).toContain('502');
		expect(problem.message).toContain('boom');
	});

	it('explains a network failure with something to do', async () => {
		stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));

		const problem = (await getJson('/labels', {}).catch((e: unknown) => e)) as ApiProblem;

		expect(problem).toBeInstanceOf(ApiProblem);
		expect(problem.message).toContain('Failed to fetch');
		expect(problem.hint).toMatch(/reload|running/i);
	});

	it('passes the abort through untouched and isAbort recognises it', async () => {
		const controller = new AbortController();
		stubFetch(() => new Promise<Response>(() => undefined));
		const pending = getJson('/labels', {}, { signal: controller.signal }).catch((e: unknown) => e);

		controller.abort();

		expect(isAbort(await pending)).toBe(true);
		expect(isAbort(new Error('x'))).toBe(false);
	});
});
