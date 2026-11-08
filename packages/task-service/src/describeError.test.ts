import { ConfigSchemaError, ProjectOptionError } from '@wadeck-app/project-sdk';
import { AmbiguousTaskPrefixError, TaskConflictError, TaskNotFoundError } from '@wadeck-app/task-core';

import { describeError } from './describeError.js';
import { PluginCreateError } from './plugin-host/index.js';
import { PluginNotImplementedError } from './plugins/kinds.js';
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
