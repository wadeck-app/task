import * as fs from 'node:fs';
import * as path from 'node:path';

import { projectToolDir } from '@wadeck-app/project-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { BOARD_COLUMN_CAP } from './boardView.js';
import { setup } from './routeHarness.js';
import type { Harness } from './routeHarness.js';

// The board layout of config.yml (`board` key, decision D18): GET /tasks/board answers it, PUT / DELETE /board/config edit the
// project's OWN config layer. A move stays the existing POST /tasks/:id/status.

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

const GROUPED_YML = `${STATUSES_YML}board:
  columns:
    - name: To do
      statuses: [backlog]
    - name: Doing
      statuses: [in-progress, done]
`;

let h: Harness;
afterEach(() => {
	h.world.cleanup();
});

function configFile(project: string): string {
	return path.join(projectToolDir(h.world.registryDir, project, 'task', 'config'), 'config.yml');
}

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

async function board(project: string): Promise<Awaited<ReturnType<Harness['call']>>> {
	return h.call('GET /tasks/board', { query: { project } });
}

interface ColumnAnswer {
	key: string;
	name: string;
	label: string;
	implicit?: boolean;
	tone: string;
	terminal: boolean;
	outcome?: string;
	count: number;
	hiddenCount: number;
	statuses: Array<Record<string, unknown> & { name: string }>;
	cards: Array<{ id: string; status: string; tone: string }>;
}

async function columnsOf(project: string): Promise<ColumnAnswer[]> {
	return (await board(project)).body['columns'] as ColumnAnswer[];
}

describe('GET /tasks/board: configured columns (config.yml board key)', () => {
	it('answers the columns of the config, each with its statuses (tone, terminal, outcome, count); cards carry their status', async () => {
		h = setup();
		const project = await h.world.createProject('alpha', { configYml: GROUPED_YML });
		const a = await create(project, 'a');
		const b = await create(project, 'b', 'in-progress');
		const c = await create(project, 'c', 'done');

		const answer = await board(project);

		const columns = answer.body['columns'] as ColumnAnswer[];
		expect(columns.map(column => [column.key, column.name, column.label])).toEqual([
			['To do', 'To do', 'To do'],
			['Doing', 'Doing', 'Doing'],
			// rejected is in no column: it is simply not shown (no Unmapped column)
		]);
		expect(columns[0]).not.toHaveProperty('implicit');
		expect(columns[1]!.statuses).toEqual([
			{ name: 'in-progress', tone: 'info', terminal: false, count: 1 },
			{ name: 'done', tone: 'success', terminal: true, outcome: 'positive', count: 1 },
		]);
		expect(columns[1]).toMatchObject({ count: 2, hiddenCount: 0, terminal: false, tone: 'neutral' });
		expect(columns[1]!.cards.map(card => [card.id, card.status, card.tone])).toEqual([
			[b, 'in-progress', 'info'],
			[c, 'done', 'success'],
		]);
		expect(columns[0]!.cards.map(card => card.id)).toEqual([a]);
		expect(answer.body['config']).toEqual({
			isDefault: false,
			columns: [
				{ name: 'To do', statuses: ['backlog'] },
				{ name: 'Doing', statuses: ['in-progress', 'done'] },
			],
		});
		expect((answer.body['allStatuses'] as Array<{ name: string }>).map(status => status.name)).toEqual([
			'backlog',
			'in-progress',
			'done',
			'rejected',
		]);
	});

	it('a single-status column keeps the tone and flags of its status; a group of closed statuses is terminal', async () => {
		h = setup();
		const project = await h.world.createProject('alpha', {
			configYml: `${STATUSES_YML}board:
  columns:
    - name: Closed
      statuses: [done, rejected]
    - name: Open
      statuses: [backlog]
    - name: Active
      statuses: [in-progress]
`,
		});
		const columns = await columnsOf(project);
		expect(columns[0]).toMatchObject({ terminal: true });
		expect(columns[1]).toMatchObject({ terminal: false, tone: 'neutral' });
		expect(columns[2]).toMatchObject({ terminal: false, tone: 'info' });
	});

	it('a single-status column of a negative status is terminal with outcome negative and tone danger', async () => {
		h = setup();
		const project = await h.world.createProject('alpha', {
			configYml: `${STATUSES_YML}board:\n  columns:\n    - name: Rejected\n      statuses: [rejected]\n`,
		});
		const [column] = await columnsOf(project);
		expect(column).toMatchObject({ terminal: true, outcome: 'negative', tone: 'danger' });
	});

	it('inside a grouped column the cards follow the status order of the column first, then as today', async () => {
		h = setup();
		const yml = `${STATUSES_YML}board:
  columns:
    - name: All
      statuses: [done, in-progress, backlog]
`;
		const project = await h.world.createProject('alpha', { configYml: yml });
		const open1 = await create(project, 'open 1');
		const open2 = await create(project, 'open 2');
		await h.call('POST /tasks/:id/priority', {
			params: { id: open2 },
			query: { project },
			body: { priority: 'urgent' },
		});
		const prog = await create(project, 'prog', 'in-progress');
		const doneOld = await create(project, 'done old', 'done');
		await new Promise(resolve => setTimeout(resolve, 5));
		const doneNew = await create(project, 'done new', 'done');

		const [column] = await columnsOf(project);

		expect(column!.cards.map(card => card.id)).toEqual([doneNew, doneOld, prog, open2, open1]);
	});

	it('the cap is per column over the ordered cards of all its statuses; hiddenCount counts the rest', async () => {
		h = setup();
		const yml = `${STATUSES_YML}board:
  columns:
    - name: All
      statuses: [backlog, in-progress]
`;
		const project = await h.world.createProject('alpha', { configYml: yml });
		for (let index = 0; index < BOARD_COLUMN_CAP + 2; index++) await create(project, `task ${index}`);
		const [column] = await columnsOf(project);
		expect(column!.cards).toHaveLength(BOARD_COLUMN_CAP);
		expect(column!.count).toBe(BOARD_COLUMN_CAP + 2);
		expect(column!.hiddenCount).toBe(2);
	}, 60_000);

	it('a status in no column is not shown: no Unmapped column, and a one-line note counts the tasks that are hidden', async () => {
		h = setup();
		const full = await h.world.createProject('full', {
			configYml: `${STATUSES_YML}board:\n  columns:\n    - name: A\n      statuses: [backlog, in-progress, done, rejected]\n`,
		});
		expect((await columnsOf(full)).map(column => column.name)).toEqual(['A']);

		const part = await h.world.createProject('part', {
			configYml: `${STATUSES_YML}board:\n  columns:\n    - name: A\n      statuses: [backlog]\n`,
		});
		// nothing hidden yet: no note
		expect((await board(part)).body['hiddenNote']).toBeNull();
		await create(part, 'in a hidden status', 'done');
		await create(part, 'another', 'done');
		await create(part, 'third', 'rejected');
		await create(part, 'shown');
		const answer = await board(part);
		expect((answer.body['columns'] as ColumnAnswer[]).map(column => column.name)).toEqual(['A']);
		expect(answer.body['hiddenNote']).toBe(
			'3 tasks are in a status with no column and are not shown: done (2), rejected (1). Add the status to a column in Configure columns to show it.'
		);
		// a project with every status in a column hides nothing
		expect((await board(full)).body['hiddenNote']).toBeNull();
	});

	it('an invalid board in config.yml is a 400 naming the file and the key, with a hint', async () => {
		h = setup();
		const project = await h.world.createProject('alpha', {
			configYml: `${STATUSES_YML}board:\n  columns:\n    - name: A\n      statuses: [nope]\n`,
		});
		const answer = await board(project);
		expect(answer.status).toBe(400);
		expect(answer.body['error']).toEqual(expect.stringContaining('board.columns[0].statuses[0]'));
		expect(answer.body['error']).toEqual(expect.stringContaining('config.yml'));
		expect(answer.body['hint']).toEqual(expect.any(String));
	});

	it('moving a card to the exact status of an area is the existing status route (no new write route)', async () => {
		h = setup();
		const project = await h.world.createProject('alpha', { configYml: GROUPED_YML });
		const id = await create(project, 'move me');
		const moved = await h.call('POST /tasks/:id/status', {
			params: { id },
			query: { project },
			body: { status: 'done' },
		});
		expect(moved.status).toBe(200);
		const columns = await columnsOf(project);
		expect(columns[1]!.cards.map(card => [card.id, card.status])).toEqual([[id, 'done']]);
	});
});

describe('PUT /board/config and DELETE /board/config', () => {
	const COLUMNS = [
		{ name: 'Waiting', statuses: ['backlog'] },
		{ name: 'Finished', statuses: ['done', 'rejected'] },
	];

	it('PUT validates, writes the own layer, keeps the other keys and answers the new board (version included)', async () => {
		h = setup();
		const project = await h.world.createProject('alpha', { configYml: STATUSES_YML });
		const id = await create(project, 'one');
		const before = (await board(project)).body['version'];

		const answer = await h.call('PUT /board/config', { query: { project }, body: { columns: COLUMNS } });

		expect(answer.status).toBe(200);
		const columns = answer.body['columns'] as ColumnAnswer[];
		expect(columns.map(column => column.name)).toEqual(['Waiting', 'Finished']);
		expect(columns[0]!.cards.map(card => card.id)).toEqual([id]);
		expect(answer.body['config']).toEqual({ isDefault: false, columns: COLUMNS });
		const text = fs.readFileSync(configFile(project), 'utf8');
		expect(text).toEqual(expect.stringContaining('Waiting'));
		expect(text).toEqual(expect.stringContaining('statuses'));
		// the version changes with the layout, with no task change, and the answer carries the one a later GET gives
		expect(answer.body['version']).not.toBe(before);
		expect((await board(project)).body['version']).toBe(answer.body['version']);
	});

	it('PUT answers 400 naming the file and the key, with a hint, for each invalid layout, and writes nothing', async () => {
		h = setup();
		const project = await h.world.createProject('alpha', { configYml: STATUSES_YML });
		const before = fs.readFileSync(configFile(project), 'utf8');
		const cases: Array<[string, unknown, string]> = [
			['unknown status', [{ name: 'A', statuses: ['nope'] }], 'board.columns[0].statuses[0]'],
			[
				'status twice',
				[
					{ name: 'A', statuses: ['backlog'] },
					{ name: 'B', statuses: ['backlog'] },
				],
				'board.columns[1].statuses[0]',
			],
			['empty name', [{ name: ' ', statuses: ['backlog'] }], 'board.columns[0].name'],
			[
				'duplicate name',
				[
					{ name: 'A', statuses: ['backlog'] },
					{ name: 'a', statuses: ['done'] },
				],
				'board.columns[1].name',
			],
			['no status', [{ name: 'A', statuses: [] }], 'board.columns[0].statuses'],
			['no column', [], 'board.columns'],
		];
		for (const [label, columns, key] of cases) {
			const answer = await h.call('PUT /board/config', { query: { project }, body: { columns } });
			expect(answer.status, label).toBe(400);
			expect(answer.body['error'], label).toEqual(expect.stringContaining(key));
			expect(answer.body['error'], label).toEqual(expect.stringContaining('config.yml'));
			expect(answer.body['hint'], label).toEqual(expect.any(String));
		}
		expect(fs.readFileSync(configFile(project), 'utf8')).toBe(before);
	});

	it('PUT refuses a body that is not exactly { columns }: no body, no columns, another key', async () => {
		h = setup();
		const project = await h.world.createProject('alpha', { configYml: STATUSES_YML });
		for (const body of [undefined, {}, { columns: COLUMNS, extra: 1 }]) {
			const answer = await h.call('PUT /board/config', { query: { project }, body });
			expect(answer.status).toBe(400);
			expect(answer.body['hint']).toEqual(expect.any(String));
		}
		const notList = await h.call('PUT /board/config', { query: { project }, body: { columns: 'x' } });
		expect(notList.status).toBe(400);
		expect(notList.body['error']).toEqual(expect.stringContaining('board.columns'));
	});

	it('inlineErrors answers a refused PUT as a 200 with failed and errorText', async () => {
		h = setup();
		const project = await h.world.createProject('alpha', { configYml: STATUSES_YML });
		const answer = await h.call('PUT /board/config', {
			query: { project, inlineErrors: 'true' },
			body: { columns: [{ name: 'A', statuses: ['nope'] }] },
		});
		expect(answer.status).toBe(200);
		expect(answer.body['failed']).toBe(true);
		expect(answer.body['httpStatus']).toBe(400);
		expect(answer.body['errorText']).toEqual(expect.stringContaining('board.columns[0].statuses[0]'));
	});

	it('DELETE resets to one column per status and answers that board; resetting twice is fine', async () => {
		h = setup();
		const project = await h.world.createProject('alpha', { configYml: GROUPED_YML });
		const answer = await h.call('DELETE /board/config', { query: { project } });
		expect(answer.status).toBe(200);
		expect((answer.body['columns'] as ColumnAnswer[]).map(column => column.name)).toEqual([
			'backlog',
			'in-progress',
			'done',
			'rejected',
		]);
		expect(answer.body['config']).toMatchObject({ isDefault: true });
		expect(fs.readFileSync(configFile(project), 'utf8')).not.toEqual(expect.stringContaining('board'));
		expect((await h.call('DELETE /board/config', { query: { project } })).status).toBe(200);
	});

	it('PUT creates the own config file when the project has none', async () => {
		h = setup();
		const project = await h.world.createProject('alpha');
		const answer = await h.call('PUT /board/config', {
			query: { project },
			body: { columns: [{ name: 'Everything', statuses: ['backlog', 'in-progress', 'done'] }] },
		});
		expect(answer.status).toBe(200);
		expect(fs.existsSync(configFile(project))).toBe(true);
	});

	it('raises no queue event (a config edit, like the types)', async () => {
		h = setup();
		const project = await h.world.createProject('alpha', { configYml: STATUSES_YML });
		await h.call('PUT /board/config', { query: { project }, body: { columns: COLUMNS } });
		await h.call('DELETE /board/config', { query: { project } });
		expect(h.sink.events).toHaveLength(0);
	});

	it('unknown project 404, virtual project 409, allProjects 400', async () => {
		h = setup();
		const virtual = await h.world.registerShared('virt');
		const put = (query: Record<string, string>) =>
			h.call('PUT /board/config', { query, body: { columns: COLUMNS } });
		expect((await put({ project: 'nope' })).status).toBe(404);
		expect((await put({ project: virtual.id })).status).toBe(409);
		expect((await put({ allProjects: 'true' })).status).toBe(400);
		expect((await h.call('DELETE /board/config', { query: { allProjects: 'true' } })).status).toBe(400);
	});
});
