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

		expect(sensitive).toEqual(['DELETE /tasks']);
	});

	it('leaves the deletion preview and the reversible writes at the host default', () => {
		h = setup();

		for (const route of [
			'POST /tasks/deletion-plans',
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

		const refused = await h.call('DELETE /tasks', { query: { project }, body: { ids: [id] } });
		expect(refused.status).toBe(400);
		const done = await h.call('DELETE /tasks', { query: { project }, body: { ids: [id], confirm: true } });
		expect(done.status).toBe(200);
	});

	it('DELETE /tasks takes the selection from the query string alone: no body, as a REST client sends it', async () => {
		h = setup();
		const project = await h.world.createProject('alpha');
		const created = await h.call('POST /tasks', { query: { project }, body: { description: 'one' } });
		const id = created.body['task'].id as string;

		const refused = await h.call('DELETE /tasks', { query: { project, ids: id } });
		expect(refused.status).toBe(400);
		expect(refused.body['hint']).toContain('confirm');
		const done = await h.call('DELETE /tasks', { query: { project, ids: id, cascade: 'false', confirm: 'true' } });
		expect(done.status).toBe(200);
		expect(done.body).toMatchObject({ deletedCount: 1 });
	});

	it('DELETE /tasks refuses a field given both in the query and in the body, naming it', async () => {
		h = setup();
		const project = await h.world.createProject('alpha');

		const answer = await h.call('DELETE /tasks', { query: { project, ids: 'a1' }, body: { ids: ['b2'] } });

		expect(answer.status).toBe(400);
		expect(answer.body['error']).toContain('ids');
		expect(answer.body['error']).toContain('query and in the body');
	});

	it('DELETE /tasks refuses a boolean flag of the query that is not true or false, naming it', async () => {
		h = setup();
		const project = await h.world.createProject('alpha');

		const answer = await h.call('DELETE /tasks', { query: { project, all: 'yes' } });

		expect(answer.status).toBe(400);
		expect(answer.body['error']).toContain('all must be true or false');
	});

	it('the old verb-in-the-path routes are gone: POST /tasks/delete and /tasks/delete/plan are not registered', () => {
		h = setup();

		expect(h.routes.has('POST /tasks/delete')).toBe(false);
		expect(h.routes.has('POST /tasks/delete/plan')).toBe(false);
	});
});
