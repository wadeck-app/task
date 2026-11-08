import { TaskConflictError } from '../errors';
import { StaleRevisionError, UnsupportedByBackendError } from './backendErrors';

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
