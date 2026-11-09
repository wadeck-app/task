import { TaskConflictError } from '../errors';
import {
	BackendAuthError,
	BackendDataError,
	BackendLimitError,
	BackendRejectedError,
	BackendTimeoutError,
	BackendUnreachableError,
	PartialWriteError,
	RateLimitedError,
	StaleRevisionError,
	UnsupportedByBackendError,
} from './backendErrors';

describe('UnsupportedByBackendError', () => {
	it('names the backend, the operation, the capability and carries a hint', () => {
		const error = new UnsupportedByBackendError(
			'github',
			'setMeta',
			'meta',
			'Enable fills.meta: labels in the project config'
		);

		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe('UnsupportedByBackendError');
		expect(error.backendKind).toBe('github');
		expect(error.operation).toBe('setMeta');
		expect(error.capability).toBe('meta');
		expect(error.hint).toBe('Enable fills.meta: labels in the project config');
		expect(error.message).toBe('The github backend does not support setMeta (capability "meta")');
	});

	it('refuses an empty hint: a refusal without a next step is a bug', () => {
		expect(() => new UnsupportedByBackendError('local', 'x', 'meta', '  ')).toThrow(/hint/);
	});
});

describe('StaleRevisionError', () => {
	it('is a TaskConflictError of kind stale, with both revisions and a next step', () => {
		const error = new StaleRevisionError('abc12345', 'r1', 'r2');

		expect(error).toBeInstanceOf(TaskConflictError);
		expect(error.name).toBe('StaleRevisionError');
		expect(error.kind).toBe('stale');
		expect(error.taskId).toBe('abc12345');
		expect(error.expectedRevision).toBe('r1');
		expect(error.actualRevision).toBe('r2');
		expect(error.message).toContain('abc12345');
		expect(error.hint).toContain('Read the task again');
	});
});

describe('the forge errors (unreachable, timeout, auth, rate limit, limit)', () => {
	it('BackendUnreachableError names the backend, the host and the cause, with a next step', () => {
		const error = new BackendUnreachableError('github', 'api.github.com', 'getaddrinfo ENOTFOUND api.github.com');

		expect(error.name).toBe('BackendUnreachableError');
		expect(error.backendKind).toBe('github');
		expect(error.host).toBe('api.github.com');
		expect(error.message).toBe('Cannot reach api.github.com (getaddrinfo ENOTFOUND api.github.com)');
		expect(error.hint).toMatch(/network|proxy|baseUrl/);
	});

	it('BackendTimeoutError says how long it waited and how to wait longer', () => {
		const error = new BackendTimeoutError('github', 'api.github.com', 15_000);

		expect(error.name).toBe('BackendTimeoutError');
		expect(error.timeoutMs).toBe(15_000);
		expect(error.message).toBe('api.github.com did not answer within 15 s');
		expect(error.hint).toContain('timeoutSeconds');
	});

	it('BackendAuthError carries the fix it is given and never an empty one', () => {
		const error = new BackendAuthError(
			'github',
			'unauthenticated',
			'GitHub refused the token (401)',
			'Create a token'
		);

		expect(error.name).toBe('BackendAuthError');
		expect(error.reason).toBe('unauthenticated');
		expect(error.hint).toBe('Create a token');
		expect(() => new BackendAuthError('github', 'forbidden', 'x', ' ')).toThrow(/hint/);
	});

	it('RateLimitedError says when to retry', () => {
		const retryAt = new Date('2026-11-08T14:20:00.000Z');
		const error = new RateLimitedError('github', 'primary', retryAt);

		expect(error.name).toBe('RateLimitedError');
		expect(error.scope).toBe('primary');
		expect(error.retryAt).toEqual(retryAt);
		expect(error.message).toContain('rate limit');
		expect(error.hint).toContain('2026-11-08T14:20:00.000Z');
	});

	it('RateLimitedError without a reset instant still gives a wait', () => {
		const error = new RateLimitedError('github', 'secondary', undefined);

		expect(error.retryAt).toBeUndefined();
		expect(error.hint).toMatch(/minute/);
	});

	it('BackendLimitError names the limit that was hit', () => {
		const error = new BackendLimitError('github', 'sub-issue depth', 8, 'Flatten the hierarchy');

		expect(error.name).toBe('BackendLimitError');
		expect(error.limit).toBe(8);
		expect(error.message).toContain('sub-issue depth');
		expect(error.hint).toBe('Flatten the hierarchy');
	});
});

describe('BackendDataError', () => {
	it('names what in the remote system does not fit the task model, with the fix', () => {
		const error = new BackendDataError(
			'github',
			'issue #12',
			'issue #12 carries two status labels (status:a, status:b)',
			'Remove one of them on GitHub'
		);

		expect(error.name).toBe('BackendDataError');
		expect(error.subject).toBe('issue #12');
		expect(error.message).toBe('issue #12 carries two status labels (status:a, status:b)');
		expect(error.hint).toBe('Remove one of them on GitHub');
		expect(() => new BackendDataError('github', 'x', 'm', '')).toThrow(/hint/);
	});
});

describe('PartialWriteError', () => {
	it('lists what was applied, what was not, and how to repair, and keeps the cause', () => {
		const cause = new Error('boom');
		const error = new PartialWriteError({
			backendKind: 'github',
			operation: 'updateStatus',
			taskId: '12',
			applied: ['removed the label status:in-progress'],
			notApplied: ['close the issue as completed'],
			hint: 'Run: task set-status 12 done',
			cause,
		});

		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe('PartialWriteError');
		expect(error.backendKind).toBe('github');
		expect(error.taskId).toBe('12');
		expect(error.applied).toEqual(['removed the label status:in-progress']);
		expect(error.notApplied).toEqual(['close the issue as completed']);
		expect(error.hint).toBe('Run: task set-status 12 done');
		expect(error.cause).toBe(cause);
		expect(error.message).toContain('updateStatus');
		expect(error.message).toContain('12');
		expect(error.message).toContain('removed the label status:in-progress');
		expect(error.message).toContain('close the issue as completed');
		expect(error.message).toContain('boom');
	});

	it('refuses an empty hint: a half-done write without a repair step is a bug', () => {
		expect(
			() =>
				new PartialWriteError({
					backendKind: 'github',
					operation: 'x',
					taskId: '1',
					applied: [],
					notApplied: [],
					hint: ' ',
				})
		).toThrow(/hint/);
	});
});

describe('BackendRejectedError', () => {
	it('is the server refusing the content of a write, with the reason and a fix', () => {
		const error = new BackendRejectedError(
			'github',
			'addLabel',
			'GitHub refused it: name is too long',
			'Use at most 50'
		);

		expect(error.name).toBe('BackendRejectedError');
		expect(error.operation).toBe('addLabel');
		expect(error.message).toBe('GitHub refused it: name is too long');
		expect(error.hint).toBe('Use at most 50');
	});
});
