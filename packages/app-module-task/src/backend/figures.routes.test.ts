import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { setup } from './routeHarness.js';
import type { Harness } from './routeHarness.js';

// The live figures of the shell (manifest `count`): path-only routes answering a whole number at `count`.
const STATUSES_YML = ['statuses:', '  - backlog', '  - name: done', '    terminal: true', ''].join('\n');

let h: Harness;
afterEach(() => h.world.cleanup());

async function addTask(project: string, description: string, status?: string): Promise<string> {
	const created = await h.call('POST /tasks', { query: { project }, body: { description } });
	expect(created.status).toBe(201);
	const id = created.body['task'].id as string;
	if (status !== undefined) {
		const moved = await h.call('POST /tasks/:id/status', { params: { id }, query: { project }, body: { status } });
		expect(moved.status).toBe(200);
	}
	return id;
}

describe('GET /tasks/open/count (all projects)', () => {
	it('adds the open tasks of every readable project and skips the terminal ones', async () => {
		h = setup();
		const alpha = await h.world.createProject('alpha', { configYml: STATUSES_YML });
		const beta = await h.world.createProject('beta', { configYml: STATUSES_YML });
		await addTask(alpha, 'one');
		await addTask(alpha, 'two', 'done');
		await addTask(beta, 'three');

		const answer = await h.call('GET /tasks/open/count');

		expect(answer.status).toBe(200);
		expect(answer.body).toEqual({ count: 2 });
	});

	it('is 0 when nothing is registered: an answer, not an error', async () => {
		h = setup();
		const answer = await h.call('GET /tasks/open/count');
		expect(answer).toMatchObject({ status: 200, body: { count: 0 } });
	});

	it('does not count an unreadable project and still answers for the others', async () => {
		h = setup();
		const alpha = await h.world.createProject('alpha', { configYml: STATUSES_YML });
		const broken = await h.world.createProject('broken');
		await addTask(alpha, 'one');
		h.world.breakConfig(broken);

		const answer = await h.call('GET /tasks/open/count');

		expect(answer).toMatchObject({ status: 200, body: { count: 1 } });
	});

	it('fails (shows no figure) when projects are registered and none can be read: 0 would read as "no tasks"', async () => {
		h = setup();
		h.world.breakConfig(await h.world.createProject('broken'));

		const answer = await h.call('GET /tasks/open/count');

		expect(answer.status).toBeGreaterThanOrEqual(400);
	});
});

describe('GET /tasks/p/:project/open/count', () => {
	it('counts the open tasks of the project named by id, name or alias in the path', async () => {
		h = setup();
		const id = await h.world.createProject('alpha', { configYml: STATUSES_YML });
		await h.world.createProject('beta', { configYml: STATUSES_YML });
		await addTask(id, 'one');
		await addTask(id, 'two');
		await addTask(id, 'three', 'done');

		for (const ref of [id, 'alpha', 'ALPHA']) {
			const answer = await h.call('GET /tasks/p/:project/open/count', { params: { project: ref } });
			expect(answer, ref).toMatchObject({ status: 200, body: { count: 2 } });
		}
	});

	it('is 0 for a fresh project', async () => {
		h = setup();
		const id = await h.world.createProject('fresh');
		const answer = await h.call('GET /tasks/p/:project/open/count', { params: { project: id } });
		expect(answer).toMatchObject({ status: 200, body: { count: 0 } });
	});

	it('404 for an unknown project, 409 for a virtual one (naming the fix)', async () => {
		h = setup();
		await h.world.registerShared('notes');
		const unknown = await h.call('GET /tasks/p/:project/open/count', { params: { project: 'nope' } });
		const virtual = await h.call('GET /tasks/p/:project/open/count', { params: { project: 'notes' } });
		expect(unknown.status).toBe(404);
		expect(virtual.status).toBe(409);
		expect(virtual.body['hint']).toContain('task -p notes');
	});
});

describe('GET /types/p/:project/count', () => {
	it('counts the types of the project, with the same project errors', async () => {
		h = setup();
		const id = await h.world.createProject('alpha');
		expect((await h.call('POST /types', { query: { project: id }, body: { name: 'bug' } })).status).toBe(200);
		expect((await h.call('POST /types', { query: { project: id }, body: { name: 'story' } })).status).toBe(200);
		await h.world.registerShared('notes');

		const answer = await h.call('GET /types/p/:project/count', { params: { project: 'alpha' } });
		const unknown = await h.call('GET /types/p/:project/count', { params: { project: 'nope' } });
		const virtual = await h.call('GET /types/p/:project/count', { params: { project: 'notes' } });

		expect(answer).toMatchObject({ status: 200, body: { count: 2 } });
		expect(unknown.status).toBe(404);
		expect(virtual.status).toBe(409);
	});
});

// The manifest side: `check` and `package` of app-core-cli validate the same rules, these tests keep them in the unit run.
describe('manifest.json count (figures next to entries)', () => {
	type Count = { route: string; field: string; refreshSeconds?: number };
	type Point = { path?: string; slot: string; count?: Count; tab?: { group: string; label: string; count?: Count } };
	const packageDir = join(dirname(fileURLToPath(import.meta.url)), '../..');
	const manifest = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8')) as {
		extensionPoints: Point[];
	};
	const counted = manifest.extensionPoints.flatMap(point => {
		const entries: { where: string; page: string; count: Count }[] = [];
		if (point.count !== undefined)
			entries.push({ where: `menu ${point.path}`, page: point.path ?? '', count: point.count });
		if (point.tab?.count !== undefined) {
			entries.push({ where: `tab ${point.tab.label}`, page: point.path ?? '', count: point.tab.count });
		}
		return entries;
	});

	it('gives a figure to the Tasks menu entry and to the Tasks and Types tabs of the project group, none to Tree or other entries', () => {
		expect(counted.map(entry => entry.where)).toEqual(['menu /tasks', 'tab Tasks', 'tab Types']);
		const tabs = manifest.extensionPoints.filter(point => point.tab?.group === 'project');
		expect(tabs.map(point => `${point.tab?.label}:${point.tab?.count === undefined ? 'no' : 'count'}`)).toEqual([
			'Tasks:count',
			'Tree:no',
			'Types:count',
		]);
	});

	it('reads each figure from a registered GET route, path only, using no other parameter than its page has', () => {
		h = setup();
		for (const { where, page, count } of counted) {
			expect(count.route, where).toMatch(/^\/[\w/:-]+$/);
			expect(count.route, where).not.toMatch(/[?#]/);
			expect(h.routes.has(`GET ${count.route}`), `${where}: GET ${count.route} is not registered`).toBe(true);
			const pageParams = new Set([...page.matchAll(/:(\w+)/g)].map(match => match[1]));
			for (const param of count.route.matchAll(/:(\w+)/g)) {
				expect(pageParams.has(param[1] as string), `${where}: :${param[1]} is not a parameter of ${page}`).toBe(
					true
				);
			}
			expect(count.field, where).toBe('count');
			expect(count.refreshSeconds, where).toBe(60);
		}
	});

	it('the menu entry has no parameter in its route (a menu entry has none)', () => {
		const menu = counted.find(entry => entry.where === 'menu /tasks');
		expect(menu?.count.route).not.toContain(':');
	});
});
