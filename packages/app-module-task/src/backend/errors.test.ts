import {
	AmbiguousDeletePrefixError,
	DanglingParentError,
	InvalidDeleteFilterError,
	InvalidLinkTypeError,
	InvalidStatusError,
	InvalidTaskTypeError,
	TaskServiceError,
} from '@wadeck-app/task-service';
import {
	AmbiguousTaskPrefixError,
	BackendAuthError,
	BackendTimeoutError,
	BackendUnreachableError,
	RateLimitedError,
	TaskConflictError,
	TaskNotFoundError,
	UnsupportedByBackendError,
} from '@wadeck-app/task-core';

import { RequestError, toHttpError } from './errors.js';

describe('toHttpError', () => {
	it('RequestError keeps its status, message, hint and extra fields', () => {
		expect(toHttpError(new RequestError(418, 'teapot', 'brew tea', { a: 1 }))).toEqual({
			status: 418,
			body: { error: 'teapot', hint: 'brew tea', a: 1 },
		});
	});

	it('TaskNotFoundError => 404', () => {
		expect(toHttpError(new TaskNotFoundError('abc'))).toEqual({
			status: 404,
			body: { error: 'Task not found: abc' },
		});
	});

	it('AmbiguousTaskPrefixError => 409 listing the matches', () => {
		const result = toHttpError(new AmbiguousTaskPrefixError('a', ['a1', 'a2']));
		expect(result.status).toBe(409);
		expect(result.body).toMatchObject({ matches: ['a1', 'a2'] });
		expect(result.body['hint']).toContain('longer');
	});

	it('AmbiguousDeletePrefixError => 409 listing the matches', () => {
		const result = toHttpError(new AmbiguousDeletePrefixError('a', ['a1', 'a2']));
		expect(result.status).toBe(409);
		expect(result.body).toMatchObject({ matches: ['a1', 'a2'] });
	});

	it('a refused operation => 422 with the hint and the capability', () => {
		const result = toHttpError(
			new UnsupportedByBackendError('github', 'setTitle', 'writes', 'Writes arrive later')
		);
		expect(result.status).toBe(422);
		expect(result.body).toMatchObject({
			hint: 'Writes arrive later',
			capability: 'writes',
			operation: 'setTitle',
			backend: 'github',
		});
	});

	it('a rate limit => 429 with the retry instant', () => {
		const result = toHttpError(new RateLimitedError('github', 'primary', new Date('2026-11-08T14:20:00.000Z')));
		expect(result.status).toBe(429);
		expect(result.body).toMatchObject({ retryAt: '2026-11-08T14:20:00.000Z' });
	});

	it('an unreachable server, a timeout and a refused token => 503 with their hint', () => {
		for (const error of [
			new BackendUnreachableError('github', 'api.github.com', 'ENOTFOUND'),
			new BackendTimeoutError('github', 'api.github.com', 5000),
			new BackendAuthError('github', 'unauthenticated', 'token refused', 'Create a new token'),
		]) {
			const result = toHttpError(error);
			expect(result.status).toBe(503);
			expect(result.body['hint']).toBe(error.hint);
		}
	});

	it('TaskConflictError => 409 with its message', () => {
		expect(toHttpError(new TaskConflictError('would create a cycle'))).toEqual({
			status: 409,
			body: { error: 'would create a cycle' },
		});
	});

	it('DanglingParentError => 409 with the fix hint', () => {
		const result = toHttpError(new DanglingParentError('t1', 'p1'));
		expect(result.status).toBe(409);
		expect(result.body['hint']).toContain('task remove-parent t1');
	});

	it('InvalidStatusError => 400 with valid statuses and suggestions', () => {
		const result = toHttpError(new InvalidStatusError('dne', ['backlog', 'done'], ['done']));
		expect(result.status).toBe(400);
		expect(result.body).toMatchObject({
			error: 'unknown status "dne"',
			validStatuses: ['backlog', 'done'],
			suggestions: ['done'],
		});
		expect(result.body['hint']).toContain('Valid statuses: backlog, done');
	});

	it('InvalidLinkTypeError => 400 with valid types and suggestions', () => {
		const result = toHttpError(new InvalidLinkTypeError('blokedBy', ['blockedBy'], ['blockedBy']));
		expect(result.status).toBe(400);
		expect(result.body).toMatchObject({ validTypes: ['blockedBy'], suggestions: ['blockedBy'] });
	});

	it('InvalidTaskTypeError and InvalidDeleteFilterError => 400', () => {
		expect(toHttpError(new InvalidTaskTypeError('x', 'bad type')).status).toBe(400);
		expect(toHttpError(new InvalidDeleteFilterError('bad', ['id'])).status).toBe(400);
	});

	it('any other TaskServiceError => 500 with its hint', () => {
		expect(toHttpError(new TaskServiceError('boom', 'try later'))).toEqual({
			status: 500,
			body: { error: 'boom', hint: 'try later' },
		});
	});

	it('unknown Error => 500 with its message', () => {
		expect(toHttpError(new Error('disk on fire'))).toEqual({ status: 500, body: { error: 'disk on fire' } });
	});

	it('a thrown non-Error => 500 with its string form (never an empty message)', () => {
		expect(toHttpError('oops')).toEqual({ status: 500, body: { error: 'oops' } });
	});
});
