// Routes and detail fields added for the redesigned task page: search, labels, text edit, metadata and type removal.
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { EventSink } from '@wadeck-app/task-service';

import { setup, STATUSES_YML, writeLegacyTitleIn } from './routeHarness.js';
import type { Harness } from './routeHarness.js';

let h: Harness;
let project: string;

beforeEach(async () => {
	h = setup();
	project = await h.world.createProject('alpha', { configYml: STATUSES_YML });
});
afterEach(() => h.world.cleanup());

async function createTask(description: string, extra: Record<string, unknown> = {}): Promise<string> {
	const answer = await h.call('POST /tasks', { query: { project }, body: { description, ...extra } });
	expect(answer.status).toBe(201);
	h.sink.events.length = 0;
	return answer.body['task'].id as string;
}

const legacyTitle = (id: string, text: string): void => writeLegacyTitleIn(h.world.dataDirOf(project), id, text);

/** A harness whose queue never receives anything, with one project `beta`. */
async function unreachableWorld(): Promise<{ failing: Harness; dir: string }> {
	const unreachable: EventSink = { deliver: () => Promise.resolve({ delivered: false, reason: 'exit 3' }) };
	const failing = setup(unreachable);
	return { failing, dir: await failing.world.createProject('beta') };
}

describe('GET /tasks/:id presentation for the redesigned task page', () => {
	const detail = (id: string) => h.call('GET /tasks/:id', { params: { id }, query: { project } });
	const call = (route: string, id: string, body?: unknown) =>
		h.call(route, { params: { id }, query: { project }, body });

	it('reads no task file but the task, its parent, children and linked tasks: the other 200 files may be unreadable', async () => {
		const parent = await createTask('the parent');
		const id = await createTask('the task', { parent });
		const child = await createTask('the child', { parent: id });
		const blocker = await createTask('the blocker');
		await call('POST /tasks/:id/links', id, { type: 'blockedBy', target: blocker });
		await call('POST /tasks/:id/labels', id, { label: 'billing' });
		await call('POST /tasks/:id/meta', id, { key: 'sprint', value: '1' });
		const others: string[] = [];
		for (let index = 0; index < 200; index++) others.push(await createTask(`other ${index}`));
		// Any scan of the project would hit one of these and fail the route.
		for (const other of others) {
			fs.writeFileSync(path.join(h.world.dataDirOf(project), 'tasks', `${other}.json`), 'not json');
		}
		const { status, body } = await detail(id);
		expect(status).toBe(200);
		expect(child).toBeTruthy();
		expect(body['deleteImpact']).toMatchObject({ childCount: 1, descendantCount: 1, linkCount: 1 });
		expect(body['pills']).toHaveLength(5);
		expect(body).not.toHaveProperty('labelSuggestions');
		expect(body).not.toHaveProperty('metaKeys');
	});

	it('statusOptions are the statuses of the merged config with tone and terminal (same source as set-status)', async () => {
		const { body } = await detail(await createTask('t'));
		expect(body['statusOptions']).toEqual([
			{ value: 'backlog', label: 'backlog', tone: 'neutral', terminal: false },
			{ value: 'in-progress', label: 'in-progress', tone: 'info', terminal: false },
			{ value: 'done', label: 'done', tone: 'success', terminal: true, outcome: 'positive' },
		]);
	});

	it('typeOptions is empty when the project configures no type (free text), else starts with the "none" entry', async () => {
		const id = await createTask('t');
		expect((await detail(id)).body['typeOptions']).toEqual([]);
		await h.call('POST /types', { query: { project }, body: { name: 'bug' } });
		expect((await detail(id)).body['typeOptions'][0]).toEqual({ value: '', label: 'None' });
	});

	it('metaEntries gives each key and value with the base64url key the meta-keys routes take', async () => {
		const id = await createTask('t');
		await call('POST /tasks/:id/meta', id, { key: 'ci/build', value: 'x' });
		expect((await detail(id)).body['metaEntries']).toEqual([
			{ key: 'ci/build', value: 'x', keyId: Buffer.from('ci/build').toString('base64url') },
		]);
	});

	it('deleteImpact counts the children, all descendants, the links and what the task blocks', async () => {
		const root = await createTask('root');
		const child = await createTask('child', { parent: root });
		await createTask('grandchild', { parent: child });
		await createTask('child 2', { parent: root });
		const victim = await createTask('victim');
		const other = await createTask('other');
		await call('POST /tasks/:id/links', other, { type: 'blockedBy', target: victim });
		expect((await detail(root)).body['deleteImpact']).toEqual({
			childCount: 2,
			descendantCount: 3,
			linkCount: 0,
			blocksCount: 0,
		});
		expect((await detail(victim)).body['deleteImpact']).toEqual({
			childCount: 0,
			descendantCount: 0,
			linkCount: 1,
			blocksCount: 1,
		});
	});

	it('pills gives one entry per property with label, text and tone; "none" for an empty one, a danger pill when blocked', async () => {
		const parent = await createTask('Q4 hardening');
		const blocker = await createTask('blocker');
		const id = await createTask('the task', { parent });
		await call('POST /tasks/:id/labels', id, { label: 'billing' });
		await call('POST /tasks/:id/links', id, { type: 'blockedBy', target: blocker });
		expect((await detail(id)).body['pills']).toEqual([
			{ key: 'status', label: 'Status', text: 'backlog', tone: 'neutral', empty: false },
			{ key: 'type', label: 'Type', text: 'none', tone: 'neutral', empty: true },
			{ key: 'labels', label: 'Labels', text: 'billing', tone: 'neutral', empty: false },
			{ key: 'parent', label: 'Parent', text: `${parent} Q4 hardening`, tone: 'neutral', empty: false },
			{ key: 'blocked', label: 'Blocked by', text: '1 open', tone: 'danger', empty: false },
		]);
	});

	it('pills of a plain root task have no blocked pill; the status tone follows the config', async () => {
		const id = await createTask('plain');
		await call('POST /tasks/:id/status', id, { status: 'done' });
		const pills = (await detail(id)).body['pills'] as Array<{ key: string; text: string; tone: string }>;
		expect(pills.map(pill => pill.key)).toEqual(['status', 'type', 'labels', 'parent']);
		expect(pills[0]).toMatchObject({ text: 'done', tone: 'success' });
		expect(pills[3]).toMatchObject({ text: 'none' });
	});

	it('a dangling parent: the parent pill is empty, the page data is still there', async () => {
		const parent = await createTask('p');
		const child = await createTask('c', { parent });
		const indexPath = path.join(h.world.dataDirOf(project), 'task-index.json');
		const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as { tasks: Array<{ id: string }> };
		index.tasks = index.tasks.filter(x => x.id !== parent);
		fs.writeFileSync(indexPath, JSON.stringify(index));
		const { status, body } = await detail(child);
		expect(status).toBe(200);
		expect(body['pills'].find((pill: { key: string }) => pill.key === 'parent')).toMatchObject({ empty: true });
	});

	it('the parent pill and the ancestor rows use the headline of a legacy long title', async () => {
		const parent = await createTask('seed');
		legacyTitle(parent, `Flow prompt ${'blah '.repeat(150)}`);
		const child = await createTask('c', { parent });
		const { body } = await detail(child);
		expect(body['parentRow']['titleText'].length).toBeLessThanOrEqual(90);
		const pill = body['pills'].find((entry: { key: string }) => entry.key === 'parent');
		expect(pill.text.length).toBeLessThanOrEqual(`${parent} `.length + 90);
	});

	it('404 for an unknown project; with inlineErrors a 200 with failed; nothing emitted', async () => {
		const id = await createTask('t');
		expect((await h.call('GET /tasks/:id', { params: { id }, query: { project: 'nope' } })).status).toBe(404);
		const inline = await h.call('GET /tasks/:id', {
			params: { id },
			query: { project: 'nope', inlineErrors: 'true' },
		});
		expect(inline.status).toBe(200);
		expect(inline.body).toMatchObject({ failed: true, httpStatus: 404 });
		expect(h.sink.events).toEqual([]);
	});
});

describe('GET /tasks/search', () => {
	const search = (query: Record<string, unknown> = {}) =>
		h.call('GET /tasks/search', { query: { project, ...query } });
	const ids = (answer: { body: unknown }) => (answer.body as unknown as Array<{ id: string }>).map(hit => hit.id);

	it('answers [{id, headline, status, statusText, tone, href}] ranked: id prefix, then title word, then substring', async () => {
		const substring = await createTask('xxlogin');
		const word = await createTask('Fix login redirect');
		const answer = await search({ q: 'login' });
		expect(answer.status).toBe(200);
		expect(ids(answer)).toEqual([word, substring]);
		expect((answer.body as unknown as unknown[])[0]).toEqual({
			id: word,
			headline: 'Fix login redirect',
			status: 'backlog',
			statusText: 'backlog',
			tone: 'neutral',
			href: `/modules/task/tasks/p/${project}/${word}`,
		});
		expect(ids(await search({ q: word.slice(0, 4) }))[0]).toBe(word);
	});

	it('tone follows the config: a terminal status is success, another one info', async () => {
		const done = await createTask('done one');
		const moving = await createTask('moving one');
		await h.call('POST /tasks/:id/status', { params: { id: done }, query: { project }, body: { status: 'done' } });
		await h.call('POST /tasks/:id/status', {
			params: { id: moving },
			query: { project },
			body: { status: 'in-progress' },
		});
		const hits = (await search({ q: 'one' })).body as unknown as Array<{ id: string; tone: string }>;
		expect(hits.find(hit => hit.id === done)?.tone).toBe('success');
		expect(hits.find(hit => hit.id === moving)?.tone).toBe('info');
	});

	it('limit defaults to 8, is honoured, and is capped at 20 with a loud 400 beyond (never silently clamped)', async () => {
		for (let index = 0; index < 22; index++) await createTask(`item ${index}`);
		expect((await search({ q: 'item' })).body).toHaveLength(8);
		expect((await search({ q: 'item', limit: '3' })).body).toHaveLength(3);
		expect((await search({ q: 'item', limit: '20' })).body).toHaveLength(20);
		const beyond = await search({ q: 'item', limit: '21' });
		expect(beyond.status).toBe(400);
		expect(beyond.body['error']).toContain('limit');
		expect(beyond.body['hint']).toContain('20');
		for (const limit of ['0', '-1', 'abc', '2.5']) {
			expect((await search({ q: 'item', limit })).status, limit).toBe(400);
		}
		// A cleared field sends an empty value: "not given".
		expect((await search({ q: 'item', limit: '' })).body).toHaveLength(8);
	});

	it('exclude drops the listed ids; a blank entry or an unknown id is harmless', async () => {
		const a = await createTask('same a');
		const b = await createTask('same b');
		expect(ids(await search({ q: 'same', exclude: `${a},,zzzzzzzz` }))).toEqual([b]);
	});

	it('excludeDescendantsOf leaves out the task itself and every descendant, not its parent nor siblings', async () => {
		const top = await createTask('node top');
		const mid = await createTask('node mid', { parent: top });
		await createTask('node leaf', { parent: mid });
		const sibling = await createTask('node sibling', { parent: top });
		expect(ids(await search({ q: 'node', excludeDescendantsOf: mid.slice(0, 8) })).sort()).toEqual(
			[top, sibling].sort()
		);
		expect(ids(await search({ q: 'node', excludeDescendantsOf: top }))).toEqual([]);
	});

	it('excludeDescendantsOf with an unknown task is a 404', async () => {
		await createTask('a');
		expect((await search({ q: '', excludeDescendantsOf: 'zzzzzzzz' })).status).toBe(404);
	});

	it('uses the headline for a legacy long title: no hit is longer than 90 characters', async () => {
		legacyTitle(await createTask('seed'), `Prompt ${'word '.repeat(200)}`);
		const hits = (await search({ q: 'prompt' })).body as unknown as Array<{ headline: string }>;
		expect(hits).toHaveLength(1);
		expect(hits[0]!.headline.length).toBeLessThanOrEqual(90);
	});

	it('an empty or missing q lists tasks (the limit applies); no event is emitted', async () => {
		await createTask('a');
		expect((await search()).body).toHaveLength(1);
		expect((await search({ q: '' })).body).toHaveLength(1);
		expect(h.sink.events).toEqual([]);
	});

	it('q given twice is a 400', async () => {
		expect((await search({ q: ['a', 'b'] })).status).toBe(400);
	});

	it('is per project: a task of another project is not found', async () => {
		const beta = await h.world.createProject('beta');
		await h.call('POST /tasks', { query: { project: beta }, body: { description: 'only in beta' } });
		expect((await search({ q: 'only' })).body).toEqual([]);
	});

	it('unknown project 404, virtual project 409, unreadable project 4xx; inlineErrors turns each into a 200 with failed', async () => {
		const virtual = (await h.world.registerShared('virt')).id;
		const broken = await h.world.createProject('broken');
		h.world.breakConfig(broken);
		const unreadable = await h.call('GET /tasks', { query: { project: broken } });
		expect(unreadable.status).toBeGreaterThanOrEqual(400);
		for (const [ref, expected] of [
			['nope', 404],
			[virtual, 409],
			[broken, unreadable.status],
		] as const) {
			const plain = await h.call('GET /tasks/search', { query: { project: ref, q: 'x' } });
			expect(plain.status, ref).toBe(expected);
			const inline = await h.call('GET /tasks/search', { query: { project: ref, q: 'x', inlineErrors: 'true' } });
			expect(inline.status, ref).toBe(200);
			expect(inline.body, ref).toMatchObject({ failed: true, httpStatus: expected });
			expect(inline.body['errorText'], ref).toBeTruthy();
		}
	});
});

describe('GET /labels', () => {
	it('lists [{label, count}], most used first then by name', async () => {
		const a = await createTask('a');
		const b = await createTask('b');
		for (const [id, label] of [
			[a, 'zeta'],
			[b, 'zeta'],
			[a, 'alpha'],
			[b, 'beta'],
		] as const) {
			await h.call('POST /tasks/:id/labels', { params: { id }, query: { project }, body: { label } });
		}
		h.sink.events.length = 0;
		const answer = await h.call('GET /labels', { query: { project } });
		expect(answer.status).toBe(200);
		expect(answer.body).toEqual([
			{ label: 'zeta', count: 2 },
			{ label: 'alpha', count: 1 },
			{ label: 'beta', count: 1 },
		]);
		expect(h.sink.events).toEqual([]);
	});

	it('is an empty list for a project without labels', async () => {
		await createTask('a');
		expect((await h.call('GET /labels', { query: { project } })).body).toEqual([]);
	});

	it('unknown project 404, virtual 409; inlineErrors answers 200 failed', async () => {
		const virtual = (await h.world.registerShared('virt')).id;
		expect((await h.call('GET /labels', { query: { project: 'nope' } })).status).toBe(404);
		expect((await h.call('GET /labels', { query: { project: virtual } })).status).toBe(409);
		const inline = await h.call('GET /labels', { query: { project: virtual, inlineErrors: 'true' } });
		expect(inline.status).toBe(200);
		expect(inline.body).toMatchObject({ failed: true, httpStatus: 409 });
	});
});

describe('GET /meta-keys', () => {
	const metaOf = (id: string, key: string, value: string) =>
		h.call('POST /tasks/:id/meta', { params: { id }, query: { project }, body: { key, value } });

	it('lists every metadata key in use in the project, sorted, once', async () => {
		const a = await createTask('a');
		const b = await createTask('b');
		await metaOf(a, 'sprint', '1');
		await metaOf(b, 'sprint', '2');
		await metaOf(b, 'estimate', '3');
		h.sink.events.length = 0;
		const answer = await h.call('GET /meta-keys', { query: { project } });
		expect(answer.status).toBe(200);
		expect(answer.body).toEqual(['estimate', 'sprint']);
		expect(h.sink.events).toEqual([]);
	});

	it('is an empty list for a project without metadata', async () => {
		await createTask('a');
		expect((await h.call('GET /meta-keys', { query: { project } })).body).toEqual([]);
	});

	it('unknown project 404, virtual 409; inlineErrors answers 200 failed', async () => {
		const virtual = (await h.world.registerShared('virt')).id;
		expect((await h.call('GET /meta-keys', { query: { project: 'nope' } })).status).toBe(404);
		expect((await h.call('GET /meta-keys', { query: { project: virtual } })).status).toBe(409);
		const inline = await h.call('GET /meta-keys', { query: { project: virtual, inlineErrors: 'true' } });
		expect(inline.status).toBe(200);
		expect(inline.body).toMatchObject({ failed: true, httpStatus: 409 });
	});
});

describe('POST /tasks with a title and a description', () => {
	const create = (body: unknown) => h.call('POST /tasks', { query: { project }, body });

	it('stores both as given, never reshaped, and the event carries the full text', async () => {
		const answer = await create({ title: 'Fix login', description: 'Steps:\n1. open the page' });
		expect(answer.status).toBe(201);
		expect(answer.body['task']).toMatchObject({ title: 'Fix login', description: 'Steps:\n1. open the page' });
		expect(h.sink.events[0]).toMatchObject({
			name: 'onTaskCreated',
			payload: { description: 'Steps:\n1. open the page' },
		});
	});

	it('a title alone is the single text of the task', async () => {
		const answer = await create({ title: 'Just a title' });
		expect(answer.status).toBe(201);
		expect(answer.body['task']).toMatchObject({ title: 'Just a title' });
		expect(answer.body['task']).not.toHaveProperty('description');
	});

	it('a long description alone is split into a headline title and the full description', async () => {
		const long = `Implement the importer. ${'detail '.repeat(60)}`;
		const answer = await create({ description: long });
		expect(answer.body['task']['title']).toBe('Implement the importer.');
		expect(answer.body['task']['description']).toBe(long);
		expect(answer.body['message']).toContain('Implement the importer.');
	});

	it('a title with an empty description is just the title (a form leaves the description empty)', async () => {
		const answer = await create({ title: 'T', description: '' });
		expect(answer.status).toBe(201);
		expect(answer.body['task']).not.toHaveProperty('description');
	});

	it('400 for neither text, a blank text or a non-string title; nothing created or delivered', async () => {
		for (const body of [{}, { title: '' }, { title: '   ' }, { title: '  ', description: ' ' }, { title: 3 }]) {
			expect((await create(body)).status, JSON.stringify(body)).toBe(400);
		}
		expect(h.sink.events).toEqual([]);
		expect((await h.call('GET /tasks', { query: { project } })).body['tasks']).toEqual([]);
	});

	it('creates under a parent with a title and a description', async () => {
		const parent = await createTask('parent');
		const answer = await create({ title: 'child', description: 'body', parent: parent.slice(0, 8) });
		expect(answer.body['task']['parentId']).toBe(parent);
	});
});

describe('PATCH /tasks/:id', () => {
	const patch = (id: string, body: unknown, query: Record<string, unknown> = {}) =>
		h.call('PATCH /tasks/:id', { params: { id }, query: { project, ...query }, body });

	it('changes the title, rewrites the list row and emits onTaskTextChanged', async () => {
		const id = await createTask('old title');
		const answer = await patch(id.slice(0, 8), { title: 'new title' });
		expect(answer.status).toBe(200);
		expect(answer.body['task']).toMatchObject({ id, title: 'new title' });
		expect(answer.body['undelivered']).toEqual([]);
		expect(answer.body['undeliveredText']).toBeNull();
		expect(h.sink.events).toMatchObject([
			{
				name: 'onTaskTextChanged',
				payload: {
					taskId: id,
					field: 'title',
					oldValue: 'old title',
					newValue: 'new title',
					taskProjectId: project,
				},
			},
		]);
		const list = await h.call('GET /tasks', { query: { project } });
		expect(list.body['tasks'][0]['title']).toBe('new title');
	});

	it('changes the description (no oldValue for the first one), then clears it with an empty string', async () => {
		const id = await createTask('t');
		await patch(id, { description: 'the body' });
		expect(h.sink.events[0]).toMatchObject({
			name: 'onTaskTextChanged',
			payload: { field: 'description', newValue: 'the body' },
		});
		expect((h.sink.events[0]!.payload as { oldValue?: string }).oldValue).toBeUndefined();
		await patch(id, { description: '' });
		expect(h.sink.events[1]).toMatchObject({
			payload: { field: 'description', oldValue: 'the body', newValue: '' },
		});
		const detail = await h.call('GET /tasks/:id', { params: { id }, query: { project } });
		expect(detail.body['bodyAddsInfo']).toBe(false);
	});

	it('title and description together emit two events, title first', async () => {
		const id = await createTask('t');
		await patch(id, { title: 'u', description: 'd' });
		expect(h.sink.events.map(event => (event.payload as { field: string }).field)).toEqual([
			'title',
			'description',
		]);
	});

	it('the same values emit nothing (200)', async () => {
		const id = await createTask('same');
		const answer = await patch(id, { title: 'same' });
		expect(answer.status).toBe(200);
		expect(h.sink.events).toEqual([]);
	});

	it('400 for no field, a blank title, a non-string field or a non-object body; nothing changed or delivered', async () => {
		const id = await createTask('keep');
		for (const body of [{}, { title: '   ' }, { title: 3 }, { description: 3 }, 'text', undefined]) {
			const answer = await patch(id, body);
			expect(answer.status, JSON.stringify(body)).toBe(400);
			expect(answer.body['error'], JSON.stringify(body)).toBeTruthy();
		}
		expect(h.sink.events).toEqual([]);
		const after = await h.call('GET /tasks/:id', { params: { id }, query: { project } });
		expect(after.body['task']['title']).toBe('keep');
	});

	it('404 for an unknown task; inlineErrors turns a failure into a 200 with failed and errorText', async () => {
		expect((await patch('zzzzzzzz', { title: 'x' })).status).toBe(404);
		const inline = await patch('zzzzzzzz', { title: 'x' }, { inlineErrors: 'true' });
		expect(inline.status).toBe(200);
		expect(inline.body).toMatchObject({ failed: true, httpStatus: 404 });
		expect(inline.body['errorText']).toBeTruthy();
	});

	it('lists the undelivered event when the sink reports it', async () => {
		const { failing, dir } = await unreachableWorld();
		try {
			const created = await failing.call('POST /tasks', { query: { project: dir }, body: { description: 'a' } });
			const answer = await failing.call('PATCH /tasks/:id', {
				params: { id: created.body['task'].id },
				query: { project: dir },
				body: { title: 'b' },
			});
			expect(answer.status).toBe(200);
			expect(answer.body['undelivered']).toMatchObject([{ event: 'onTaskTextChanged', reason: 'exit 3' }]);
			expect(answer.body['undeliveredText']).toContain('onTaskTextChanged');
		} finally {
			failing.world.cleanup();
		}
	});
});

describe('metadata and type removal', () => {
	const setMetaOf = (id: string, key: string, value: string) =>
		h.call('POST /tasks/:id/meta', { params: { id }, query: { project }, body: { key, value } });
	const metaOf = async (id: string) =>
		(await h.call('GET /tasks/:id', { params: { id }, query: { project } })).body['task']['meta'];

	it('PUT /tasks/:id/meta/:key sets the value from the body and emits onTaskMetaChanged', async () => {
		const id = await createTask('t');
		const answer = await h.call('PUT /tasks/:id/meta/:key', {
			params: { id, key: 'sprint' },
			query: { project },
			body: { value: '12' },
		});
		expect(answer.status).toBe(200);
		expect(answer.body['task']['meta']).toEqual({ sprint: '12' });
		expect(answer.body['undelivered']).toEqual([]);
		expect(h.sink.events).toMatchObject([
			{ name: 'onTaskMetaChanged', payload: { taskId: id, key: 'sprint', newValue: '12' } },
		]);
	});

	it('PUT takes the value from the query when there is no body (the shell sends none); an empty value is valid', async () => {
		const id = await createTask('t');
		await h.call('PUT /tasks/:id/meta/:key', { params: { id, key: 'a' }, query: { project, value: 'from query' } });
		await h.call('PUT /tasks/:id/meta/:key', { params: { id, key: 'b' }, query: { project, value: '' } });
		expect(await metaOf(id)).toEqual({ a: 'from query', b: '' });
	});

	it('PUT without a value anywhere is a 400 saying how to give it, and changes nothing', async () => {
		const id = await createTask('t');
		const answer = await h.call('PUT /tasks/:id/meta/:key', { params: { id, key: 'a' }, query: { project } });
		expect(answer.status).toBe(400);
		expect(answer.body['hint']).toContain('value');
		expect(h.sink.events).toEqual([]);
	});

	it('PUT with the same value emits nothing; a blank key is a 400', async () => {
		const id = await createTask('t');
		await setMetaOf(id, 'k', 'v');
		h.sink.events.length = 0;
		await h.call('PUT /tasks/:id/meta/:key', {
			params: { id, key: 'k' },
			query: { project },
			body: { value: 'v' },
		});
		expect(h.sink.events).toEqual([]);
		const blank = await h.call('PUT /tasks/:id/meta/:key', {
			params: { id, key: '  ' },
			query: { project },
			body: { value: 'v' },
		});
		expect(blank.status).toBe(400);
	});

	it('PUT with a non-string body value is a 400', async () => {
		const id = await createTask('t');
		const answer = await h.call('PUT /tasks/:id/meta/:key', {
			params: { id, key: 'a' },
			query: { project },
			body: { value: 3 },
		});
		expect(answer.status).toBe(400);
	});

	it('DELETE /tasks/:id/meta/:key removes the key and emits onTaskMetaChanged without newValue', async () => {
		const id = await createTask('t');
		await setMetaOf(id, 'sprint', '1');
		h.sink.events.length = 0;
		const answer = await h.call('DELETE /tasks/:id/meta/:key', {
			params: { id, key: 'sprint' },
			query: { project },
		});
		expect(answer.status).toBe(200);
		expect(await metaOf(id)).toBeUndefined();
		expect(h.sink.events).toHaveLength(1);
		expect(h.sink.events[0]).toMatchObject({
			name: 'onTaskMetaChanged',
			payload: { key: 'sprint', oldValue: '1' },
		});
		expect((h.sink.events[0]!.payload as { newValue?: string }).newValue).toBeUndefined();
	});

	it('DELETE of an absent key is a 200 that emits nothing', async () => {
		const id = await createTask('t');
		const answer = await h.call('DELETE /tasks/:id/meta/:key', {
			params: { id, key: 'ghost' },
			query: { project },
		});
		expect(answer.status).toBe(200);
		expect(answer.body['undelivered']).toEqual([]);
		expect(h.sink.events).toEqual([]);
	});

	it('the meta-keys routes take the key as base64url, so a key with "/" or "%" can be set and removed', async () => {
		const id = await createTask('t');
		const key = 'ci/build%1';
		const encoded = Buffer.from(key, 'utf8').toString('base64url');
		const put = await h.call('PUT /tasks/:id/meta-keys/:key', {
			params: { id, key: encoded },
			query: { project },
			body: { value: 'ok' },
		});
		expect(put.status).toBe(200);
		expect(await metaOf(id)).toEqual({ [key]: 'ok' });
		const removed = await h.call('DELETE /tasks/:id/meta-keys/:key', {
			params: { id, key: encoded },
			query: { project },
		});
		expect(removed.status).toBe(200);
		expect(await metaOf(id)).toBeUndefined();
	});

	it('an invalid meta key (not base64url) is a 400 with the expected format', async () => {
		const id = await createTask('t');
		for (const route of ['DELETE /tasks/:id/meta-keys/:key', 'PUT /tasks/:id/meta-keys/:key']) {
			const answer = await h.call(route, {
				params: { id, key: 'a b' },
				query: { project },
				body: { value: 'v' },
			});
			expect(answer.status, route).toBe(400);
			expect(answer.body['hint'], route).toContain('base64url');
		}
	});

	it('DELETE /tasks/:id/type clears the type and emits onTaskTypeChanged without newType', async () => {
		const id = await createTask('t');
		await h.call('POST /tasks/:id/type', { params: { id }, query: { project }, body: { type: 'bug' } });
		h.sink.events.length = 0;
		const answer = await h.call('DELETE /tasks/:id/type', { params: { id }, query: { project } });
		expect(answer.status).toBe(200);
		expect(answer.body['task']).not.toHaveProperty('type');
		expect(answer.body['undelivered']).toEqual([]);
		expect(h.sink.events).toHaveLength(1);
		expect(h.sink.events[0]).toMatchObject({ name: 'onTaskTypeChanged', payload: { taskId: id, oldType: 'bug' } });
		expect((h.sink.events[0]!.payload as { newType?: string }).newType).toBeUndefined();
	});

	it('DELETE /tasks/:id/type on a task without type emits nothing; an unknown task is a 404; inlineErrors gives a 200 failed', async () => {
		const id = await createTask('t');
		expect((await h.call('DELETE /tasks/:id/type', { params: { id }, query: { project } })).status).toBe(200);
		expect(h.sink.events).toEqual([]);
		const missing = await h.call('DELETE /tasks/:id/type', { params: { id: 'zzzzzzzz' }, query: { project } });
		expect(missing.status).toBe(404);
		const inline = await h.call('DELETE /tasks/:id/type', {
			params: { id: 'zzzzzzzz' },
			query: { project, inlineErrors: 'true' },
		});
		expect(inline.body).toMatchObject({ failed: true, httpStatus: 404 });
	});

	it('removals list the undelivered event when the sink reports it', async () => {
		const { failing, dir } = await unreachableWorld();
		try {
			const created = await failing.call('POST /tasks', { query: { project: dir }, body: { description: 'a' } });
			const id = created.body['task'].id as string;
			await failing.call('POST /tasks/:id/meta', {
				params: { id },
				query: { project: dir },
				body: { key: 'k', value: 'v' },
			});
			const answer = await failing.call('DELETE /tasks/:id/meta/:key', {
				params: { id, key: 'k' },
				query: { project: dir },
			});
			expect(answer.body['undelivered']).toMatchObject([{ event: 'onTaskMetaChanged', reason: 'exit 3' }]);
			expect(answer.body['undeliveredText']).toContain('onTaskMetaChanged');
		} finally {
			failing.world.cleanup();
		}
	});
});
