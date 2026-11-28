import { PROTOCOL_HEADER, WireProtocolError } from '@wadeck-app/task-core';

import { createTestContext } from '../testHelpers.js';
import type { TestContext } from '../testHelpers.js';
import { RecordingSink } from './testHelpers.js';
import { createRequestHandler } from './requestHandler.js';
import type { RequestHandler, ServiceRequest } from './requestHandler.js';

// The transport-neutral core of the server: no HTTP, no token. (The HTTP adapter's behaviour is pinned by taskServer.test.ts, which
// goes through this handler; the stdio adapter by stdioServer.test.ts.)

let test: TestContext;
let sink: RecordingSink;
let handler: RequestHandler;

beforeEach(() => {
	test = createTestContext();
	sink = new RecordingSink();
	handler = createRequestHandler({
		ctx: { ...test.ctx, project: { id: 'ab12cd34', name: 'served', path: test.rootDir } },
		eventSink: sink,
		version: '2026.11.28-001',
		redact: [test.rootDir],
	});
});

afterEach(() => test.cleanup());

function request(overrides: Partial<ServiceRequest> & Pick<ServiceRequest, 'method' | 'path'>): ServiceRequest {
	return {
		headers: { 'x-task-protocol': '1' },
		readBody: () => Promise.resolve(undefined),
		...overrides,
	};
}

describe('createRequestHandler', () => {
	it('answers a read with the status, the negotiated protocol and the body, and no HTTP header of its own', async () => {
		const answer = await handler.handle(request({ method: 'GET', path: '/v1/info' }));

		expect(answer.status).toBe(200);
		expect(answer.headers).toEqual({ [PROTOCOL_HEADER]: '1' });
		expect(answer.body).toMatchObject({ server: { name: 'task-serve', version: '2026.11.28-001' } });
	});

	it('writes through the queue and answers the events of the write (delivered before the answer)', async () => {
		const answer = await handler.handle(
			request({
				method: 'POST',
				path: '/v1/tasks',
				readBody: () => Promise.resolve({ title: 'T', status: 'backlog' }),
			})
		);

		expect(answer.status).toBe(201);
		expect(answer.body).toMatchObject({ result: { title: 'T' }, events: { enabled: true, delivered: 1 } });
		expect(sink.names()).toEqual(['onTaskCreated']);
		await handler.flushEvents();
		expect(sink.flushes).toBe(1);
	});

	it('runs the admission check of the adapter first: a refusal is its error, nothing else is looked at', async () => {
		let bodyRead = false;
		const answer = await handler.handle(
			request({
				method: 'GET',
				path: '/v1/info',
				headers: {},
				admit: () => Promise.reject(new WireProtocolError('unauthorized', 'no token', 'Send one.')),
				readBody: () => {
					bodyRead = true;
					return Promise.resolve(undefined);
				},
			})
		);

		expect(answer.status).toBe(401);
		expect(answer.body).toMatchObject({ error: { type: 'unauthorized' } });
		expect(bodyRead).toBe(false);
	});

	it('has no authentication of its own: without an admission check everything is admitted', async () => {
		const answer = await handler.handle(request({ method: 'GET', path: '/v1/info' }));

		expect(answer.status).toBe(200);
	});

	it('names the protocol problem before the route, the route before the body, and never reads a body for an unknown route', async () => {
		let bodyRead = false;
		const readBody = (): Promise<unknown> => {
			bodyRead = true;
			return Promise.resolve(undefined);
		};

		const noVersion = await handler.handle(request({ method: 'GET', path: '/v1/nope', headers: {}, readBody }));
		const unknown = await handler.handle(request({ method: 'GET', path: '/v1/nope', readBody }));
		const wrongMethod = await handler.handle(request({ method: 'PUT', path: '/v1/info', readBody }));

		expect([noVersion.status, unknown.status, wrongMethod.status]).toEqual([426, 404, 405]);
		expect(wrongMethod.headers['Allow']).toBe('GET');
		expect(bodyRead).toBe(false);
	});

	it('a body that cannot be read is the answer of its error (413 too large)', async () => {
		const answer = await handler.handle(
			request({
				method: 'POST',
				path: '/v1/tasks',
				readBody: () => Promise.reject(new WireProtocolError('too-large', 'too big', 'Send less.')),
			})
		);

		expect(answer.status).toBe(413);
	});

	it('sends nothing when the peer left (isGone, or a reset while reading)', async () => {
		const gone = await handler.handle(
			request({ method: 'POST', path: '/v1/tasks', readBody: () => Promise.reject(new Error('boom')), isGone: () => true })
		);
		const reset = await handler.handle(
			request({
				method: 'POST',
				path: '/v1/tasks',
				readBody: () => Promise.reject(Object.assign(new Error('reset'), { code: 'ECONNRESET' })),
			})
		);

		expect(gone.gone).toBe(true);
		expect(reset.gone).toBe(true);
	});

	it('keeps the server folder out of every answer', async () => {
		const answer = await handler.handle(request({ method: 'GET', path: '/v1/tasks/does-not-exist' }));

		expect(JSON.stringify(answer.body)).not.toContain(test.rootDir);
	});
});
