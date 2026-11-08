// Status outcome (positive / negative terminal) and the sub-task entries of the parent, seen through the module routes.
import { setup } from './routeHarness.js';
import type { Harness } from './routeHarness.js';

const OUTCOME_YML = [
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

let h: Harness;
let project: string;

beforeEach(async () => {
	h = setup();
	project = await h.world.createProject('alpha', { configYml: OUTCOME_YML });
});
afterEach(() => h.world.cleanup());

async function createTask(description: string, extra: Record<string, unknown> = {}): Promise<string> {
	const answer = await h.call('POST /tasks', { query: { project }, body: { description, ...extra } });
	expect(answer.status).toBe(201);
	return answer.body['task'].id as string;
}

const setStatus = (id: string, status: string) =>
	h.call('POST /tasks/:id/status', { params: { id }, query: { project }, body: { status } });
const detail = (id: string) => h.call('GET /tasks/:id', { params: { id }, query: { project } });

describe('a negative terminal status in the views', () => {
	it('statusOptions and statusChoices carry the outcome (terminal statuses only) and the danger tone', async () => {
		const { body } = await detail(await createTask('t'));

		expect(body['statusOptions']).toEqual([
			{ value: 'backlog', label: 'backlog', tone: 'neutral', terminal: false },
			{ value: 'in-progress', label: 'in-progress', tone: 'info', terminal: false },
			{ value: 'done', label: 'done', tone: 'success', terminal: true, outcome: 'positive' },
			{ value: 'rejected', label: 'rejected', tone: 'danger', terminal: true, outcome: 'negative' },
		]);
		expect(body['statusChoices'].map((c: { tone: string }) => c.tone)).toEqual([
			'neutral',
			'info',
			'success',
			'danger',
		]);
	});

	it('the task header, the children, the links and the activity read a rejected task in the danger tone', async () => {
		const parent = await createTask('parent');
		const child = await createTask('child', { parent });
		const blocker = await createTask('blocker');
		await h.call('POST /tasks/:id/links', {
			params: { id: parent },
			query: { project },
			body: { type: 'blockedBy', target: blocker },
		});
		await setStatus(child, 'rejected');
		await setStatus(blocker, 'rejected');
		await setStatus(parent, 'rejected');

		const { body } = await detail(parent);
		expect(body['statusTone']).toBe('danger');
		expect(body['pills'][0]).toMatchObject({ key: 'status', tone: 'danger' });
		expect(body['isTerminal']).toBe(true);
		expect(body['children'][0]).toMatchObject({ id: child, tone: 'danger', statusTone: 'danger', isDone: true });
		expect(body['checklistRows'][0]).toMatchObject({ id: child, tone: 'danger' });
		const links = await h.call('GET /tasks/:id/links', { params: { id: parent }, query: { project } });
		expect(links.body['groups'][0]['rows'][0]).toMatchObject({ id: blocker, tone: 'danger' });
		const activity = await h.call('GET /tasks/:id/activity', { params: { id: parent }, query: { project } });
		expect(activity.body['rows'][0]).toMatchObject({ kind: 'status', tone: 'danger' });
		const entries = body['activity'] as Array<{ kind: string; tone: string }>;
		expect(entries[entries.length - 1]).toMatchObject({ kind: 'done', tone: 'danger' });
	});

	it('the global tree reads a rejected task in the danger tone', async () => {
		await h.world.createProject('beta', { configYml: OUTCOME_YML });
		const root = await createTask('root');
		await setStatus(root, 'rejected');
		const answer = await h.call('GET /tree', { query: { allProjects: 'true', showAll: 'true' } });

		const alpha = (answer.body['projects'] as Array<Record<string, any>>).find(p => p['name'] === 'alpha')!;
		expect(alpha['rows'][0]).toMatchObject({ id: root, tone: 'danger' });
	});

	it('a rejected blocker no longer blocks (terminal means "no longer blocking")', async () => {
		const task = await createTask('task');
		const blocker = await createTask('blocker');
		await h.call('POST /tasks/:id/links', {
			params: { id: task },
			query: { project },
			body: { type: 'blockedBy', target: blocker },
		});
		h.sink.events.length = 0;
		await setStatus(blocker, 'rejected');

		expect(h.sink.events.map(e => e.name)).toEqual(['onStatusChange', 'onTaskUnblocked']);
	});

	it('no display text of the module says "terminal" (the showAll hint included)', async () => {
		const answer = await h.call('GET /tasks', { query: { project, showAll: 'maybe' } });

		expect(answer.status).toBe(400);
		expect(JSON.stringify(answer.body).toLowerCase()).not.toContain('terminal');
	});
});

describe('parent changes in the history of both tasks', () => {
	const texts = async (id: string): Promise<string[]> => {
		const activity = await h.call('GET /tasks/:id/activity', { params: { id }, query: { project } });
		return (activity.body['rows'] as Array<{ text: string }>).map(row => row.text);
	};

	it('moving a child from A to B tells A it lost a sub-task and B it gained one', async () => {
		const a = await createTask('parent a');
		const b = await createTask('parent b');
		const child = await createTask('the child');
		await h.call('POST /tasks/:id/parent', { params: { id: child }, query: { project }, body: { parent: a } });
		await h.call('POST /tasks/:id/parent', { params: { id: child }, query: { project }, body: { parent: b } });

		expect((await texts(a)).slice(0, 2)).toEqual([
			`Sub-task ${child} the child detached`,
			`Sub-task ${child} the child added`,
		]);
		expect((await texts(b))[0]).toBe(`Sub-task ${child} the child added`);
		expect((await texts(child))[0]).toBe(`Parent changed from ${a} parent a to ${b} parent b`);
	});

	it('DELETE /tasks/:id/parent is addressed by the CHILD: same code and event, answers the child and the delivery text', async () => {
		const parent = await createTask('the parent');
		const child = await createTask('the child', { parent });
		h.sink.events.length = 0;
		const answer = await h.call('DELETE /tasks/:id/parent', { params: { id: child }, query: { project } });

		expect(answer.status).toBe(200);
		expect(answer.body['task']['id']).toBe(child);
		expect(answer.body['undelivered']).toEqual([]);
		expect(answer.body).toHaveProperty('undeliveredText');
		expect(h.sink.events.map(e => e.name)).toEqual(['onTaskParentChanged']);
		expect((await texts(parent))[0]).toBe(`Sub-task ${child} the child detached`);
	});
});
