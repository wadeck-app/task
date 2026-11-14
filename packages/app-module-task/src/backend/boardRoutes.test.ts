import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BOARD_COLUMN_CAP } from './boardView.js';
import { setup } from './routeHarness.js';
import type { Harness } from './routeHarness.js';

// GET /tasks/board: the data of the Kanban board of ONE project. One read of the list (the index), never a task file.

const STATUSES_YML = [
	'statuses:',
	'  - backlog',
	'  - in-progress',
	'  - name: done',
	'    terminal: true',
	'  - name: rejected',
	'    terminal: true',
	'    outcome: negative',
	'',
].join('\n');
const ROUTE = 'GET /tasks/board';

let h: Harness;
afterEach(() => {
	delete process.env['TASK_KANBAN_AB'];
	h.world.cleanup();
});

async function create(project: string, description: string, status?: string): Promise<string> {
	const created = await h.call('POST /tasks', { query: { project }, body: { description } });
	expect(created.status).toBe(201);
	const id = created.body['task'].id as string;
	if (status !== undefined) {
		const moved = await h.call('POST /tasks/:id/status', { params: { id }, query: { project }, body: { status } });
		expect(moved.status).toBe(200);
	}
	return id;
}

async function board(
	project: string,
	extra: Record<string, string> = {}
): Promise<Awaited<ReturnType<Harness['call']>>> {
	return h.call(ROUTE, { query: { project, ...extra } });
}

describe('GET /tasks/board: shape', () => {
	it('answers one column per status of the config, in config order, with count, tone and terminal flags', async () => {
		h = setup();
		const project = await h.world.createProject('alpha', { configYml: STATUSES_YML });
		await create(project, 'first');
		await create(project, 'second');
		await create(project, 'third', 'in-progress');
		await create(project, 'fourth', 'done');

		const answer = await board(project);

		expect(answer.status).toBe(200);
		const columns = answer.body['columns'] as Array<Record<string, unknown>>;
		expect(columns.map(column => column['status'])).toEqual(['backlog', 'in-progress', 'done', 'rejected']);
		expect(columns.map(column => column['count'])).toEqual([2, 1, 1, 0]);
		expect(columns.map(column => column['hiddenCount'])).toEqual([0, 0, 0, 0]);
		expect(columns.map(column => column['terminal'])).toEqual([false, false, true, true]);
		expect(columns.map(column => column['tone'])).toEqual(['neutral', 'info', 'success', 'danger']);
		expect(columns[2]).toMatchObject({ outcome: 'positive' });
		expect(columns[3]).toMatchObject({ outcome: 'negative' });
		expect(columns[0]).not.toHaveProperty('outcome');
		expect(columns.map(column => (column['cards'] as unknown[]).length)).toEqual([2, 1, 1, 0]);
		expect(answer.body['hasCards']).toBe(true);
		expect(answer.body['emptyText']).toBeNull();
		expect(answer.body['abSwitcher']).toBe(false);
		expect(answer.body['projectParam']).toBe(encodeURIComponent(project));
	});

	it('a card has the headline, the page address, the effective priority, the assignee and the tone of its column', async () => {
		h = setup();
		const project = await h.world.createProject('alpha', { configYml: STATUSES_YML });
		const long = `${'word '.repeat(40)}end`;
		const plain = await create(project, 'Plain task');
		const withFields = await create(project, long, 'in-progress');
		const set = await h.call('POST /tasks/:id/priority', {
			params: { id: withFields },
			query: { project },
			body: { priority: 'urgent' },
		});
		expect(set.status).toBe(200);
		const claimed = await h.call('POST /tasks/:id/claim', {
			params: { id: withFields },
			query: { project },
			body: { assignee: 'worker-1' },
		});
		expect(claimed.status).toBe(200);

		const columns = (await board(project)).body['columns'] as Array<{ cards: Array<Record<string, unknown>> }>;

		const card = columns[0]!.cards[0]!;
		expect(card).toMatchObject({
			id: plain,
			headline: 'Plain task',
			href: `/modules/task/tasks/p/${project}/${plain}`,
			priority: 'medium',
			priorityText: 'medium (default)',
			tone: 'neutral',
		});
		expect(typeof card['createdAt']).toBe('string');
		expect(card).not.toHaveProperty('assignee');
		const rich = columns[1]!.cards[0]!;
		expect(rich).toMatchObject({
			id: withFields,
			priority: 'urgent',
			priorityText: 'urgent',
			assignee: 'worker-1',
			tone: 'info',
		});
		expect((rich['headline'] as string).length).toBeLessThanOrEqual(90);
	});

	it('orders the cards of an open column by priority then age, and a closed column newest first', async () => {
		h = setup();
		const project = await h.world.createProject('alpha', { configYml: STATUSES_YML });
		const low = await create(project, 'low one');
		const urgent = await create(project, 'urgent one');
		await h.call('POST /tasks/:id/priority', {
			params: { id: urgent },
			query: { project },
			body: { priority: 'urgent' },
		});
		await h.call('POST /tasks/:id/priority', {
			params: { id: low },
			query: { project },
			body: { priority: 'low' },
		});
		const doneOld = await create(project, 'done old', 'done');
		await new Promise(resolve => setTimeout(resolve, 5));
		const doneNew = await create(project, 'done new', 'done');

		const columns = (await board(project)).body['columns'] as Array<{ cards: Array<{ id: string }> }>;

		expect(columns[0]!.cards.map(card => card.id)).toEqual([urgent, low]);
		expect(columns[2]!.cards.map(card => card.id)).toEqual([doneNew, doneOld]);
	});

	it('an empty project has the columns, no card, hasCards false and a text saying what to do', async () => {
		h = setup();
		const project = await h.world.createProject('alpha', { configYml: STATUSES_YML });

		const answer = await board(project);

		expect(answer.status).toBe(200);
		expect(answer.body['hasCards']).toBe(false);
		expect(answer.body['emptyText']).toEqual(expect.stringContaining('No task yet'));
		expect((answer.body['columns'] as unknown[]).length).toBe(4);
	});

	it('shows at most BOARD_COLUMN_CAP cards per column and counts the others in hiddenCount (count stays the real total)', async () => {
		h = setup();
		const project = await h.world.createProject('alpha', { configYml: STATUSES_YML });
		const total = BOARD_COLUMN_CAP + 3;
		for (let index = 0; index < total; index++) await create(project, `task ${index}`);

		const column = ((await board(project)).body['columns'] as Array<Record<string, unknown>>)[0]!;

		expect((column['cards'] as unknown[]).length).toBe(BOARD_COLUMN_CAP);
		expect(column['count']).toBe(total);
		expect(column['hiddenCount']).toBe(3);
	}, 60_000);

	it('says so when a task is in a status the config does not list, instead of dropping it silently', async () => {
		h = setup();
		const project = await h.world.createProject('alpha', { configYml: STATUSES_YML });
		const id = await create(project, 'stray');
		const file = path.join(h.world.dataDirOf(project), 'tasks', `${id}.json`);
		const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
		record['status'] = 'archived';
		fs.writeFileSync(file, JSON.stringify(record));
		const indexFile = path.join(h.world.dataDirOf(project), 'task-index.json');
		const index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as {
			tasks: Array<{ id: string; status: string }>;
		};
		for (const entry of index.tasks) if (entry.id === id) entry.status = 'archived';
		fs.writeFileSync(indexFile, JSON.stringify(index));

		const answer = await board(project);

		expect(answer.status).toBe(200);
		expect(answer.body['warning']).toEqual(expect.stringContaining(id));
		expect(answer.body['warning']).toEqual(expect.stringContaining('archived'));
		expect(answer.body['warning']).toEqual(expect.stringContaining('config.yml'));
	});

	it('reads the index only: the board still answers when every task file is unreadable', async () => {
		h = setup();
		const project = await h.world.createProject('alpha', { configYml: STATUSES_YML });
		const ids = [await create(project, 'one'), await create(project, 'two', 'in-progress')];
		for (const id of ids)
			fs.writeFileSync(path.join(h.world.dataDirOf(project), 'tasks', `${id}.json`), '{ not json');

		const answer = await board(project);

		expect(answer.status).toBe(200);
		expect((answer.body['columns'] as Array<{ count: number }>).map(column => column.count)).toEqual([1, 1, 0, 0]);
	});

	it('abSwitcher is true only when TASK_KANBAN_AB=1 is set in the module process', async () => {
		h = setup();
		const project = await h.world.createProject('alpha', { configYml: STATUSES_YML });
		process.env['TASK_KANBAN_AB'] = '1';
		expect((await board(project)).body['abSwitcher']).toBe(true);
		process.env['TASK_KANBAN_AB'] = '0';
		expect((await board(project)).body['abSwitcher']).toBe(false);
	});
});

describe('GET /tasks/board: version', () => {
	it('is stable while the board does not change, and changes with a status, title, priority or assignee change', async () => {
		h = setup();
		const project = await h.world.createProject('alpha', { configYml: STATUSES_YML });
		const id = await create(project, 'Versioned');
		const read = async (): Promise<string> => (await board(project)).body['version'] as string;

		const first = await read();
		expect(first).toMatch(/^[0-9a-f]{16}$/);
		expect(await read()).toBe(first);

		await h.call('POST /tasks/:id/status', { params: { id }, query: { project }, body: { status: 'in-progress' } });
		const afterStatus = await read();
		expect(afterStatus).not.toBe(first);

		await h.call('PATCH /tasks/:id', { params: { id }, query: { project }, body: { title: 'Renamed' } });
		const afterTitle = await read();
		expect(afterTitle).not.toBe(afterStatus);

		await h.call('POST /tasks/:id/priority', { params: { id }, query: { project }, body: { priority: 'high' } });
		const afterPriority = await read();
		expect(afterPriority).not.toBe(afterTitle);

		await h.call('POST /tasks/:id/assignee', { params: { id }, query: { project }, body: { assignee: 'someone' } });
		expect(await read()).not.toBe(afterPriority);
	});

	it('does not change for something the board does not show (a comment)', async () => {
		h = setup();
		const project = await h.world.createProject('alpha', { configYml: STATUSES_YML });
		const id = await create(project, 'Commented');
		const before = (await board(project)).body['version'];

		await h.call('POST /tasks/:id/comments', { params: { id }, query: { project }, body: { text: 'hello' } });

		expect((await board(project)).body['version']).toBe(before);
	});

	it('changes when the first task is added to an empty board', async () => {
		h = setup();
		const project = await h.world.createProject('alpha', { configYml: STATUSES_YML });
		const empty = (await board(project)).body['version'];
		await create(project, 'something');
		expect((await board(project)).body['version']).not.toBe(empty);
	});
});

describe('GET /tasks/board: errors and scopes', () => {
	it('?blank=true answers the empty answer that replaces the previous scope', async () => {
		h = setup();
		const answer = await h.call(ROUTE, { query: { blank: 'true' } });
		expect(answer).toEqual({ status: 200, body: { blank: true } });
	});

	it('allProjects is a 400 naming it: a board is per project', async () => {
		h = setup();
		const answer = await h.call(ROUTE, { query: { allProjects: 'true' } });
		expect(answer.status).toBe(400);
		expect(answer.body['error']).toEqual(expect.stringContaining('allProjects'));
		expect(answer.body['hint']).toEqual(expect.stringContaining('?project='));
	});

	it('unknown project 404, virtual project 409, unreadable project 4xx; inlineErrors answers each as a 200 with failed', async () => {
		h = setup();
		const virtual = await h.world.registerShared('virt');
		const broken = await h.world.createProject('broken', { configYml: STATUSES_YML });
		h.world.breakConfig(broken);
		const expected: Array<[string, number]> = [
			['nope', 404],
			[virtual.id, 409],
		];
		for (const [ref, status] of expected) {
			const plain = await board(ref);
			expect(plain.status).toBe(status);
			expect(plain.body['error']).toEqual(expect.any(String));
			expect(plain.body['hint']).toEqual(expect.any(String));
			const inline = await board(ref, { inlineErrors: 'true' });
			expect(inline.status).toBe(200);
			expect(inline.body['failed']).toBe(true);
			expect(inline.body['httpStatus']).toBe(status);
			expect(inline.body['errorText']).toEqual(expect.any(String));
		}
		const unreadable = await board(broken);
		expect(unreadable.status).toBeGreaterThanOrEqual(400);
		expect(unreadable.body['error']).toEqual(expect.stringContaining('config.yml'));
	});

	it('takes a name or an alias like every route', async () => {
		h = setup();
		const project = await h.world.createProject('alpha', { configYml: STATUSES_YML });
		const answer = await board('alpha');
		expect(answer.status).toBe(200);
		expect(answer.body['projectParam']).toBe(encodeURIComponent(project));
	});
});
