// Test harness shared by the route test files: the routes registered on a fake module context, called with a request
// and answered as {status, body} (the routes only call reply.code(n).send(body)).
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ModuleContext, ModuleRouteHandler } from '@wadeck-app/app-core-sdk';
import type { EventSink } from '@wadeck-app/task-service';
import { vi } from 'vitest';

import { registerTaskRoutes } from './routes.js';
import type { TaskModuleInstance, TaskRoutesOptions } from './routes.js';
import { createRecordingSink, createTestWorld } from './testHelpers.js';
import type { RecordingSink, TestWorld } from './testHelpers.js';

export interface Answer {
	status: number;
	// Tests read nested fields of many answer shapes: untyped on purpose.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	body: Record<string, any>;
}

export interface Harness {
	instance: TaskModuleInstance;
	world: TestWorld;
	sink: RecordingSink;
	routes: Map<string, ModuleRouteHandler>;
	call(
		route: string,
		request?: { params?: Record<string, string>; query?: Record<string, unknown>; body?: unknown }
	): Promise<Answer>;
}

export function collectRoutes(dataDir: string): { routes: Map<string, ModuleRouteHandler>; ctx: ModuleContext } {
	const routes = new Map<string, ModuleRouteHandler>();
	const ctx: ModuleContext = {
		dataDir,
		setInterval: vi.fn(),
		setTimeout: vi.fn(),
		clearInterval: vi.fn(),
		clearTimeout: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
		emit: vi.fn(),
		registerRoute: (method, subPath, handler) => routes.set(`${method} ${subPath}`, handler),
		dispose: vi.fn(),
	};
	return { routes, ctx };
}

// `'default'` registers the routes WITHOUT an injected sink, so that the real queue sink (and `extra.createPublisher`) is used.
export function setup(eventSink?: EventSink | 'default', extra: Partial<TaskRoutesOptions> = {}): Harness {
	const world = createTestWorld();
	const sink = createRecordingSink();
	// The module's own persistent folder (ctx.dataDir): per world, so a test never sees the state of another.
	const { routes, ctx } = collectRoutes(path.join(world.root, 'module-data'));
	const injected = eventSink === 'default' ? {} : { eventSink: eventSink ?? sink };
	const instance = registerTaskRoutes(ctx, { configDir: world.configDir, ...injected, ...extra });
	return {
		instance,
		world,
		sink,
		routes,
		async call(route, request = {}) {
			const handler = routes.get(route);
			if (!handler) throw new Error(`route not registered: ${route}`);
			let status = 0;
			let body: unknown;
			const reply = {
				code: (n: number) => {
					status = n;
					return {
						send: (payload: unknown) => {
							body = payload;
							return payload;
						},
					};
				},
			};
			await handler(
				{ params: request.params ?? {}, query: request.query ?? {}, body: request.body } as never,
				reply as never
			);
			if (status === 0) throw new Error(`route ${route} answered nothing`);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			return { status, body: body as Record<string, any> };
		},
	};
}

/** Rewrites a task as an OLD file holds it (the whole text as title AND description), in its file and in the index. */
export function writeLegacyTitleIn(dataDir: string, id: string, text: string): void {
	const file = path.join(dataDir, 'tasks', `${id}.json`);
	const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
	record['title'] = text;
	record['description'] = text;
	fs.writeFileSync(file, JSON.stringify(record));
	const indexPath = path.join(dataDir, 'task-index.json');
	const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as { tasks: Array<{ id: string; title: string }> };
	for (const entry of index.tasks) {
		if (entry.id === id) entry.title = text;
	}
	fs.writeFileSync(indexPath, JSON.stringify(index));
}

/** `done` is terminal; the default config.yml of a project has no terminal status. */
export const STATUSES_YML = [
	'statuses:',
	'  - backlog',
	'  - in-progress',
	'  - name: done',
	'    terminal: true',
	'',
].join('\n');
