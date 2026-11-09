// Test fixture of the task server: a real server on a free loopback port over a disposable local project, plus a raw HTTP caller that
// speaks the protocol. Shared by the server tests, the remote backend tests (the contract suite runs through it) and the CLI tests.
// Nothing shipped imports this file.
import { PROTOCOL_HEADER, buildRequest } from '@wadeck-app/task-core';
import type { ProtocolOperation, TaskResolvedConfig } from '@wadeck-app/task-core';

import type { TaskServiceContext } from '../context.js';
import type { EventDelivery, EventSink, TaskEvent } from '../events.js';
import { createTestContext } from '../testHelpers.js';
import type { TestContext } from '../testHelpers.js';
import { startTaskServer } from './taskServer.js';
import type { RunningTaskServer, TaskServerOptions } from './taskServer.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export const TEST_TOKEN = 'test-token-0123456789abcdef';

/** Records every event; `outcome` decides what the delivery answers. */
export class RecordingSink implements EventSink {
	readonly delivered: TaskEvent[] = [];
	flushes = 0;
	outcome: (event: TaskEvent) => EventDelivery | Promise<EventDelivery> = () => ({ delivered: true });

	async deliver(event: TaskEvent): Promise<EventDelivery> {
		this.delivered.push(event);
		return this.outcome(event);
	}

	flush(): Promise<void> {
		this.flushes++;
		return Promise.resolve();
	}

	names(): string[] {
		return this.delivered.map(event => event.name);
	}
}

export interface ServerFixture {
	server: RunningTaskServer;
	test: TestContext;
	ctx: TaskServiceContext;
	token: string;
	sink: RecordingSink;
	/** Calls an operation of the protocol and returns status, headers and the parsed body. */
	// The parsed JSON is checked by the assertions of the tests, not by the type system.
	call(
		op: ProtocolOperation,
		params?: Record<string, string>,
		body?: unknown,
		options?: { headers?: Record<string, string>; query?: Record<string, string | undefined> }
	): Promise<{ status: number; headers: Headers; body: Json }>;
	/** A request with nothing added: the caller sets every header. */
	raw(path: string, init?: RequestInit): Promise<{ status: number; headers: Headers; text: string }>;
	/** The headers of a well-formed request. */
	headers(extra?: Record<string, string>): Record<string, string>;
	stop(): Promise<void>;
}

export interface FixtureOptions extends Partial<Omit<TaskServerOptions, 'ctx' | 'token'>> {
	config?: Partial<TaskResolvedConfig>;
	token?: string;
	/** Wraps the backend of the served project (a slow or failing one). */
	wrap?: (ctx: TaskServiceContext) => TaskServiceContext;
	withSink?: boolean;
}

export async function startServerFixture(options: FixtureOptions = {}): Promise<ServerFixture> {
	const test = createTestContext(options.config);
	const base = { ...test.ctx, project: { id: 'ab12cd34', name: 'served', path: test.rootDir } };
	const ctx = options.wrap === undefined ? base : options.wrap(base);
	const token = options.token ?? TEST_TOKEN;
	const sink = new RecordingSink();
	const { config: _config, token: _token, wrap: _wrap, withSink, ...serverOptions } = options;
	const server = await startTaskServer({
		failedAuthDelayMs: 0,
		...serverOptions,
		ctx,
		token,
		...(withSink === true ? { eventSink: sink } : {}),
	});
	const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
		Authorization: `Bearer ${token}`,
		[PROTOCOL_HEADER]: '1',
		...extra,
	});
	return {
		server,
		test,
		ctx,
		token,
		sink,
		headers,
		async call(op, params = {}, body, callOptions = {}) {
			const { method, path } = buildRequest(op, params, callOptions.query);
			const response = await fetch(`${server.url}${path}`, {
				method,
				headers: headers({
					...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
					...callOptions.headers,
				}),
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
			const text = await response.text();
			return {
				status: response.status,
				headers: response.headers,
				body: text === '' ? undefined : (JSON.parse(text) as unknown),
			};
		},
		async raw(path, init) {
			const response = await fetch(`${server.url}${path}`, init);
			return { status: response.status, headers: response.headers, text: await response.text() };
		},
		async stop() {
			await server.close();
			test.cleanup();
		},
	};
}
