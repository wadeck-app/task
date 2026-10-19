import { AmbiguousTaskPrefixError, TaskConflictError, TaskNotFoundError } from '@wadeck-app/task-core';

import { describeError } from './describeError.js';
import {
	AmbiguousDeletePrefixError,
	DanglingParentError,
	InvalidDeleteFilterError,
	InvalidLinkTypeError,
	InvalidStatusError,
	InvalidTaskTypeError,
	ProjectsRegistryError,
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

	it('other service errors (registry, base class) are "internal" and keep their hint', () => {
		expect(describeError(new ProjectsRegistryError('corrupt', 'delete the file'))).toEqual({
			kind: 'internal',
			message: 'corrupt',
			hint: 'delete the file',
			details: {},
		});
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
