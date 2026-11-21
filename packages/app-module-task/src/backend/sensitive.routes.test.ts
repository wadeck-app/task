import { afterEach, describe, expect, it } from 'vitest';

import { setup } from './routeHarness.js';
import type { Harness } from './routeHarness.js';

// Routes that only the user, in the browser, may trigger carry `effect: 'sensitive'` (app-core-cli >= 2026.11.20-209: the shell asks for the
// PIN and repeats the call). Everything else keeps the host default. The harness calls the handlers directly, so the PIN itself is the
// host's; what this module owns is WHICH routes are declared sensitive.
let h: Harness;
afterEach(() => h.world.cleanup());

describe('sensitive routes', () => {
	it('declares exactly the irreversible bulk deletion as sensitive', () => {
		h = setup();

		const sensitive = [...h.effects.entries()]
			.filter(([, effect]) => effect === 'sensitive')
			.map(([route]) => route);

		expect(sensitive).toEqual(['POST /tasks/delete']);
	});

	it('leaves the deletion preview and the reversible writes at the host default', () => {
		h = setup();

		for (const route of [
			'POST /tasks/delete/plan',
			'POST /tasks/:id/status',
			'POST /tasks/:id/comments',
			'PUT /board/config',
			'GET /tasks',
		]) {
			expect(h.routes.has(route), `${route} is not registered`).toBe(true);
			expect(h.effects.has(route), `${route} must keep the default effect`).toBe(false);
		}
	});

	it('still runs the deletion handler itself: a sensitive route is the same code behind the host gate', async () => {
		h = setup();
		const project = await h.world.createProject('alpha');
		const created = await h.call('POST /tasks', { query: { project }, body: { description: 'one' } });
		const id = created.body['task'].id as string;

		const refused = await h.call('POST /tasks/delete', { query: { project }, body: { ids: [id] } });
		expect(refused.status).toBe(400);
		const done = await h.call('POST /tasks/delete', { query: { project }, body: { ids: [id], confirm: true } });
		expect(done.status).toBe(200);
	});
});
