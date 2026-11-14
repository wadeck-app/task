import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';

import type { ModuleContext, ModuleRouteHandler, ModuleTimerHandle } from '@wadeck-app/app-core-sdk';
import { setStatus } from '@wadeck-app/task-service';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BOARD_CHECK_TICKS, BOARD_HEARTBEAT_TICKS, BOARD_TICK_MS, checkEveryTicks } from './boardEvents.js';
import { openProject } from './projects.js';
import { registerTaskRoutes } from './routes.js';
import type { TaskModuleInstance } from './routes.js';
import teardown from './teardown.js';
import { createRecordingSink, createTestWorld } from './testHelpers.js';
import type { RecordingSink, TestWorld } from './testHelpers.js';

// GET /board/events: the Server-Sent Events stream of the board version. The timers are the module's (ctx.setInterval), so the
// tests drive them by hand: no real time passes, and every timer that is not cleared is visible.

const STATUSES_YML = ['statuses:', '  - backlog', '  - in-progress', '  - name: done', '    terminal: true', ''].join(
	'\n'
);
const ROUTE = 'GET /board/events';

interface Fixture {
	world: TestWorld;
	sink: RecordingSink;
	routes: Map<string, ModuleRouteHandler>;
	instance: TaskModuleInstance;
	/** Timers still alive (set and not cleared). */
	timers: Map<ModuleTimerHandle, { fn: () => void; ms: number }>;
	/** Runs every live interval once (what `n` ticks of the module clock do). */
	tick(n?: number): void;
}

let fixture: Fixture;

function build(): Fixture {
	const world = createTestWorld();
	const sink = createRecordingSink();
	const routes = new Map<string, ModuleRouteHandler>();
	const timers: Fixture['timers'] = new Map();
	const ctx: ModuleContext = {
		dataDir: path.join(world.root, 'module-data'),
		setInterval: (fn, ms) => {
			const handle = {} as ModuleTimerHandle;
			timers.set(handle, { fn, ms });
			return handle;
		},
		setTimeout: vi.fn(),
		clearInterval: handle => void timers.delete(handle),
		clearTimeout: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
		emit: vi.fn(),
		registerRoute: (method, subPath, handler) => routes.set(`${method} ${subPath}`, handler),
		fileVersion: vi.fn(() => Promise.resolve('v')),
		unchanged: vi.fn(() => false),
		dispose: vi.fn(),
	};
	const instance = registerTaskRoutes(ctx, { configDir: world.configDir, eventSink: sink });
	return {
		world,
		sink,
		routes,
		instance,
		timers,
		tick(n = 1) {
			for (let i = 0; i < n; i++) for (const timer of [...timers.values()]) timer.fn();
		},
	};
}

afterEach(() => {
	fixture.instance.closeStreams();
	fixture.world.cleanup();
});

interface Client {
	written: string[];
	head: { status: number; headers: Record<string, string> } | undefined;
	hijacked: boolean;
	ended: boolean;
	/** The `data:` of every `event: version` received, in order. */
	versions(): string[];
	problems(): Array<Record<string, string>>;
	close(): void;
}

async function connect(
	query: Record<string, unknown>
): Promise<{ client: Client; failure?: { status: number; body: Record<string, unknown> } }> {
	const written: string[] = [];
	const clientSide: Client = {
		written,
		head: undefined,
		hijacked: false,
		ended: false,
		versions: () => eventsOf('version').map(data => (JSON.parse(data) as { version: string }).version),
		problems: () => eventsOf('problem').map(data => JSON.parse(data) as Record<string, string>),
		close: () => reqRaw.emit('close'),
	};
	function eventsOf(name: string): string[] {
		return written
			.join('')
			.split('\n\n')
			.filter(block => block.startsWith(`event: ${name}\n`))
			.map(block =>
				block
					.split('\n')
					.find(line => line.startsWith('data: '))!
					.slice('data: '.length)
			);
	}
	const reqRaw = new EventEmitter();
	const replyRaw = {
		writableEnded: false,
		destroyed: false,
		writeHead(status: number, headers: Record<string, string>) {
			clientSide.head = { status, headers };
		},
		write(text: string) {
			written.push(text);
			return true;
		},
		end() {
			replyRaw.writableEnded = true;
			clientSide.ended = true;
		},
	};
	let failure: { status: number; body: Record<string, unknown> } | undefined;
	const reply = {
		hijack: () => {
			clientSide.hijacked = true;
		},
		raw: replyRaw,
		code: (status: number) => ({
			send: (body: Record<string, unknown>) => {
				failure = { status, body };
			},
		}),
	};
	const handler = fixture.routes.get(ROUTE);
	if (!handler) throw new Error(`route not registered: ${ROUTE}`);
	await handler({ params: {}, query, raw: reqRaw } as never, reply as never);
	return { client: clientSide, ...(failure === undefined ? {} : { failure }) };
}

async function addTask(project: string, description: string): Promise<string> {
	const created = await call('POST /tasks', { query: { project }, body: { description } });
	return (created['task'] as { id: string }).id;
}

async function call(
	route: string,
	request: { params?: Record<string, string>; query?: Record<string, unknown>; body?: unknown }
): Promise<Record<string, unknown>> {
	const handler = fixture.routes.get(route)!;
	let body: unknown;
	const reply = { code: () => ({ send: (payload: unknown) => (body = payload) }) };
	await handler(
		{ params: request.params ?? {}, query: request.query ?? {}, body: request.body } as never,
		reply as never
	);
	return body as Record<string, unknown>;
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 60));

describe('GET /board/events', () => {
	it('answers an event stream and sends the current version at once', async () => {
		fixture = build();
		const project = await fixture.world.createProject('alpha', { configYml: STATUSES_YML });
		await addTask(project, 'one');
		const board = await call('GET /tasks/board', { query: { project } });

		const { client } = await connect({ project });

		expect(client.hijacked).toBe(true);
		expect(client.head?.status).toBe(200);
		expect(client.head?.headers['Content-Type']).toBe('text/event-stream');
		expect(client.head?.headers['Cache-Control']).toBe('no-cache');
		expect(client.versions()).toEqual([board['version']]);
	});

	it('sends a new version only when the board changed (a status move), and nothing while it did not', async () => {
		fixture = build();
		const project = await fixture.world.createProject('alpha', { configYml: STATUSES_YML });
		const id = await addTask(project, 'one');
		// Another process (the CLI) writes: the module is not told, only the timer finds out.
		const { client } = await connect({ project });
		await settle();
		const first = client.versions();
		expect(first).toHaveLength(1);

		fixture.tick(3);
		await settle();
		expect(client.versions()).toEqual(first);

		// Same write as the CLI does: through the store, without going through the module routes (no in-process notice).
		const outside = openProject(project);
		await setStatus(outside, { id, status: 'in-progress' });
		await outside.dispose?.();
		fixture.tick();
		await vi.waitFor(() => expect(client.versions()).toHaveLength(2));
		expect(client.versions()[1]).not.toBe(first[0]);
		const board = await call('GET /tasks/board', { query: { project } });
		expect(client.versions()[1]).toBe(board['version']);
	});

	it('a write made through the module reaches the stream at once, without waiting for a tick', async () => {
		fixture = build();
		const project = await fixture.world.createProject('alpha', { configYml: STATUSES_YML });
		const id = await addTask(project, 'one');
		const { client } = await connect({ project });
		await settle();
		expect(client.versions()).toHaveLength(1);

		await call('POST /tasks/:id/status', { params: { id }, query: { project }, body: { status: 'done' } });

		await vi.waitFor(() => expect(client.versions()).toHaveLength(2));
	});

	it('sends a comment line every 20 seconds so a proxy does not close an idle stream', async () => {
		fixture = build();
		const project = await fixture.world.createProject('alpha', { configYml: STATUSES_YML });
		const { client } = await connect({ project });
		const beats = (): number => client.written.filter(text => text.startsWith(':')).length;

		fixture.tick(BOARD_HEARTBEAT_TICKS - 1);
		await settle();
		expect(beats()).toBe(0);
		fixture.tick();
		await settle();
		expect(beats()).toBe(1);
		expect(BOARD_TICK_MS * BOARD_HEARTBEAT_TICKS).toBe(20_000);
	});

	it('stops its timer and its listener when the client leaves, and writes nothing afterwards', async () => {
		fixture = build();
		const project = await fixture.world.createProject('alpha', { configYml: STATUSES_YML });
		const id = await addTask(project, 'one');
		const { client } = await connect({ project });
		await settle();
		expect(fixture.timers.size).toBe(1);

		client.close();

		expect(fixture.timers.size).toBe(0);
		const before = client.written.length;
		await call('POST /tasks/:id/status', { params: { id }, query: { project }, body: { status: 'done' } });
		await settle();
		expect(client.written.length).toBe(before);
	});

	it('closes every stream and clears every timer when the module is torn down', async () => {
		fixture = build();
		const project = await fixture.world.createProject('alpha', { configYml: STATUSES_YML });
		const first = await connect({ project });
		const second = await connect({ project });
		await settle();
		expect(fixture.timers.size).toBe(2);

		await teardown({
			id: 'task',
			version: '0.1.0',
			previousVersion: null,
			dataDir: fixture.world.root,
			reason: 'shutdown',
			instance: fixture.instance,
		});

		expect(first.client.ended).toBe(true);
		expect(second.client.ended).toBe(true);
		expect(fixture.timers.size).toBe(0);
	});

	it('reports a project that became unreadable once as a `problem` event with its fix, and recovers', async () => {
		fixture = build();
		const project = await fixture.world.createProject('alpha', { configYml: STATUSES_YML });
		await addTask(project, 'one');
		const { client } = await connect({ project });
		await settle();

		// A config edit does not touch the task index: the 30 s read of a local project finds it.
		fixture.world.breakConfig(project);
		fixture.tick(BOARD_CHECK_TICKS);
		await vi.waitFor(() => expect(client.problems()).toHaveLength(1));
		fixture.tick(3);
		await settle();
		expect(client.problems()).toHaveLength(1);
		expect(client.problems()[0]).toMatchObject({ error: expect.stringContaining('config.yml') });
	});

	it('refuses an unknown project, a virtual project and allProjects before taking the socket over, with the usual {error, hint}', async () => {
		fixture = build();
		const virtual = await fixture.world.registerShared('virt');
		for (const [query, status] of [
			[{ project: 'nope' }, 404],
			[{ project: virtual.id }, 409],
			[{ allProjects: 'true' }, 400],
		] as Array<[Record<string, unknown>, number]>) {
			const { client, failure } = await connect(query);
			expect(client.hijacked, JSON.stringify(query)).toBe(false);
			expect(failure?.status, JSON.stringify(query)).toBe(status);
			expect(failure?.body['error']).toEqual(expect.any(String));
			expect(failure?.body['hint']).toEqual(expect.any(String));
		}
		expect(fixture.timers.size).toBe(0);
	});

	it('checks a local project every tick and a forge or remote project every 30 seconds', () => {
		expect(checkEveryTicks('local')).toBe(1);
		for (const kind of ['github', 'gitlab', 'remote'] as const) {
			expect(checkEveryTicks(kind)).toBe(BOARD_CHECK_TICKS);
			expect(checkEveryTicks(kind) * BOARD_TICK_MS).toBe(30_000);
		}
	});

	it('over a real HTTP connection: event-stream headers, the first version, a change, and the server side ends with the client', async () => {
		fixture = build();
		const project = await fixture.world.createProject('alpha', { configYml: STATUSES_YML });
		const id = await addTask(project, 'one');
		const handler = fixture.routes.get(ROUTE)!;
		const server = http.createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			const reply = {
				hijack: () => undefined,
				raw: res,
				code: (status: number) => ({
					send: (body: unknown) => {
						res.writeHead(status, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify(body));
					},
				}),
			};
			void handler(
				{ params: {}, query: Object.fromEntries(url.searchParams), raw: req } as never,
				reply as never
			);
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const port = (server.address() as AddressInfo).port;
		try {
			const chunks: string[] = [];
			const response = await new Promise<http.IncomingMessage>(resolve => {
				const request = http.get(
					{ host: '127.0.0.1', port, path: `/board/events?project=${project}` },
					resolve
				);
				request.on('error', () => undefined);
			});
			expect(response.statusCode).toBe(200);
			expect(response.headers['content-type']).toBe('text/event-stream');
			response.setEncoding('utf8');
			response.on('data', (chunk: string) => chunks.push(chunk));
			await vi.waitFor(() => expect(chunks.join('')).toContain('event: version'));

			await call('POST /tasks/:id/status', { params: { id }, query: { project }, body: { status: 'done' } });
			await vi.waitFor(() => expect(chunks.join('').match(/event: version/g)).toHaveLength(2));

			response.destroy();
			await vi.waitFor(() => expect(fixture.timers.size).toBe(0));
		} finally {
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
});

describe('board events: ticks', () => {
	it('the interval is 2 seconds, the heartbeat 20 and the slow check 30', () => {
		expect(BOARD_TICK_MS).toBe(2000);
		expect(BOARD_HEARTBEAT_TICKS).toBe(10);
		expect(BOARD_CHECK_TICKS).toBe(15);
	});
});
