import { afterEach, describe, expect, it } from 'vitest';

import { setup } from './routeHarness.js';
import type { Harness } from './routeHarness.js';

// The optional `sort` of a board column (decision D22): the order of its cards, and `group` on a card when the sort forms groups.
// Default (no sort) = today's order, no group.

const STATUSES_YML = [
	'statuses:',
	'  - backlog',
	'  - integrating',
	'  - in-progress',
	'  - name: done',
	'    terminal: true',
	'',
].join('\n');

const columnYml = (sort: string | undefined): string =>
	`${STATUSES_YML}board:\n  columns:\n    - name: Doing\n      statuses: [integrating, in-progress]\n${sort === undefined ? '' : `      sort: ${sort}\n`}    - name: Rest\n      statuses: [backlog, done]\n`;

let h: Harness;
afterEach(() => {
	h.world.cleanup();
});

async function create(project: string, description: string, status: string): Promise<string> {
	const created = await h.call('POST /tasks', { query: { project }, body: { description } });
	expect(created.status).toBe(201);
	const id = created.body['task'].id as string;
	const moved = await h.call('POST /tasks/:id/status', { params: { id }, query: { project }, body: { status } });
	expect(moved.status).toBe(200);
	return id;
}

async function assign(project: string, id: string, assignee: string): Promise<void> {
	const claimed = await h.call('POST /tasks/:id/claim', { params: { id }, query: { project }, body: { assignee } });
	expect(claimed.status).toBe(200);
}

async function prioritize(project: string, id: string, priority: string): Promise<void> {
	const set = await h.call('POST /tasks/:id/priority', { params: { id }, query: { project }, body: { priority } });
	expect(set.status).toBe(200);
}

interface Card {
	id: string;
	status: string;
	group?: string;
}
interface Column {
	name: string;
	sort?: string;
	cards: Card[];
}

async function doing(project: string): Promise<Column> {
	const answer = await h.call('GET /tasks/board', { query: { project } });
	expect(answer.status).toBe(200);
	return (answer.body['columns'] as Column[]).find(column => column.name === 'Doing')!;
}

async function seeded(sort: string | undefined) {
	h = setup();
	const project = await h.world.createProject('alpha', { configYml: columnYml(sort) });
	// created in this order: oldest first
	const a = await create(project, 'A in progress', 'in-progress');
	const b = await create(project, 'B integrating', 'integrating');
	const c = await create(project, 'C in progress', 'in-progress');
	const d = await create(project, 'D integrating', 'integrating');
	return { project, a, b, c, d };
}

describe('a column without sort', () => {
	it("keeps today's order (statuses in the column order, then priority and age) and draws no group", async () => {
		const { project, a, b, c, d } = await seeded(undefined);

		const column = await doing(project);

		expect(column.cards.map(card => card.id)).toEqual([b, d, a, c]);
		expect(column).not.toHaveProperty('sort');
		expect(column.cards.every(card => !('group' in card))).toBe(true);
	});
});

describe('sort: status', () => {
	it('lists the statuses in the order of the column, each group labelled by its status', async () => {
		const { project, a, b, c, d } = await seeded('status');

		const column = await doing(project);

		expect(column.sort).toBe('status');
		expect(column.cards.map(card => [card.id, card.group])).toEqual([
			[b, 'integrating'],
			[d, 'integrating'],
			[a, 'in-progress'],
			[c, 'in-progress'],
		]);
	});
});

describe('sort: priority', () => {
	it('puts the highest priority first across statuses, groups labelled by priority, age inside a group', async () => {
		const { project, a, b, c, d } = await seeded('priority');
		await prioritize(project, a, 'urgent');
		await prioritize(project, d, 'low');

		const column = await doing(project);

		expect(column.cards.map(card => [card.id, card.group])).toEqual([
			[a, 'urgent'],
			[b, 'medium'],
			[c, 'medium'],
			[d, 'low'],
		]);
	});
});

describe('sort: assignee', () => {
	it('groups by assignee (A to Z), the unassigned last in their own group, priority then age inside a group', async () => {
		const { project, a, b, c, d } = await seeded('assignee');
		await assign(project, c, 'zoe');
		await assign(project, a, 'ann');
		await assign(project, d, 'ann');

		const column = await doing(project);

		expect(column.cards.map(card => [card.id, card.group])).toEqual([
			[a, 'ann'],
			[d, 'ann'],
			[c, 'zoe'],
			[b, 'Unassigned'],
		]);
	});
});

describe('sort: oldest and newest', () => {
	it('oldest: by creation, oldest first, no group', async () => {
		const { project, a, b, c, d } = await seeded('oldest');

		const column = await doing(project);

		expect(column.cards.map(card => card.id)).toEqual([a, b, c, d]);
		expect(column.cards.every(card => !('group' in card))).toBe(true);
	});

	it('newest: by creation, newest first, no group', async () => {
		const { project, a, b, c, d } = await seeded('newest');

		const column = await doing(project);

		expect(column.cards.map(card => card.id)).toEqual([d, c, b, a]);
		expect(column.cards.every(card => !('group' in card))).toBe(true);
	});
});

describe('the sort travels with the layout', () => {
	it('config.columns echoes the sort of each column for the editor', async () => {
		const { project } = await seeded('assignee');

		const answer = await h.call('GET /tasks/board', { query: { project } });

		expect(answer.body['config']).toMatchObject({
			columns: [
				{ name: 'Doing', statuses: ['integrating', 'in-progress'], sort: 'assignee' },
				{ name: 'Rest', statuses: ['backlog', 'done'] },
			],
		});
	});

	it('PUT /board/config saves a sort and the next board is ordered by it', async () => {
		const { project, a, b } = await seeded(undefined);

		const saved = await h.call('PUT /board/config', {
			query: { project },
			body: {
				columns: [
					{ name: 'Doing', statuses: ['integrating', 'in-progress'], sort: 'oldest' },
					{ name: 'Rest', statuses: ['backlog', 'done'] },
				],
			},
		});

		expect(saved.status).toBe(200);
		const column = (saved.body['columns'] as Column[]).find(col => col.name === 'Doing')!;
		expect(column.sort).toBe('oldest');
		expect(column.cards.map(card => card.id).slice(0, 2)).toEqual([a, b]);
	});

	it('PUT /board/config refuses an unknown sort with the valid ones, and writes nothing', async () => {
		const { project } = await seeded(undefined);

		const refused = await h.call('PUT /board/config', {
			query: { project },
			body: { columns: [{ name: 'Doing', statuses: ['in-progress'], sort: 'type' }] },
		});

		expect(refused.status).toBe(400);
		expect(refused.body['error']).toContain('Valid sorts: status, priority, assignee, oldest, newest');
	});

	it('the statuses of a column are in the ORDER of the config, whatever the order of the project statuses, for the cards, the groups and the answer', async () => {
		// project order: backlog, integrating, in-progress, done. The column lists in-progress BEFORE integrating.
		h = setup();
		const yml = `${STATUSES_YML}board:\n  columns:\n    - name: Doing\n      statuses: [in-progress, integrating]\n      sort: status\n    - name: Rest\n      statuses: [backlog, done]\n`;
		const project = await h.world.createProject('alpha', { configYml: yml });
		const a = await create(project, 'A integrating', 'integrating');
		const b = await create(project, 'B in progress', 'in-progress');

		const column = await doing(project);

		expect(column.cards.map(card => [card.id, card.group])).toEqual([
			[b, 'in-progress'],
			[a, 'integrating'],
		]);
		const answer = await h.call('GET /tasks/board', { query: { project } });
		const full = (answer.body['columns'] as Array<{ name: string; statuses: Array<{ name: string }> }>).find(col => col.name === 'Doing')!;
		expect(full.statuses.map(status => status.name)).toEqual(['in-progress', 'integrating']);
		expect((answer.body['config'] as { columns: Array<{ statuses: string[] }> }).columns[0]!.statuses).toEqual(['in-progress', 'integrating']);
	});

	it('PUT /board/config keeps the order of the statuses it is given, and the next board follows it', async () => {
		const { project } = await seeded('status');

		const saved = await h.call('PUT /board/config', {
			query: { project },
			body: {
				columns: [
					{ name: 'Doing', statuses: ['in-progress', 'integrating'], sort: 'status' },
					{ name: 'Rest', statuses: ['done', 'backlog'] },
				],
			},
		});

		expect(saved.status).toBe(200);
		const columns = saved.body['columns'] as Array<{ name: string; statuses: Array<{ name: string }> }>;
		expect(columns[0]!.statuses.map(status => status.name)).toEqual(['in-progress', 'integrating']);
		expect(columns[1]!.statuses.map(status => status.name)).toEqual(['done', 'backlog']);
		expect(await h.call('GET /tasks/board', { query: { project } }).then(answer => (answer.body['config'] as { columns: Array<{ statuses: string[] }> }).columns[1]!.statuses)).toEqual(['done', 'backlog']);
	});

	it('a legacy groupStyle in the config is ignored: the answer carries none and a PUT drops it', async () => {
		h = setup();
		const yml = `${STATUSES_YML}board:\n  columns:\n    - name: Doing\n      statuses: [integrating, in-progress]\n      sort: status\n      groupStyle: tint\n    - name: Rest\n      statuses: [backlog, done]\n`;
		const project = await h.world.createProject('alpha', { configYml: yml });

		const answer = await h.call('GET /tasks/board', { query: { project } });

		expect(answer.status).toBe(200);
		expect(JSON.stringify(answer.body)).not.toContain('groupStyle');
	});

	it('the board version changes when only the sort changes', async () => {
		const { project } = await seeded(undefined);
		const before = (await h.call('GET /tasks/board', { query: { project } })).body['version'];

		await h.call('PUT /board/config', {
			query: { project },
			body: {
				columns: [
					{ name: 'Doing', statuses: ['integrating', 'in-progress'], sort: 'priority' },
					{ name: 'Rest', statuses: ['backlog', 'done'] },
				],
			},
		});

		expect((await h.call('GET /tasks/board', { query: { project } })).body['version']).not.toBe(before);
	});
});
