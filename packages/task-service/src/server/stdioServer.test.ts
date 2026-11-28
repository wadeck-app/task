import { Readable } from 'node:stream';

import { buildRequest, requestVersion } from '@wadeck-app/task-core';
import type { ProtocolOperation } from '@wadeck-app/task-core';

import { startServerFixture } from './testHelpers.js';
import type { Json, ServerFixture } from './testHelpers.js';
import { STDIO_ENVELOPE_ALLOWANCE, serveStdioRequest } from './stdioServer.js';
import type { StdioAnswer } from './stdioServer.js';
import { TaskServerStartError } from './taskServer.js';

// `task serve --stdio`: one request on a stream, one answer, the same pipeline as HTTP. The parity tests run the SAME request over a
// real HTTP server and over stdio on the same project and require the same status and body.

const open: ServerFixture[] = [];

async function fixture(options: Parameters<typeof startServerFixture>[0] = {}): Promise<ServerFixture> {
	const started = await startServerFixture(options);
	open.push(started);
	return started;
}

afterEach(async () => {
	for (const f of open.splice(0)) await f.stop();
});

function stream(text: string | Buffer): Readable {
	return Readable.from([text]);
}

/** The envelope of an operation of the protocol, as a client of the stdio form would write it. */
function envelope(
	op: ProtocolOperation,
	params: Record<string, string> = {},
	body?: unknown,
	headers: Record<string, string> = {}
): string {
	const { method, path } = buildRequest(op, params);
	return JSON.stringify({
		method,
		path,
		headers: { 'X-Task-Protocol': String(requestVersion(op)), ...headers },
		...(body === undefined ? {} : { body }),
	});
}

async function stdio(f: ServerFixture, text: string | Buffer, extra: object = {}): Promise<StdioAnswer> {
	return serveStdioRequest(stream(text), { ctx: f.ctx, ...extra });
}

describe('serveStdioRequest: the same answers as the HTTP server', () => {
	it('info: same status and body, and the protocol header the request named', async () => {
		const f = await fixture({ version: '2026.11.28-001' });

		const http = await f.call('info');
		const answer = await stdio(f, envelope('info'), { version: '2026.11.28-001' });

		expect(answer.status).toBe(http.status);
		expect(answer.body).toEqual(http.body);
		expect(answer.headers).toEqual({ 'X-Task-Protocol': '1' });
	});

	it('a read: the task of the project, byte for byte what HTTP answers', async () => {
		const f = await fixture();
		const task = (await f.call('create', {}, { title: 'T', status: 'backlog' })).body.result;

		const http = await f.call('get', { id: task.id });
		const answer = await stdio(f, envelope('get', { id: task.id }));

		expect(answer.status).toBe(200);
		expect(JSON.stringify(answer.body)).toBe(JSON.stringify(http.body));
	});

	it('a write with a stale If-Match is 412 with the same error, writes nothing, and the current revision succeeds', async () => {
		const f = await fixture();
		const task = (await f.call('create', {}, { title: 'T', status: 'backlog' })).body.result;

		const stale = await stdio(f, envelope('addLabel', { id: task.id }, { label: 'x' }, { 'If-Match': '"0000000000000000"' }));
		const httpStale = await f.call(
			'addLabel',
			{ id: task.id },
			{ label: 'x' },
			{ headers: { 'If-Match': '"0000000000000000"' } }
		);
		const fresh = await stdio(
			f,
			envelope('addLabel', { id: task.id }, { label: 'x' }, { 'If-Match': `"${task.revision}"` })
		);

		expect(stale.status).toBe(412);
		expect(stale.body).toEqual(httpStale.body);
		expect(fresh.status).toBe(200);
		expect((fresh.body as Json).result.labels).toEqual(['x']);
	});

	it('an unknown route and a wrong method: 404 and 405 (Allow in the headers), like HTTP', async () => {
		const f = await fixture();

		const unknown = await stdio(f, JSON.stringify({ method: 'GET', path: '/v1/nope', headers: { 'X-Task-Protocol': '1' } }));
		const wrong = await stdio(f, JSON.stringify({ method: 'PUT', path: '/v1/info', headers: { 'X-Task-Protocol': '1' } }));
		const httpUnknown = await f.raw('/v1/nope', { headers: f.headers() });

		expect(unknown.status).toBe(httpUnknown.status);
		expect(unknown.body).toEqual(JSON.parse(httpUnknown.text));
		expect(wrong.status).toBe(405);
		expect(wrong.headers['Allow']).toBe('GET');
	});

	it('a bad body is refused by the same strict validation (exact keys, valid status): 400, and nothing is written', async () => {
		const f = await fixture();

		const answer = await stdio(f, envelope('create', {}, { title: 'B', status: 'weird' }));
		const http = await f.call('create', {}, { title: 'B', status: 'weird' });
		const unknownKey = await stdio(f, envelope('create', {}, { title: 'B', status: 'backlog', colour: 'red' }));

		expect(answer.status).toBe(http.status);
		expect(answer.body).toEqual(http.body);
		expect(unknownKey.status).toBe(400);
		expect((await f.call('list')).body.items).toHaveLength(0);
	});

	it('a missing protocol header is the same 426 as over HTTP (nothing is assumed)', async () => {
		const f = await fixture();

		const answer = await stdio(f, JSON.stringify({ method: 'GET', path: '/v1/info' }));

		expect(answer.status).toBe(426);
		expect(answer.body).toMatchObject({ error: { type: 'incompatible' } });
	});
});

describe('serveStdioRequest: events', () => {
	it('the events of a write are delivered before the answer and the sink is flushed before the call returns', async () => {
		const f = await fixture({ withSink: true });

		const answer = await stdio(f, envelope('create', {}, { title: 'T', status: 'backlog' }), { eventSink: f.sink });

		expect(answer.status).toBe(201);
		expect(answer.body).toMatchObject({ events: { enabled: true, delivered: 1 } });
		expect(f.sink.names()).toEqual(['onTaskCreated']);
		expect(f.sink.flushes).toBe(1);
	});

	it('X-Task-Events: suppress raises none (a migration), and without a sink the answer says events are not enabled', async () => {
		const f = await fixture({ withSink: true });

		const suppressed = await stdio(
			f,
			envelope('create', {}, { title: 'T', status: 'backlog' }, { 'X-Task-Events': 'suppress' }),
			{ eventSink: f.sink }
		);
		const noSink = await stdio(f, envelope('create', {}, { title: 'U', status: 'backlog' }));

		expect(f.sink.delivered).toHaveLength(0);
		expect(suppressed.body).toMatchObject({ events: { enabled: true, delivered: 0 } });
		expect(noSink.body).toMatchObject({ events: { enabled: false } });
	});
});

describe('serveStdioRequest: a request that is not a request is an answer, never a stack', () => {
	const cases: Array<[string, string, number, string]> = [
		['nothing on stdin', '', 400, 'no request'],
		['not JSON', 'GET /v1/info', 400, 'not valid JSON'],
		['not an object', '[1]', 400, 'must be a JSON object'],
		['an unknown key', '{"method":"GET","path":"/v1/info","verb":"x"}', 400, 'unknown key "verb"'],
		['no method', '{"path":"/v1/info"}', 400, '"method"'],
		['a path that is not absolute', '{"method":"GET","path":"v1/info"}', 400, '"path"'],
		['headers that are not texts', '{"method":"GET","path":"/v1/info","headers":{"X-Task-Protocol":1}}', 400, 'must be a text'],
	];
	it.each(cases)('%s', async (_name, input, status, text) => {
		const f = await fixture();

		const answer = await stdio(f, input);

		expect(answer.status).toBe(status);
		expect((answer.body as Json).error.message).toContain(text);
		expect(JSON.stringify(answer.body)).not.toContain('    at ');
	});

	it('a body over the limit is 413 (the body itself, or the whole stdin with the envelope allowance)', async () => {
		const f = await fixture();
		const limit = 1000;

		const body = await stdio(f, envelope('create', {}, { title: 'x'.repeat(limit + 10), status: 'backlog' }), {
			maxBodyBytes: limit,
		});
		const whole = await stdio(f, Buffer.alloc(limit + STDIO_ENVELOPE_ALLOWANCE + 1, 0x20), { maxBodyBytes: limit });

		expect([body.status, whole.status]).toEqual([413, 413]);
		expect((await f.call('list')).body.items).toHaveLength(0);
	});

	it('UTF-8 survives: accents and a typographic quote in a title are stored and answered intact', async () => {
		const f = await fixture();
		// Built from code points, not typed: the sources of this repository are English only. "E acute, l, e acute, phant, a grave, l, right quote, e acute, coute".
		const title = String.fromCodePoint(
			...[0xc9, 0x6c, 0xe9, 0x70, 0x68, 0x61, 0x6e, 0x74, 0x20, 0xe0, 0x20, 0x6c, 0x2019, 0xe9, 0x63, 0x6f, 0x75, 0x74, 0x65]
		);

		const answer = await stdio(f, Buffer.from(envelope('create', {}, { title, status: 'backlog' }), 'utf8'));

		expect(answer.status).toBe(201);
		expect((answer.body as Json).result.title).toBe(title);
	});
});

describe('serveStdioRequest: what is not served', () => {
	it('a project behind another server (remote) is a start error, not an answer', async () => {
		const f = await fixture();
		const chained = {
			...f.ctx,
			store: new Proxy(f.ctx.store, { get: (t, p, r) => (p === 'kind' ? 'remote' : Reflect.get(t, p, r)) }),
		};

		await expect(serveStdioRequest(stream(envelope('info')), { ctx: chained })).rejects.toBeInstanceOf(
			TaskServerStartError
		);
	});

	it('the answer holds neither the data folder of the project nor any token (there is none)', async () => {
		const f = await fixture();

		const answer = await stdio(f, envelope('get', { id: 'does-not-exist' }));

		expect(JSON.stringify(answer)).not.toContain(f.test.rootDir);
	});
});
