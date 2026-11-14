import {
	BackendAuthError,
	BackendRejectedError,
	BackendUnreachableError,
	StaleRevisionError,
	UnsupportedByBackendError,
} from '../backend/backendErrors';
import { AmbiguousTaskPrefixError, TaskConflictError, TaskNotFoundError } from '../errors';
import { CommentNotFoundError, InvalidCommentTextError } from '../taskComments';
import {
	InvalidTaskFieldError,
	TaskClaimedError,
	TaskNotClaimedError,
	TaskReleaseRefusedError,
	UnknownPriorityError,
} from '../taskFields';
import { TaskClosedError } from '../taskClosedError';
import { WriteLockTimeoutError } from '../writeLockError';
import { RemoteIncompatibleError, RemoteUnauthorizedError, RemoteUnreachableError } from '../backend/backendErrors';
import { WireProtocolError, decodeWireError, encodeWireError } from './wireErrors';

const CONTEXT = { url: 'http://nas.lan:7788', operation: 'updateStatus' };

/** What really travels: the body is serialized and parsed again. */
function overTheWire(error: unknown, redact: string[] = []): Error {
	const { status, body } = encodeWireError(error, { redact });
	return decodeWireError(status, JSON.parse(JSON.stringify(body)) as unknown, CONTEXT);
}

describe('the errors of priority, assignee and claim cross the wire as the same classes', () => {
	it('a claim refused by a live lease is a 409 TaskClaimedError with the holder, the lease, the time left and the same text and hint', () => {
		const original = new TaskClaimedError('t1', 'w1', '2026-11-14T10:30:00.000Z', 900_000, false);
		const { status, body } = encodeWireError(original);
		expect(status).toBe(409);
		expect(body.error.type).toBe('claimed');

		const back = overTheWire(original);
		expect(back).toBeInstanceOf(TaskClaimedError);
		expect(back).toBeInstanceOf(TaskConflictError);
		const claimed = back as TaskClaimedError;
		expect([claimed.taskId, claimed.holder, claimed.leaseUntil, claimed.remainingMs, claimed.ownLease]).toEqual([
			't1',
			'w1',
			'2026-11-14T10:30:00.000Z',
			900_000,
			false,
		]);
		expect(claimed.message).toBe(original.message);
		expect(claimed.hint).toBe(original.hint);
		expect(
			(overTheWire(new TaskClaimedError('t1', 'w1', '2026-11-14T10:30:00.000Z', 1, true)) as TaskClaimedError)
				.ownLease
		).toBe(true);
	});

	it('a claim of a closed task is a 409 TaskClosedError with the id, the status and the hint', () => {
		const original = new TaskClosedError('t1', 'done');
		const { status, body } = encodeWireError(original);
		expect(status).toBe(409);
		expect(body.error.type).toBe('closed');
		const back = overTheWire(original) as TaskClosedError;
		expect(back).toBeInstanceOf(TaskClosedError);
		expect(back).toBeInstanceOf(TaskConflictError);
		expect([back.taskId, back.status]).toEqual(['t1', 'done']);
		expect(back.message).toBe(original.message);
		expect(back.hint).toBe(original.hint);
	});

	it('a release of a task nobody holds is a 409 TaskNotClaimedError', () => {
		const { status, body } = encodeWireError(new TaskNotClaimedError('t1'));
		expect(status).toBe(409);
		expect(body.error.type).toBe('not-claimed');
		const back = overTheWire(new TaskNotClaimedError('t1'));
		expect(back).toBeInstanceOf(TaskNotClaimedError);
		expect((back as TaskNotClaimedError).taskId).toBe('t1');
		expect((back as TaskNotClaimedError).hint).toBe(new TaskNotClaimedError('t1').hint);
	});

	it('a release on behalf of another holder is a 409 TaskReleaseRefusedError with both names', () => {
		const original = new TaskReleaseRefusedError('t1', 'w1', 'w2');
		const { status, body } = encodeWireError(original);
		expect(status).toBe(409);
		expect(body.error.type).toBe('release-refused');
		const back = overTheWire(original) as TaskReleaseRefusedError;
		expect(back).toBeInstanceOf(TaskReleaseRefusedError);
		expect([back.taskId, back.holder, back.requestedBy]).toEqual(['t1', 'w1', 'w2']);
		expect(back.message).toBe(original.message);
		expect(back.hint).toBe(original.hint);
	});

	it('an invalid field is a 400 InvalidTaskFieldError that keeps the field, the message and the hint', () => {
		const original = new InvalidTaskFieldError('assignee', 'a assignee cannot be blank', 'Give the assignee.');
		const { status, body } = encodeWireError(original);
		expect(status).toBe(400);
		expect(body.error.type).toBe('invalid-field');
		const back = overTheWire(original) as InvalidTaskFieldError;
		expect(back).toBeInstanceOf(InvalidTaskFieldError);
		expect(back).not.toBeInstanceOf(UnknownPriorityError);
		expect([back.field, back.message, back.hint]).toEqual(['assignee', original.message, original.hint]);
	});

	it('an invalid-field answer of a newer server keeps its field name and text verbatim; without a field it is a rejection that keeps the text', () => {
		const wire = (error: Record<string, unknown>): Error =>
			decodeWireError(400, { error: { type: 'invalid-field', ...error } }, CONTEXT);

		const due = wire({
			message: 'a due date cannot be in the past',
			hint: 'Pick a later date.',
			field: 'due',
		}) as InvalidTaskFieldError;
		expect(due).toBeInstanceOf(InvalidTaskFieldError);
		expect([due.field, due.message, due.hint]).toEqual([
			'due',
			'a due date cannot be in the past',
			'Pick a later date.',
		]);

		for (const extras of [{}, { field: 7 }, { field: '' }]) {
			const rejected = wire({ message: 'the server refused a field', hint: 'Fix it.', ...extras });
			expect(rejected).toBeInstanceOf(BackendRejectedError);
			expect(rejected).not.toBeInstanceOf(InvalidTaskFieldError);
			expect(rejected.message).toBe('the server refused a field');
			expect((rejected as BackendRejectedError).hint).toBe('Fix it.');
		}
	});

	it('an unknown priority is a 400 UnknownPriorityError that lists the valid ones', () => {
		const original = new UnknownPriorityError('asap', ['urgent', 'high']);
		const { status, body } = encodeWireError(original);
		expect(status).toBe(400);
		expect(body.error.type).toBe('unknown-priority');
		const back = overTheWire(original) as UnknownPriorityError;
		expect(back).toBeInstanceOf(UnknownPriorityError);
		expect(back).toBeInstanceOf(InvalidTaskFieldError);
		expect([back.priority, back.validPriorities]).toEqual(['asap', ['urgent', 'high']]);
		expect(back.message).toBe(original.message);
		expect(back.hint).toBe(original.hint);
	});

	it('a write lock held by another process on the server is a 503 WriteLockTimeoutError; the lock path never travels', () => {
		const original = new WriteLockTimeoutError(
			'Another task process holds the write lock of this project: pid 42 on box. Nothing was written.',
			'Retry in a moment.',
			'/srv/data/.write-lock',
			{ pid: 42, host: 'box', at: '2026-11-14T10:00:00.000Z' }
		);
		const { status, body } = encodeWireError(original);
		expect(status).toBe(503);
		expect(body.error.type).toBe('lock-timeout');
		expect(JSON.stringify(body)).not.toContain('/srv/data');
		const back = overTheWire(original) as WriteLockTimeoutError;
		expect(back).toBeInstanceOf(WriteLockTimeoutError);
		expect(back.message).toBe(original.message);
		expect(back.hint).toBe(original.hint);
		expect(back.holder).toEqual({ pid: 42, host: 'box', at: '2026-11-14T10:00:00.000Z' });
		// The lock path is the server's own: never a path of this machine.
		expect(back.lockPath).toBe('');
	});

	it('a RemoteIncompatibleError naming a feature says what is missing and which machine to update', () => {
		const error = new RemoteIncompatibleError('http://nas.lan:7788', 2, { min: 1, max: 1 }, 'claiming a task');
		expect(error.message).toContain('does not support claiming a task');
		expect(error.message).toContain('protocol 2');
		expect(error.message).toContain('1..1');
		expect(error.hint).toContain('machine that runs task serve');
	});
});

describe('the error mapping, class by class', () => {
	it('a task that does not exist is a 404 and comes back as the same class with its id', () => {
		const { status, body } = encodeWireError(new TaskNotFoundError('abc'));
		expect(status).toBe(404);
		expect(body.error.type).toBe('not-found');

		const back = overTheWire(new TaskNotFoundError('abc'));
		expect(back).toBeInstanceOf(TaskNotFoundError);
		expect((back as TaskNotFoundError).taskId).toBe('abc');
		expect(back.message).toBe('Task not found: abc');
	});

	it('an ambiguous prefix is a 409 and keeps its matches', () => {
		const { status } = encodeWireError(new AmbiguousTaskPrefixError('a', ['a1', 'a2']));
		expect(status).toBe(409);

		const back = overTheWire(new AmbiguousTaskPrefixError('a', ['a1', 'a2']));
		expect(back).toBeInstanceOf(AmbiguousTaskPrefixError);
		expect((back as AmbiguousTaskPrefixError).matches).toEqual(['a1', 'a2']);
		expect((back as AmbiguousTaskPrefixError).prefix).toBe('a');
	});

	it('a stale revision is a 412 (If-Match failed) and comes back as StaleRevisionError with both revisions', () => {
		const { status, body } = encodeWireError(new StaleRevisionError('t1', 'r1', 'r2'));
		expect(status).toBe(412);
		expect(body.error.type).toBe('stale');

		const back = overTheWire(new StaleRevisionError('t1', 'r1', 'r2'));
		expect(back).toBeInstanceOf(StaleRevisionError);
		expect(back).toBeInstanceOf(TaskConflictError);
		const stale = back as StaleRevisionError;
		expect([stale.taskId, stale.expectedRevision, stale.actualRevision]).toEqual(['t1', 'r1', 'r2']);
	});

	it('any other conflict is a 409 TaskConflictError, not a stale revision', () => {
		const { status } = encodeWireError(new TaskConflictError('Task "a" is already in status "done"'));
		expect(status).toBe(409);

		const back = overTheWire(new TaskConflictError('Task "a" is already in status "done"'));
		expect(back).toBeInstanceOf(TaskConflictError);
		expect(back).not.toBeInstanceOf(StaleRevisionError);
		expect(back.message).toBe('Task "a" is already in status "done"');
	});

	it('a missing comment keeps the ids that exist and its hint', () => {
		const original = new CommentNotFoundError('t1', 'zz', ['c1', 'c2']);
		const back = overTheWire(original);

		expect(back).toBeInstanceOf(CommentNotFoundError);
		const comment = back as CommentNotFoundError;
		expect([comment.taskId, comment.commentId, comment.validIds]).toEqual(['t1', 'zz', ['c1', 'c2']]);
		expect(comment.hint).toBe(original.hint);
	});

	it('a refused comment text is a 400 with its hint', () => {
		const { status } = encodeWireError(new InvalidCommentTextError('blank', 'Write something'));
		expect(status).toBe(400);

		const back = overTheWire(new InvalidCommentTextError('blank', 'Write something'));
		expect(back).toBeInstanceOf(InvalidCommentTextError);
		expect((back as InvalidCommentTextError).hint).toBe('Write something');
	});

	it('an unsupported operation is a 422 and is said to be the REMOTE backend that cannot do it, with the hint', () => {
		const { status } = encodeWireError(new UnsupportedByBackendError('local', 'setMeta', 'meta', 'Declare a fill'));
		expect(status).toBe(422);

		const back = overTheWire(new UnsupportedByBackendError('local', 'setMeta', 'meta', 'Declare a fill'));
		expect(back).toBeInstanceOf(UnsupportedByBackendError);
		const unsupported = back as UnsupportedByBackendError;
		expect(unsupported.backendKind).toBe('remote');
		expect([unsupported.operation, unsupported.capability, unsupported.hint]).toEqual([
			'setMeta',
			'meta',
			'Declare a fill',
		]);
	});

	it('a refused content is a 400 BackendRejectedError that keeps message and hint', () => {
		const back = overTheWire(new BackendRejectedError('local', 'setLabel', 'label too long', 'Shorten it'));

		expect(back).toBeInstanceOf(BackendRejectedError);
		expect(back.message).toBe('label too long');
		expect((back as BackendRejectedError).hint).toBe('Shorten it');
	});

	it('an unexpected failure is a 500 that keeps the message and sends no stack', () => {
		const error = new Error('Corrupted task record for t1');
		const { status, body } = encodeWireError(error);

		expect(status).toBe(500);
		expect(JSON.stringify(body)).not.toContain('stack');
		expect(JSON.stringify(body)).not.toContain(' at ');
		const back = overTheWire(error);
		expect(back.constructor).toBe(Error);
		expect(back.message).toBe('Corrupted task record for t1');
	});

	it('removes every secret it is told about from the message, the hint and the extras', () => {
		const error = new BackendRejectedError(
			'local',
			'x',
			'bad value s3cr3t-token here',
			'retry without s3cr3t-token'
		);
		const { body } = encodeWireError(error, { redact: ['s3cr3t-token'] });

		expect(JSON.stringify(body)).not.toContain('s3cr3t-token');
		expect(JSON.stringify(body)).toContain('***');
	});
});

describe('protocol-level failures', () => {
	it('unauthorized is a 401 and comes back as a RemoteUnauthorizedError naming the url', () => {
		const wire = new WireProtocolError('unauthorized', 'The token is missing or wrong', 'Check the token');
		const { status, body } = encodeWireError(wire);
		expect(status).toBe(401);
		expect(body.error.type).toBe('unauthorized');

		const back = overTheWire(wire);
		expect(back).toBeInstanceOf(RemoteUnauthorizedError);
		expect(back).toBeInstanceOf(BackendAuthError);
		expect((back as RemoteUnauthorizedError).reason).toBe('unauthenticated');
		expect(back.message).toContain('http://nas.lan:7788');
	});

	it('incompatible is a 426 that carries the supported range and comes back as RemoteIncompatibleError', () => {
		const wire = new WireProtocolError('incompatible', 'No protocol 9 here', 'Update task', {
			supported: { min: 1, max: 2 },
		});
		const { status, body } = encodeWireError(wire);
		expect(status).toBe(426);
		expect(body.error['supported']).toEqual({ min: 1, max: 2 });

		const back = overTheWire(wire);
		expect(back).toBeInstanceOf(RemoteIncompatibleError);
		expect((back as RemoteIncompatibleError).serverProtocol).toEqual({ min: 1, max: 2 });
		expect((back as RemoteIncompatibleError).hint).toMatch(/update task on this machine/i);
	});

	it('an incompatible client older than the server is told to update THIS machine, a newer one the server machine', () => {
		const older = new RemoteIncompatibleError('http://h:1', 3, { min: 1, max: 2 });
		const newer = new RemoteIncompatibleError('http://h:1', 1, { min: 2, max: 3 });

		expect(older.hint).toMatch(/machine that runs task serve/i);
		expect(newer.hint).toMatch(/update task on this machine/i);
		expect(older.message).toContain('1..2');
	});

	it('every other protocol failure has its HTTP status', () => {
		const status = (type: ConstructorParameters<typeof WireProtocolError>[0]): number =>
			encodeWireError(new WireProtocolError(type, 'm', 'h')).status;

		expect(status('too-large')).toBe(413);
		expect(status('unsupported-media')).toBe(415);
		expect(status('not-allowed')).toBe(405);
		expect(status('unknown-route')).toBe(404);
		expect(status('invalid-request')).toBe(400);
		expect(status('unavailable')).toBe(503);
	});

	it('an invalid request comes back as a rejection with the hint, so the user sees what was wrong', () => {
		const back = overTheWire(new WireProtocolError('invalid-request', 'title: must be a string', 'Send a string'));

		expect(back).toBeInstanceOf(BackendRejectedError);
		expect(back.message).toBe('title: must be a string');
		expect((back as BackendRejectedError).hint).toBe('Send a string');
	});
});

describe('an answer that is not a task error', () => {
	it('a proxy page (HTML, no JSON error) is reported as unreachable, naming the status and the url', () => {
		const back = decodeWireError(502, '<html>Bad Gateway</html>', CONTEXT);

		expect(back).toBeInstanceOf(RemoteUnreachableError);
		expect(back).toBeInstanceOf(BackendUnreachableError);
		expect(back.message).toContain('502');
		expect(back.message).toContain('nas.lan');
	});

	it('a JSON body with the wrong shape is the same', () => {
		const back = decodeWireError(500, { oops: true }, CONTEXT);
		expect(back).toBeInstanceOf(RemoteUnreachableError);
	});

	it('an unknown error type from a newer server is still an Error carrying its message', () => {
		const back = decodeWireError(
			500,
			{ error: { type: 'from-the-future', message: 'new problem', hint: 'do x' } },
			CONTEXT
		);

		expect(back).toBeInstanceOf(Error);
		expect(back.message).toBe('new problem');
	});
});
