import { ConfigSchemaError, ProjectOptionError } from '@wadeck-app/project-sdk';
import {
	AmbiguousTaskPrefixError,
	BackendAuthError,
	BackendDataError,
	BackendLimitError,
	BackendRejectedError,
	BackendTimeoutError,
	BackendUnreachableError,
	PartialWriteError,
	RateLimitedError,
	RemoteIncompatibleError,
	RemoteProjectMismatchError,
	RemoteTimeoutError,
	RemoteUnauthorizedError,
	RemoteUnreachableError,
	TaskConflictError,
	TaskNotFoundError,
	UnsupportedByBackendError,
} from '@wadeck-app/task-core';

import { describeError, isRemoteFailure } from './describeError.js';
import { PluginCreateError } from './plugin-host/index.js';
import { PluginNotImplementedError } from './plugins/kinds.js';
import { HOOKS_REMOVED_HINT, RemovedConfigKeyError } from './removedConfigKey.js';
import { StrategyConfigError } from './strategyConfig.js';
import {
	AmbiguousDeletePrefixError,
	DanglingParentError,
	InvalidDeleteFilterError,
	InvalidLinkTypeError,
	InvalidStatusError,
	InvalidTaskTypeError,
	TaskServiceError,
} from './errors.js';

describe('describeError', () => {
	it('a missing task is "not-found", without hint', () => {
		expect(describeError(new TaskNotFoundError('abc'))).toEqual({
			kind: 'not-found',
			message: 'Task not found: abc',
			details: {},
		});
	});

	it.each([
		['task prefix', new AmbiguousTaskPrefixError('a', ['a1', 'a2'])],
		['delete prefix', new AmbiguousDeletePrefixError('a', ['a1', 'a2'])],
	])('an ambiguous %s is "ambiguous" and lists the matches', (_name, error) => {
		const description = describeError(error);
		expect(description.kind).toBe('ambiguous');
		expect(description.message).toBe(error.message);
		expect(description.details).toEqual({ matches: ['a1', 'a2'] });
	});

	it('a store conflict is "conflict" with its message only', () => {
		expect(describeError(new TaskConflictError('would create a cycle'))).toEqual({
			kind: 'conflict',
			message: 'would create a cycle',
			details: {},
		});
	});

	it('a dangling parent is "conflict" and keeps the fix command as hint', () => {
		const description = describeError(new DanglingParentError('t1', 'p1'));
		expect(description.kind).toBe('conflict');
		expect(description.hint).toBe('Fix with: task remove-parent t1');
	});

	it('an invalid status is "invalid" with the valid values and suggestions', () => {
		const description = describeError(new InvalidStatusError('dne', ['backlog', 'done'], ['done']));
		expect(description).toEqual({
			kind: 'invalid',
			message: 'unknown status "dne"',
			hint: 'Valid statuses: backlog, done\nDid you mean: done?',
			details: { validStatuses: ['backlog', 'done'], suggestions: ['done'] },
		});
	});

	it('an invalid link type is "invalid" with the valid types and suggestions', () => {
		const description = describeError(new InvalidLinkTypeError('blokedBy', ['blockedBy'], ['blockedBy']));
		expect(description.kind).toBe('invalid');
		expect(description.details).toEqual({ validTypes: ['blockedBy'], suggestions: ['blockedBy'] });
	});

	it('an invalid task type and an invalid delete filter are "invalid"', () => {
		expect(describeError(new InvalidTaskTypeError('x', 'bad type'))).toEqual({
			kind: 'invalid',
			message: 'bad type',
			details: {},
		});
		const filter = describeError(new InvalidDeleteFilterError('bad', ['id']));
		expect(filter.kind).toBe('invalid');
		expect(filter.hint).toBe('Valid fields: id');
	});

	it('other service errors (base class) are "internal" and keep their hint', () => {
		expect(describeError(new TaskServiceError('boom', 'try later')).hint).toBe('try later');
	});

	it('an unknown Error is "internal", without hint', () => {
		expect(describeError(new Error('disk on fire'))).toEqual({
			kind: 'internal',
			message: 'disk on fire',
			details: {},
		});
	});

	it('a thrown non-Error is described by its string form (never an empty message)', () => {
		expect(describeError('oops')).toEqual({ kind: 'internal', message: 'oops', details: {} });
	});
});

describe('describeError: the shared registry', () => {
	it('a config key the schema does not know is "invalid", names the file in the message, and says what to do', () => {
		const description = describeError(
			new ConfigSchemaError("layer '/cfg/config.yml': key 'colour' is not declared")
		);

		expect(description.kind).toBe('invalid');
		expect(description.message).toContain('/cfg/config.yml');
		expect(description.hint).toContain('config.yml');
	});
});

describe('describeError: a removed config key', () => {
	it('hooks is "invalid", names the file and the key, and the hint points to queue subscribers', () => {
		const description = describeError(
			new RemovedConfigKeyError('/cfg/config.yml', 'hooks', 'not supported', HOOKS_REMOVED_HINT)
		);

		expect(description.kind).toBe('invalid');
		expect(description.message).toBe('/cfg/config.yml: hooks: not supported');
		expect(description.hint).toContain('queue subscribers');
		expect(description.hint).toContain('.queue/subscribers.yml');
	});
});

describe('describeError: project option errors of the shared SDK', () => {
	it('a flag without value is "invalid", names the flag and says how to fix it', () => {
		const description = describeError(
			new ProjectOptionError('-p needs a value: the name', { kind: 'missing-value', option: '-p' })
		);
		expect(description.kind).toBe('invalid');
		expect(description.message).toBe('-p needs a value: the name');
		expect(description.hint).toContain('project list');
		expect(description.details).toEqual({ option: '-p', optionKind: 'missing-value' });
	});

	it('a repeated flag is "invalid" and says to pass it once', () => {
		const description = describeError(
			new ProjectOptionError('the project is given twice (-p and --project=b); pass it once', {
				kind: 'repeated',
				option: '--project=b',
			})
		);
		expect(description.kind).toBe('invalid');
		expect(description.hint).toContain('once');
	});
});

describe('describeError: the strategy and its plugins', () => {
	it('a strategy config error is "invalid" and carries its own fix, not the generic one', () => {
		const error = new StrategyConfigError(
			'/cfg/config.yml',
			'strategy.type',
			'unknown strategy plugin "foo"',
			'Registered strategy plugins: local'
		);

		const description = describeError(error);

		expect(description.kind).toBe('invalid');
		expect(description.message).toBe('/cfg/config.yml: strategy.type: unknown strategy plugin "foo"');
		expect(description.hint).toBe('Registered strategy plugins: local');
	});

	it('a strategy config error without hint falls back to the generic config fix', () => {
		const description = describeError(new StrategyConfigError('/cfg/config.yml', 'strategy', 'x'));

		expect(description.hint).toBe(
			'Fix the config.yml named in the message (remove or rename the key), then retry.'
		);
	});

	it('a plugin that is registered but not implemented is "internal" with its fix', () => {
		const description = describeError(
			new PluginNotImplementedError('plugins.plain-http.default', 'stage 4', 'Use local')
		);

		expect(description.kind).toBe('internal');
		expect(description.message).toBe(
			'plugin "plugins.plain-http.default" is registered but not implemented in this version (it arrives in stage 4)'
		);
		expect(description.hint).toBe('Use local');
	});

	it('a failed plugin creation shows the hint of its cause', () => {
		const cause = new PluginNotImplementedError('plugins.x.default', 'stage 9', 'Do the other thing');
		const description = describeError(new PluginCreateError('plugins.x.default', cause.message, cause));

		expect(description.kind).toBe('internal');
		expect(description.hint).toBe('Do the other thing');
	});
});

describe('describeError: the errors of a remote system', () => {
	it('a refused operation is "unsupported" with its own hint and the capability in the details', () => {
		const description = describeError(
			new UnsupportedByBackendError('github', 'setTitle', 'writes', 'Writes arrive in stage 2')
		);

		expect(description).toEqual({
			kind: 'unsupported',
			message: 'The github backend does not support setTitle (capability "writes")',
			hint: 'Writes arrive in stage 2',
			details: { backend: 'github', operation: 'setTitle', capability: 'writes' },
		});
	});

	it('a rate limit is "rate-limited" with the instant to retry at', () => {
		const retryAt = new Date('2026-11-08T14:20:00.000Z');
		const description = describeError(new RateLimitedError('github', 'primary', retryAt));

		expect(description.kind).toBe('rate-limited');
		expect(description.hint).toContain('2026-11-08T14:20:00.000Z');
		expect(description.details).toEqual({ scope: 'primary', retryAt: '2026-11-08T14:20:00.000Z' });
	});

	it('a rate limit without an instant has no retryAt key', () => {
		expect(describeError(new RateLimitedError('github', 'secondary', undefined)).details).toEqual({
			scope: 'secondary',
		});
	});

	it.each([
		['unreachable', new BackendUnreachableError('github', 'api.github.com', 'ENOTFOUND')],
		['timeout', new BackendTimeoutError('github', 'api.github.com', 15_000)],
		['missing token', new BackendAuthError('github', 'missing', 'No token', 'Set GITHUB_TOKEN')],
		['rejected token', new BackendAuthError('github', 'unauthenticated', 'Bad token', 'Create a new one')],
	])('%s is "unavailable" and keeps its hint', (_name, error) => {
		const description = describeError(error);

		expect(description.kind).toBe('unavailable');
		expect(description.message).toBe(error.message);
		expect(description.hint).toBe(error.hint);
	});

	it('a limit of the remote system is "conflict" with the limit in the details', () => {
		const description = describeError(new BackendLimitError('github', 'sub-issue depth', 8, 'Flatten it'));

		expect(description.kind).toBe('conflict');
		expect(description.hint).toBe('Flatten it');
		expect(description.details).toEqual({ limit: 'sub-issue depth', max: 8 });
	});
});

describe('describeError: data of the remote system that does not fit', () => {
	it('is "conflict" with the fix and the subject', () => {
		const description = describeError(
			new BackendDataError('github', 'issue #12', 'issue #12 has two status labels', 'Remove one on GitHub')
		);

		expect(description).toEqual({
			kind: 'conflict',
			message: 'issue #12 has two status labels',
			hint: 'Remove one on GitHub',
			details: { subject: 'issue #12' },
		});
	});

	it('a failed plugin creation keeps the kind and text of a cause the callers know (a missing token)', () => {
		const cause = new BackendAuthError('github', 'missing', 'No GitHub token', 'Set GITHUB_TOKEN');
		const description = describeError(new PluginCreateError('plugins.github.default', cause.message, cause));

		expect(description).toMatchObject({
			kind: 'unavailable',
			message: 'No GitHub token',
			hint: 'Set GITHUB_TOKEN',
		});
	});
});

describe('describeError: github writes', () => {
	it('a write the server refused is "invalid" with the fix', () => {
		const description = describeError(
			new BackendRejectedError('github', 'addLabel', 'GitHub refused the label', 'Use at most 50 characters')
		);

		expect(description).toEqual({
			kind: 'invalid',
			message: 'GitHub refused the label',
			hint: 'Use at most 50 characters',
			details: { backend: 'github', operation: 'addLabel' },
		});
	});

	it('a write done only in part is "internal" with what was and was not applied, and the repair as hint', () => {
		const description = describeError(
			new PartialWriteError({
				backendKind: 'github',
				operation: 'updateStatus',
				taskId: '12',
				applied: ['removed the label status:todo'],
				notApplied: ['close the issue'],
				hint: 'Run: task set-status 12 done',
			})
		);

		expect(description.kind).toBe('internal');
		expect(description.hint).toBe('Run: task set-status 12 done');
		expect(description.details).toEqual({
			backend: 'github',
			operation: 'updateStatus',
			taskId: '12',
			applied: ['removed the label status:todo'],
			notApplied: ['close the issue'],
		});
	});
});

describe('describeError: the remote strategy', () => {
	it('an unreachable, silent or refused task server is "unavailable" with the fix of its own error', () => {
		const unreachable = describeError(new RemoteUnreachableError('http://nas.lan:7788', 'connect ECONNREFUSED'));
		const timeout = describeError(new RemoteTimeoutError('nas.lan:7788', 10_000, 'write'));
		const refused = describeError(
			new RemoteUnauthorizedError('unauthenticated', 'token refused', 'Compare the tokens')
		);
		const incompatible = describeError(new RemoteIncompatibleError('http://nas.lan:7788', 2, { min: 1, max: 1 }));

		for (const description of [unreachable, timeout, refused, incompatible]) {
			expect(description.kind).toBe('unavailable');
			expect(description.hint).toBeDefined();
		}
		expect(unreachable.hint).toContain('task serve');
		expect(timeout.hint).toContain('may have been applied');
		expect(refused.hint).toBe('Compare the tokens');
		expect(incompatible.hint).toContain('Update task');
	});

	it('a server that serves another project than the config expects is "invalid" with the fix', () => {
		const description = describeError(
			new RemoteProjectMismatchError('http://nas.lan:7788', 'shop', { id: 'ab12cd34', name: 'warehouse' })
		);

		expect(description.kind).toBe('invalid');
		expect(description.hint).toContain('strategy.options.project');
	});

	it('a project behind such a server counts as unreadable in the views that list several projects', () => {
		expect(isRemoteFailure(new RemoteUnreachableError('http://nas.lan:7788', 'x'))).toBe(true);
		expect(isRemoteFailure(new RemoteTimeoutError('nas.lan:7788', 1000, 'read'))).toBe(true);
		expect(isRemoteFailure(new RemoteIncompatibleError('http://nas.lan:7788', 2, undefined))).toBe(true);
		expect(isRemoteFailure(new RemoteProjectMismatchError('http://h:1', 'a', { name: 'b' }))).toBe(true);
	});
});
