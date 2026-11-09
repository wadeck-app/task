import {
	BackendAuthError,
	BackendRejectedError,
	BackendUnreachableError,
	StaleRevisionError,
	UnsupportedByBackendError,
} from '../backend/backendErrors';
import { AmbiguousTaskPrefixError, TaskConflictError, TaskNotFoundError } from '../errors';
import { CommentNotFoundError, InvalidCommentTextError } from '../taskComments';
import { RemoteIncompatibleError, RemoteUnauthorizedError, RemoteUnreachableError } from '../backend/backendErrors';
import { WireProtocolError, decodeWireError, encodeWireError } from './wireErrors';

const CONTEXT = { url: 'http://nas.lan:7788', operation: 'updateStatus' };

/** What really travels: the body is serialized and parsed again. */
function overTheWire(error: unknown, redact: string[] = []): Error {
	const { status, body } = encodeWireError(error, { redact });
	return decodeWireError(status, JSON.parse(JSON.stringify(body)) as unknown, CONTEXT);
}

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
