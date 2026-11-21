import { afterEach, describe, expect, it } from 'vitest';

import { setup } from './routeHarness.js';
import type { Harness } from './routeHarness.js';

// The card layout of the board (board.card, decision D24): PUT / DELETE /board/card, echoed as config.card, and the card carries the
// extra facts the layout can show (statusSince, parentId) from the index.

const YML = `statuses:\n  - backlog\n  - name: done\n    terminal: true\n`;

let h: Harness;
afterEach(() => h.world.cleanup());

async function create(project: string, description: string, extra: Record<string, unknown> = {}): Promise<string> {
	const created = await h.call('POST /tasks', { query: { project }, body: { description, ...extra } });
	expect(created.status).toBe(201);
	return created.body['task'].id as string;
}

interface BoardAnswer {
	config: { card?: unknown; columns: Array<{ name: string; statuses: string[] }>; isDefault: boolean };
	columns: Array<{ cards: Array<{ id: string; statusSince?: string; parentId?: string }> }>;
	version: string;
}

describe('cards carry what the layout can show', () => {
	it('statusSince and parentId come from the index (nothing is read from the task files)', async () => {
		h = setup();
		const project = await h.world.createProject('alpha', { configYml: YML });
		const parent = await create(project, 'parent');
		const child = await create(project, 'child', { parent });

		const answer = (await h.call('GET /tasks/board', { query: { project } })).body as unknown as BoardAnswer;

		const cards = answer.columns[0]!.cards;
		const byId = new Map(cards.map(card => [card.id, card]));
		expect(typeof byId.get(parent)!.statusSince).toBe('string');
		expect(byId.get(parent)).not.toHaveProperty('parentId');
		expect(byId.get(child)!.parentId).toBe(parent);
	});
});

describe('PUT /board/card and DELETE /board/card', () => {
	const CARD = { titleLines: 1, fields: [{ field: 'priority', style: 'dot' }, { field: 'assignee', style: 'initials' }] };

	it('saves the card layout, keeps the columns, echoes config.card, and changes the board version', async () => {
		h = setup();
		const project = await h.world.createProject('alpha', { configYml: YML });
		const before = ((await h.call('GET /tasks/board', { query: { project } })).body as unknown as BoardAnswer).version;

		const saved = await h.call('PUT /board/card', { query: { project }, body: CARD });

		expect(saved.status).toBe(200);
		const body = saved.body as unknown as BoardAnswer;
		expect(body.config.card).toEqual(CARD);
		expect(body.config.isDefault).toBe(false);
		expect(body.config.columns.map(column => column.name)).toEqual(['backlog', 'done']);
		expect(body.version).not.toBe(before);
	});

	it('saving the columns afterwards keeps the card', async () => {
		h = setup();
		const project = await h.world.createProject('alpha', { configYml: YML });
		await h.call('PUT /board/card', { query: { project }, body: CARD });

		const saved = await h.call('PUT /board/config', {
			query: { project },
			body: { columns: [{ name: 'All', statuses: ['backlog', 'done'] }] },
		});

		expect((saved.body as unknown as BoardAnswer).config.card).toEqual(CARD);
	});

	it('answers 400 naming the file and the key for a mistake, with the valid values, and writes nothing', async () => {
		h = setup();
		const project = await h.world.createProject('alpha', { configYml: YML });

		const refused = await h.call('PUT /board/card', {
			query: { project },
			body: { fields: [{ field: 'labels' }] },
		});

		expect(refused.status).toBe(400);
		expect(refused.body['error']).toContain('board.card.fields[0].field');
		expect(refused.body['error']).toContain('Valid fields: id, priority, assignee, status, created, statusSince, parent');
		const board = (await h.call('GET /tasks/board', { query: { project } })).body as unknown as BoardAnswer;
		expect(board.config.card).toBeUndefined();
	});

	it('an unknown key of the body is a 400, an empty body is the card with only its title (fields: [] is explicit)', async () => {
		h = setup();
		const project = await h.world.createProject('alpha', { configYml: YML });

		const unknown = await h.call('PUT /board/card', { query: { project }, body: { colour: 'red' } });
		expect(unknown.status).toBe(400);
		expect(unknown.body['error']).toContain('colour');

		const titleOnly = await h.call('PUT /board/card', { query: { project }, body: { fields: [] } });
		expect(titleOnly.status).toBe(200);
		expect((titleOnly.body as unknown as BoardAnswer).config.card).toEqual({ fields: [] });
	});

	it('DELETE removes the layout (the usual card again) and keeps the columns', async () => {
		h = setup();
		const project = await h.world.createProject('alpha', { configYml: YML });
		await h.call('PUT /board/card', { query: { project }, body: CARD });

		const cleared = await h.call('DELETE /board/card', { query: { project } });

		expect(cleared.status).toBe(200);
		const body = cleared.body as unknown as BoardAnswer;
		expect(body.config.card).toBeUndefined();
		expect(body.config.columns).toHaveLength(2);
	});
});
