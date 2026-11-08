import { describe, expect, it } from 'vitest';

import type { ModuleContext } from '@wadeck-app/app-core-sdk';

import { createRouteKit } from './routeKit.js';

// The installed shell reads EVERY answer that is not a 204 with response.json(): an empty body makes the action fail with
// "Failed to execute 'json' on 'Response': Unexpected end of JSON input", with no status and no hint. The route kit is the one
// place every route answers through, so it is where an empty body is made impossible.

interface Sent {
	status: number;
	body: unknown;
}

function kitWith(run: Parameters<ReturnType<typeof createRouteKit>['route']>[2]): () => Promise<Sent> {
	let handler: ((req: unknown, reply: unknown) => unknown) | undefined;
	const ctx = {
		dataDir: '.',
		registerRoute: (_method: string, _subPath: string, h: typeof handler) => {
			handler = h;
		},
	} as unknown as ModuleContext;
	const kit = createRouteKit(ctx, {
		eventSink: { deliver: () => Promise.resolve() } as never,
		logDir: '.',
		writeStderr: () => undefined,
	});
	kit.route('POST', '/probe', run);
	return async () => {
		const sent: Sent = { status: 0, body: 'not sent' };
		const reply = {
			code: (status: number) => ({
				send: (body: unknown) => {
					sent.status = status;
					sent.body = body;
					return body;
				},
			}),
		};
		await handler?.({ params: {}, query: {}, body: undefined }, reply);
		return sent;
	};
}

describe('route kit answers', () => {
	it('answers an object body when a route returns an undefined body (never an empty response)', async () => {
		const call = kitWith(() => ({ status: 200, body: undefined }));

		const sent = await call();

		expect(sent.status).toBe(200);
		expect(sent.body).toEqual({});
	});

	it('answers an object body when a route returns a null body', async () => {
		const call = kitWith(() => ({ status: 201, body: null }));

		const sent = await call();

		expect(sent.status).toBe(201);
		expect(sent.body).toEqual({});
	});

	it('keeps a body that is there, whatever its shape', async () => {
		const call = kitWith(() => ({ status: 200, body: { a: 1 } }));

		expect((await call()).body).toEqual({ a: 1 });
	});
});
