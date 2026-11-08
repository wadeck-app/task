// The activity of a task: GET /tasks/:id/activity, the merged feed of the detail answer, the PATCH answer.
import { setup, STATUSES_YML } from './routeHarness.js';
import type { Harness } from './routeHarness.js';

let h: Harness;
let project: string;

beforeEach(async () => {
	h = setup();
	project = await h.world.createProject('alpha', { configYml: STATUSES_YML });
});
afterEach(() => h.world.cleanup());

async function createTask(description: string): Promise<string> {
	const answer = await h.call('POST /tasks', { query: { project }, body: { description } });
	expect(answer.status).toBe(201);
	return answer.body['task'].id as string;
}

const call = (route: string, id: string, body?: unknown, extra: Record<string, unknown> = {}) =>
	h.call(route, { params: { id }, query: { project, ...extra }, body });
const activity = (id: string, extra: Record<string, unknown> = {}) =>
	call('GET /tasks/:id/activity', id, undefined, extra);

describe('GET /tasks/:id/activity', () => {
	it('answers the merged rows newest first, with the filters, the counts and a day group and time per row', async () => {
		const id = await createTask('Fix login');
		await call('POST /tasks/:id/status', id, { status: 'in-progress' });
		await call('POST /tasks/:id/type', id, { type: 'bug' });
		await call('POST /tasks/:id/labels', id, { label: 'billing' });

		const { status, body } = await activity(id);

		expect(status).toBe(200);
		expect(body['id']).toBe(id);
		expect(body['filters']).toEqual(['all', 'comments', 'history']);
		expect(body['filter']).toBe('all');
		expect(body['counts']).toEqual({ all: 4, comments: 0, history: 2 });
		expect(body['rows'].map((row: { text: string }) => row.text)).toEqual([
			'Label billing added',
			'Type set to bug',
			'Status changed from backlog to in-progress',
			'Created with status backlog',
		]);
		for (const row of body['rows']) {
			expect(row.group).toMatch(/^\d{4}-\d\d-\d\d$/);
			expect(row.time).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
			expect(row).toMatchObject({ kind: expect.any(String), icon: expect.any(String), tone: expect.any(String) });
		}
	});

	it('?filter=history keeps the status rows only; the counts stay those of the whole feed', async () => {
		const id = await createTask('Fix login');
		await call('POST /tasks/:id/type', id, { type: 'bug' });

		const { body } = await activity(id, { filter: 'history' });

		expect(body['filter']).toBe('history');
		expect(body['rows'].map((row: { kind: string }) => row.kind)).toEqual(['created']);
		expect(body['counts']).toEqual({ all: 2, comments: 0, history: 1 });
	});

	it('400 for another filter, naming the valid ones', async () => {
		const id = await createTask('Fix login');

		const { status, body } = await activity(id, { filter: 'mine' });

		expect(status).toBe(400);
		expect(body['error']).toContain('filter');
		expect(body['hint']).toContain('all');
		expect(body['hint']).toContain('history');
	});

	it('reads a task prefix and returns the full id', async () => {
		const id = await createTask('Fix login');

		expect((await activity(id.slice(0, 4))).body['id']).toBe(id);
	});

	it('shows both sides of a link, the other task by id and headline', async () => {
		const a = await createTask('First task');
		const b = await createTask('Second task');
		await call('POST /tasks/:id/links', a, { type: 'blockedBy', target: b });

		expect((await activity(a)).body['rows'][0]).toMatchObject({ text: `Linked: blocked by ${b} Second task` });
		expect((await activity(b)).body['rows'][0]).toMatchObject({
			text: `Linked: blocks ${a} First task`,
			inverse: true,
		});
	});

	it('emits no event (a read)', async () => {
		const id = await createTask('Fix login');
		h.sink.events.length = 0;

		await activity(id);

		expect(h.sink.events).toEqual([]);
	});

	it('404 for an unknown task and for an unknown project', async () => {
		expect((await activity('nosuchtask')).status).toBe(404);
		const unknownProject = await h.call('GET /tasks/:id/activity', {
			params: { id: 'x' },
			query: { project: 'nope' },
		});
		expect(unknownProject.status).toBe(404);
	});

	it('inlineErrors turns a failure into a 200 with failed and errorText', async () => {
		const answer = await activity('nosuchtask', { inlineErrors: 'true' });

		expect(answer.status).toBe(200);
		expect(answer.body).toMatchObject({ failed: true, httpStatus: 404 });
		expect(answer.body['errorText']).toContain('nosuchtask');
	});

	it('blank answers an empty body without opening a project', async () => {
		const answer = await h.call('GET /tasks/:id/activity', {
			params: { id: 'nosuchtask' },
			query: { blank: 'true', inlineErrors: 'true' },
		});

		expect(answer).toEqual({ status: 200, body: { blank: true } });
	});

	it('a virtual project is answered like the other task routes (409 pointing to task -p)', async () => {
		const virtual = await h.world.registerShared('virt');
		const answer = await h.call('GET /tasks/:id/activity', {
			params: { id: 'x' },
			query: { project: virtual.id },
		});
		const plain = await h.call('GET /tasks/:id/history', { params: { id: 'x' }, query: { project: virtual.id } });

		expect(answer.status).toBe(plain.status);
		expect(answer.body['error']).toBe(plain.body['error']);
	});
});

describe('GET /tasks/:id carries the merged activity', () => {
	it('activityCount counts every row and the Timeline feed shows the changes besides the status', async () => {
		const id = await createTask('Fix login');
		await call('POST /tasks/:id/type', id, { type: 'bug' });
		await call('PATCH /tasks/:id', id, { title: 'Fix the login' });

		const { body } = await call('GET /tasks/:id', id);

		expect(body['activityCount']).toBe(3);
		expect(body['hasActivity']).toBe(true);
		// Oldest first, in the shape of the Timeline component.
		expect(body['activity'].map((entry: { title: string }) => entry.title)).toEqual([
			'Created',
			'Type set to bug',
			'Title edited',
		]);
		expect(body['activity'][0]).toMatchObject({ kind: 'created', id: 'history-0' });
		expect(body['activity'][1]).toMatchObject({ kind: 'note', activityKind: 'type', icon: 'shapes' });
		expect(body['activity'][1]['atText']).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
	});

	it('keeps the status entries as before: closing status is done, moves carry from and to', async () => {
		const id = await createTask('t');
		await call('POST /tasks/:id/status', id, { status: 'in-progress' });
		await call('POST /tasks/:id/status', id, { status: 'done' });

		const { body } = await call('GET /tasks/:id', id);

		expect(body['activity'].map((entry: { kind: string }) => entry.kind)).toEqual(['created', 'status', 'done']);
		expect(body['activity'][2]).toMatchObject({ from: 'in-progress', to: 'done', tone: 'success' });
	});

	it('a link entry uses the link kind of the Timeline', async () => {
		const a = await createTask('a');
		const b = await createTask('b');
		await call('POST /tasks/:id/links', a, { type: 'blockedBy', target: b });

		const { body } = await call('GET /tasks/:id', a);

		expect(body['activity'][1]).toMatchObject({ kind: 'link', activityKind: 'link-added' });
	});
});

describe('PATCH /tasks/:id answers the new text and the activity count', () => {
	it('headline, body, bodyAddsInfo and activityCount follow the edit', async () => {
		const id = await createTask('Fix login');

		const { status, body } = await call('PATCH /tasks/:id', id, { description: 'Steps: open the page' });

		expect(status).toBe(200);
		expect(body).toMatchObject({
			headline: 'Fix login',
			body: 'Steps: open the page',
			bodyAddsInfo: true,
			activityCount: 2,
		});
		expect(body['task']['description']).toBe('Steps: open the page');
	});

	it('a title edit changes the headline; the body is the new title when there is no description', async () => {
		const id = await createTask('Fix login');

		const { body } = await call('PATCH /tasks/:id', id, { title: 'Fix the login' });

		expect(body).toMatchObject({
			headline: 'Fix the login',
			body: 'Fix the login',
			bodyAddsInfo: false,
			activityCount: 2,
		});
	});

	it('an edit that changes nothing adds no activity', async () => {
		const id = await createTask('Fix login');

		const { body } = await call('PATCH /tasks/:id', id, { title: 'Fix login' });

		expect(body['activityCount']).toBe(1);
	});

	it('clearing the description makes the body the title again', async () => {
		const id = await createTask('Fix login');
		await call('PATCH /tasks/:id', id, { description: 'More' });

		const { body } = await call('PATCH /tasks/:id', id, { description: '' });

		expect(body).toMatchObject({ body: 'Fix login', bodyAddsInfo: false, activityCount: 3 });
	});

	it('still answers undelivered fields and the task', async () => {
		const id = await createTask('Fix login');

		const { body } = await call('PATCH /tasks/:id', id, { title: 'Other' });

		expect(body['task']['title']).toBe('Other');
		expect(body).toHaveProperty('undelivered');
	});
});
