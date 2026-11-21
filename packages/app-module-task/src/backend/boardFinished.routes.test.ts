import { afterEach, describe, expect, it, vi } from 'vitest';

import { setup } from './routeHarness.js';
import type { Harness } from './routeHarness.js';

// "Show finished tasks for" (decision D23): `board.finishedFor` hides a task in a TERMINAL status once it has been there longer than the
// window, by `statusSince` (the instant it entered the status; never updatedAt). No setting = today's behaviour (everything shown).

const YML = (finishedFor: string | undefined): string =>
	`statuses:\n  - backlog\n  - name: done\n    terminal: true\nboard:\n${finishedFor === undefined ? '' : `  finishedFor: ${finishedFor}\n`}  columns:\n    - name: Open\n      statuses: [backlog]\n    - name: Closed\n      statuses: [done]\n`;

let h: Harness;
afterEach(() => {
	vi.useRealTimers();
	h.world.cleanup();
});

interface Answer {
	columns: Array<{ name: string; count: number; cards: Array<{ id: string }>; statuses: Array<{ name: string; count: number }> }>;
	finishedNote: string | null;
	config: { finishedFor?: string };
	version: string;
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

async function board(project: string): Promise<Answer> {
	const answer = await h.call('GET /tasks/board', { query: { project } });
	expect(answer.status).toBe(200);
	return answer.body as unknown as Answer;
}

const HOUR = 3_600_000;
const T0 = new Date('2026-11-01T10:00:00.000Z').getTime();

/** Two finished tasks: `old` finished at T0, `recent` finished two days later; the clock then reads T0 + 2 days + 1 hour. */
async function seeded(finishedFor: string | undefined) {
	h = setup();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(T0);
	const project = await h.world.createProject('alpha', { configYml: YML(finishedFor) });
	const old = await create(project, 'old one', 'done');
	vi.setSystemTime(T0 + 48 * HOUR);
	const recent = await create(project, 'recent one', 'done');
	const open = await create(project, 'open one');
	vi.setSystemTime(T0 + 49 * HOUR);
	return { project, old, recent, open };
}

describe('finishedFor', () => {
	it('without the setting every finished task is shown, and there is no note', async () => {
		const { project, old, recent } = await seeded(undefined);

		const answer = await board(project);

		expect(answer.columns[1]!.cards.map(card => card.id).sort()).toEqual([old, recent].sort());
		expect(answer.finishedNote).toBeNull();
		expect(answer.config).not.toHaveProperty('finishedFor');
	});

	it('1d hides the task finished two days ago, keeps the one finished one hour ago, counts only what is shown, and says so once', async () => {
		const { project, recent } = await seeded('1d');

		const answer = await board(project);

		expect(answer.columns[1]!.cards.map(card => card.id)).toEqual([recent]);
		expect(answer.columns[1]!.count).toBe(1);
		expect(answer.columns[1]!.statuses[0]!.count).toBe(1);
		expect(answer.finishedNote).toBe(
			'1 finished task older than 1 day is not shown. Change "Show finished tasks for" in Configure columns, or find it on the Tasks page.'
		);
		expect(answer.config.finishedFor).toBe('1d');
	});

	it('7d keeps both, and the open tasks are never hidden by it', async () => {
		const { project, old, recent, open } = await seeded('7d');

		const answer = await board(project);

		expect(answer.columns[1]!.cards.map(card => card.id).sort()).toEqual([old, recent].sort());
		expect(answer.columns[0]!.cards.map(card => card.id)).toEqual([open]);
		expect(answer.finishedNote).toBeNull();
	});

	it.each([
		['1h', 1 * HOUR, '1 hour'],
		['4h', 4 * HOUR, '4 hours'],
		['8h', 8 * HOUR, '8 hours'],
		['1d', 24 * HOUR, '1 day'],
		['2d', 48 * HOUR, '2 days'],
		['7d', 7 * 24 * HOUR, '7 days'],
		['14d', 14 * 24 * HOUR, '14 days'],
	])('%s is the window of %i ms: a task finished just inside it stays, one just outside goes', async (value, ms, words) => {
		h = setup();
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(T0);
		const project = await h.world.createProject('alpha', { configYml: YML(value) });
		const inside = await create(project, 'inside', 'done');
		vi.setSystemTime(T0 + 1000);
		const outside = await create(project, 'outside', 'done');
		// the first finished at T0, the second one second later; read when the first is exactly window + 1 s old
		vi.setSystemTime(T0 + ms + 1000);

		const answer = await board(project);

		expect(answer.columns[1]!.cards.map(card => card.id)).toEqual([outside]);
		expect(inside).not.toBe(outside);
		expect(answer.finishedNote).toContain(`older than ${words}`);
	});

	it('a finished task WITHOUT a known date stays shown, and the note says how many have none (never hidden silently)', async () => {
		const { project, old } = await seeded('1d');
		// the legacy case: the index entry has no statusSince and the file cannot give it
		const fs = await import('node:fs');
		const path = await import('node:path');
		const { projectToolDir } = await import('@wadeck-app/project-sdk');
		const dataDir = projectToolDir(h.world.registryDir, project, 'task', 'data');
		const indexFile = path.join(dataDir, 'task-index.json');
		const index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as { tasks: Array<Record<string, unknown>> };
		for (const entry of index.tasks) if (entry['id'] === old) delete entry['statusSince'];
		fs.writeFileSync(indexFile, JSON.stringify(index));
		fs.writeFileSync(path.join(dataDir, 'tasks', `${old}.json`), '{ broken');

		const answer = await board(project);

		expect(answer.columns[1]!.cards.map(card => card.id)).toContain(old);
		expect(answer.finishedNote).toContain('1 finished task has no date and is shown');
	});

	it('the version changes when a task ages out with no other change', async () => {
		const { project } = await seeded('7d');
		const before = (await board(project)).version;

		vi.setSystemTime(T0 + 8 * 24 * HOUR);

		expect((await board(project)).version).not.toBe(before);
	});

	it('PUT /board/config saves finishedFor with the columns; an unknown value is a 400 naming the valid ones; null/absent = no limit', async () => {
		const { project } = await seeded(undefined);
		const columns = [
			{ name: 'Open', statuses: ['backlog'] },
			{ name: 'Closed', statuses: ['done'] },
		];

		const saved = await h.call('PUT /board/config', { query: { project }, body: { columns, finishedFor: '2d' } });
		expect(saved.status).toBe(200);
		expect((saved.body as unknown as Answer).config.finishedFor).toBe('2d');
		expect((saved.body as unknown as Answer).columns[1]!.cards).toHaveLength(1);

		const bad = await h.call('PUT /board/config', { query: { project }, body: { columns, finishedFor: '3d' } });
		expect(bad.status).toBe(400);
		expect(bad.body['error']).toContain('Valid values: 1h, 4h, 8h, 1d, 2d, 7d, 14d');

		const cleared = await h.call('PUT /board/config', { query: { project }, body: { columns, finishedFor: null } });
		expect(cleared.status).toBe(200);
		expect((cleared.body as unknown as Answer).config).not.toHaveProperty('finishedFor');
		expect((cleared.body as unknown as Answer).columns[1]!.cards).toHaveLength(2);
	});
});
