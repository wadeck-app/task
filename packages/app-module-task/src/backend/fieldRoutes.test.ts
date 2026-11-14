import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EventSink } from '@wadeck-app/task-service';

import { setup, STATUSES_YML, type Harness } from './routeHarness.js';

// Priority, assignee and claim: POST /tasks/:id/{priority,assignee,claim,release}, the new facts of GET /tasks/:id and the filters of GET /tasks.
let h: Harness;
let project: string;
let projectDir: string;
let id: string;

async function createTask(description: string): Promise<string> {
	const created = await h.call('POST /tasks', { query: { project }, body: { description } });
	return created.body['task'].id as string;
}

beforeEach(async () => {
	h = setup();
	project = await h.world.createProject('alpha', { configYml: STATUSES_YML });
	projectDir = h.world.dirOf(project);
	id = await createTask('first task');
	h.sink.events.length = 0;
});
afterEach(() => h.world.cleanup());

const env = () => ({ taskProjectId: project, taskProjectName: 'alpha', taskProjectPath: projectDir });
const query = (extra: Record<string, unknown> = {}) => ({ project, ...extra });
const post = (route: string, body: unknown, extra: Record<string, unknown> = {}, taskIdValue = id) =>
	h.call(route, { params: { id: taskIdValue }, query: query(extra), body });
const detail = async () => (await h.call('GET /tasks/:id', { params: { id }, query: query() })).body;

describe('route table', () => {
	it('registers the four routes', () => {
		for (const route of [
			'POST /tasks/:id/priority',
			'POST /tasks/:id/assignee',
			'POST /tasks/:id/claim',
			'POST /tasks/:id/release',
		]) {
			expect(h.routes.has(route), route).toBe(true);
		}
	});
});

describe('POST /tasks/:id/priority', () => {
	it('sets the priority, emits onTaskPriorityChanged and answers like the other mutations (no revision)', async () => {
		const answer = await post('POST /tasks/:id/priority', { priority: 'high' });

		expect(answer.status).toBe(200);
		expect(answer.body['task']).toMatchObject({ id, priority: 'high' });
		expect(answer.body['task']).not.toHaveProperty('revision');
		expect(answer.body['undelivered']).toEqual([]);
		expect(answer.body['undeliveredText']).toBeNull();
		expect(h.sink.events).toEqual([
			{ name: 'onTaskPriorityChanged', payload: { taskId: id, newPriority: 'high', ...env() } },
		]);
	});

	it('an empty priority clears it: the project default applies again, and the event says what was dropped', async () => {
		await post('POST /tasks/:id/priority', { priority: 'urgent' });
		h.sink.events.length = 0;

		const answer = await post('POST /tasks/:id/priority', { priority: '' });

		expect(answer.status).toBe(200);
		expect(answer.body['task']).not.toHaveProperty('priority');
		expect(h.sink.events).toEqual([
			{ name: 'onTaskPriorityChanged', payload: { taskId: id, oldPriority: 'urgent', ...env() } },
		]);
	});

	it('the same priority emits nothing', async () => {
		await post('POST /tasks/:id/priority', { priority: 'low' });
		h.sink.events.length = 0;

		expect((await post('POST /tasks/:id/priority', { priority: 'low' })).status).toBe(200);
		expect(h.sink.events).toEqual([]);
	});

	it('an unknown priority is a 400 that lists the valid ones; inlineErrors makes it data for the view', async () => {
		const plain = await post('POST /tasks/:id/priority', { priority: 'huge' });
		expect(plain.status).toBe(400);
		expect(JSON.stringify(plain.body)).toContain('urgent');

		const inline = await post('POST /tasks/:id/priority', { priority: 'huge' }, { inlineErrors: 'true' });
		expect(inline.status).toBe(200);
		expect(inline.body).toMatchObject({ failed: true, httpStatus: 400 });
		expect(inline.body['errorText']).toContain('huge');
		expect(h.sink.events).toEqual([]);
	});

	it('refuses a body without a priority string, with the usage', async () => {
		const answer = await post('POST /tasks/:id/priority', { prio: 'high' });
		expect(answer.status).toBe(400);
		expect(answer.body['error']).toContain('priority must be a string');
		expect(answer.body['hint']).toContain('"priority"');
	});

	it('reports the events the queue did not get: the priority is saved', async () => {
		const unreachable: EventSink = { deliver: () => Promise.resolve({ delivered: false, reason: 'exit 3' }) };
		const failing = setup(unreachable);
		try {
			const dir = await failing.world.createProject('beta');
			const created = await failing.call('POST /tasks', { query: { project: dir }, body: { description: 'a' } });
			const taskId = created.body['task'].id as string;

			const answer = await failing.call('POST /tasks/:id/priority', {
				params: { id: taskId },
				query: { project: dir },
				body: { priority: 'high' },
			});

			expect(answer.status).toBe(200);
			expect(answer.body['undelivered']).toMatchObject([{ event: 'onTaskPriorityChanged', reason: 'exit 3' }]);
			expect(answer.body['undeliveredText']).toContain('onTaskPriorityChanged');
		} finally {
			failing.world.cleanup();
		}
	});
});

describe('POST /tasks/:id/assignee', () => {
	it('sets then clears the assignee; each change emits onTaskAssigneeChanged and carries no revision', async () => {
		const set = await post('POST /tasks/:id/assignee', { assignee: 'alice' });
		expect(set.status).toBe(200);
		expect(set.body['task']).toMatchObject({ id, assignee: 'alice' });
		expect(set.body['task']).not.toHaveProperty('revision');

		const cleared = await post('POST /tasks/:id/assignee', { assignee: '' });
		expect(cleared.status).toBe(200);
		expect(cleared.body['task']).not.toHaveProperty('assignee');
		expect(h.sink.events).toEqual([
			{ name: 'onTaskAssigneeChanged', payload: { taskId: id, newAssignee: 'alice', ...env() } },
			{ name: 'onTaskAssigneeChanged', payload: { taskId: id, oldAssignee: 'alice', ...env() } },
		]);
	});

	it('refuses a name with a line break, inline errors included', async () => {
		const answer = await post('POST /tasks/:id/assignee', { assignee: 'a\nb' }, { inlineErrors: 'true' });
		expect(answer.body).toMatchObject({ failed: true, httpStatus: 400 });
		expect(h.sink.events).toEqual([]);
	});
});

describe('POST /tasks/:id/claim', () => {
	it('claims a free task: the answer of `task claim --json` WITHOUT the revision, and one event', async () => {
		const before = Date.now();
		const answer = await post('POST /tasks/:id/claim', { assignee: 'w1', leaseMinutes: 45 });

		expect(answer.status).toBe(200);
		expect(answer.body).toMatchObject({ taskId: id, outcome: 'claimed', assignee: 'w1' });
		expect(answer.body).not.toHaveProperty('revision');
		expect(answer.body['task']).not.toHaveProperty('revision');
		expect(answer.body).not.toHaveProperty('previousAssignee');
		expect(Date.parse(answer.body['claimedAt'])).toBeGreaterThanOrEqual(before - 1000);
		expect(Date.parse(answer.body['leaseUntil']) - Date.parse(answer.body['claimedAt'])).toBeCloseTo(
			45 * 60_000,
			-4
		);
		expect(answer.body['task']).toMatchObject({ assignee: 'w1', leaseUntil: answer.body['leaseUntil'] });
		expect(answer.body['undelivered']).toEqual([]);
		expect(h.sink.events).toEqual([
			{
				name: 'onTaskAssigneeChanged',
				payload: { taskId: id, newAssignee: 'w1', outcome: 'claimed', ...env() },
			},
		]);
	});

	it('takes the lease length as digits too (a select of a form holds text) and defaults to the project lease', async () => {
		const text = await post('POST /tasks/:id/claim', { assignee: 'w1', leaseMinutes: '60' });
		expect(Date.parse(text.body['leaseUntil']) - Date.parse(text.body['claimedAt'])).toBeCloseTo(60 * 60_000, -4);

		const other = await createTask('second');
		const byDefault = await post('POST /tasks/:id/claim', { assignee: 'w1' }, {}, other);
		expect(Date.parse(byDefault.body['leaseUntil']) - Date.parse(byDefault.body['claimedAt'])).toBeCloseTo(
			30 * 60_000,
			-4
		);
	});

	it('another holder with a live lease is a 409 naming the holder and the time left, nothing written, no event', async () => {
		await post('POST /tasks/:id/claim', { assignee: 'w1' });
		h.sink.events.length = 0;

		const answer = await post('POST /tasks/:id/claim', { assignee: 'w2' });

		expect(answer.status).toBe(409);
		expect(answer.body['error']).toContain('"w1"');
		expect(answer.body['error']).toContain('left');
		expect(answer.body['hint']).toBeTruthy();
		expect((await detail())['assignee']).toBe('w1');
		expect(h.sink.events).toEqual([]);
	});

	it('the conflict is data for the view with inlineErrors (errorText has the holder and the hint)', async () => {
		await post('POST /tasks/:id/claim', { assignee: 'w1' });

		const answer = await post('POST /tasks/:id/claim', { assignee: 'w2' }, { inlineErrors: 'true' });

		expect(answer.status).toBe(200);
		expect(answer.body).toMatchObject({ failed: true, httpStatus: 409 });
		expect(answer.body['errorText']).toContain('"w1"');
	});

	it('force takes a live lease over and reports the previous holder', async () => {
		await post('POST /tasks/:id/claim', { assignee: 'w1' });
		h.sink.events.length = 0;

		const answer = await post('POST /tasks/:id/claim', { assignee: 'w2', force: true });

		expect(answer.status).toBe(200);
		expect(answer.body).toMatchObject({ outcome: 'takeover', assignee: 'w2', previousAssignee: 'w1' });
		expect(answer.body).not.toHaveProperty('revision');
		expect(h.sink.events).toEqual([
			{
				name: 'onTaskAssigneeChanged',
				payload: { taskId: id, oldAssignee: 'w1', newAssignee: 'w2', outcome: 'takeover', ...env() },
			},
		]);
	});

	it('the holder renews its own lease with renew, and is refused without it', async () => {
		const first = await post('POST /tasks/:id/claim', { assignee: 'w1', leaseMinutes: 10 });

		const refused = await post('POST /tasks/:id/claim', { assignee: 'w1' });
		expect(refused.status).toBe(409);

		const renewed = await post('POST /tasks/:id/claim', { assignee: 'w1', renew: true, leaseMinutes: 120 });
		expect(renewed.status).toBe(200);
		expect(renewed.body['outcome']).toBe('renewed');
		expect(renewed.body['claimedAt']).toBe(first.body['claimedAt']);
		expect(Date.parse(renewed.body['leaseUntil'])).toBeGreaterThan(Date.parse(first.body['leaseUntil']));
	});

	it('a task in a terminal status cannot be claimed, even with force (409 with the way out)', async () => {
		await post('POST /tasks/:id/status', { status: 'done' });

		const answer = await post('POST /tasks/:id/claim', { assignee: 'w1', force: true });

		expect(answer.status).toBe(409);
		expect(JSON.stringify(answer.body)).toContain('done');
	});

	it.each([
		['no assignee', {}, 'assignee must be a non-empty string'],
		['an empty assignee', { assignee: '' }, 'assignee must be a non-empty string'],
		['a lease of text', { assignee: 'w1', leaseMinutes: 'soon' }, 'leaseMinutes must be a whole number'],
		['a lease of 0', { assignee: 'w1', leaseMinutes: 0 }, 'lease'],
		['a lease beyond a week', { assignee: 'w1', leaseMinutes: 10081 }, 'lease'],
		['a force of text', { assignee: 'w1', force: 'yes' }, 'force must be true or false'],
		['a renew of text', { assignee: 'w1', renew: 'true' }, 'renew must be true or false'],
	])('refuses %s with a 400 and a hint, nothing written', async (_name, body, message) => {
		const answer = await post('POST /tasks/:id/claim', body);

		expect(answer.status).toBe(400);
		expect(String(answer.body['error'])).toContain(message);
		expect(answer.body['hint']).toBeTruthy();
		expect(h.sink.events).toEqual([]);
		expect((await detail())['hasAssignee']).toBe(false);
	});

	it('an unknown task is a 404', async () => {
		expect((await post('POST /tasks/:id/claim', { assignee: 'w1' }, {}, 'nope')).status).toBe(404);
	});
});

describe('POST /tasks/:id/release', () => {
	it('gives the task up: previous holder, the task without assignee and lease (no revision), one event', async () => {
		await post('POST /tasks/:id/claim', { assignee: 'w1' });
		h.sink.events.length = 0;

		const answer = await post('POST /tasks/:id/release', {});

		expect(answer.status).toBe(200);
		expect(answer.body).toMatchObject({ taskId: id, previousAssignee: 'w1' });
		expect(answer.body).not.toHaveProperty('revision');
		expect(answer.body['task']).not.toHaveProperty('revision');
		expect(answer.body['task']).not.toHaveProperty('assignee');
		expect(answer.body['task']).not.toHaveProperty('leaseUntil');
		expect(h.sink.events).toEqual([
			{
				name: 'onTaskAssigneeChanged',
				payload: { taskId: id, oldAssignee: 'w1', outcome: 'released', ...env() },
			},
		]);
	});

	it('accepts a request with no body at all', async () => {
		await post('POST /tasks/:id/claim', { assignee: 'w1' });
		expect((await post('POST /tasks/:id/release', undefined)).status).toBe(200);
	});

	it('a task nobody holds is a 409', async () => {
		const answer = await post('POST /tasks/:id/release', {});
		expect(answer.status).toBe(409);
		expect(answer.body['hint']).toContain('Nothing to release');
	});

	it('with an assignee, another holder needs force', async () => {
		await post('POST /tasks/:id/claim', { assignee: 'w1' });

		const refused = await post('POST /tasks/:id/release', { assignee: 'w2' });
		expect(refused.status).toBe(409);

		const forced = await post('POST /tasks/:id/release', { assignee: 'w2', force: true });
		expect(forced.status).toBe(200);
		expect(forced.body['previousAssignee']).toBe('w1');
	});

	it('refuses a force that is not a boolean', async () => {
		await post('POST /tasks/:id/claim', { assignee: 'w1' });
		const answer = await post('POST /tasks/:id/release', { force: 'yes' });
		expect(answer.status).toBe(400);
		expect((await detail())['assignee']).toBe('w1');
	});
});

describe('GET /tasks/:id: what the page binds', () => {
	it('a task with nothing set has the project default priority (flagged), the options with tones, and no assignee', async () => {
		const body = await detail();

		expect(body).toMatchObject({
			priority: 'medium',
			priorityIsDefault: true,
			priorityTone: 'neutral',
			supportsPriority: true,
			supportsClaim: true,
			assignee: '',
			hasAssignee: false,
			noAssignee: true,
			claimedAt: null,
			leaseUntil: null,
			leaseExpired: null,
			leaseText: null,
			leaseHeld: false,
			claimOpen: true,
			claimDefaultLeaseMinutes: 30,
		});
		// None first (an empty value clears), then the project's priorities highest first: the first is danger, the second warning.
		expect(body['priorityOptions']).toEqual([
			{ value: '', label: 'None (default: medium)', tone: 'neutral' },
			{ value: 'urgent', label: 'urgent', tone: 'danger' },
			{ value: 'high', label: 'high', tone: 'warning' },
			{ value: 'medium', label: 'medium', tone: 'neutral' },
			{ value: 'low', label: 'low', tone: 'neutral' },
		]);
		expect(body['leaseOptions']).toContainEqual({ value: '30', label: '30 min (default)' });
		expect(body['forms']).toMatchObject({
			priority: { priority: '' },
			claim: { assignee: '', leaseMinutes: '30', renew: true, force: false },
			takeOver: { assignee: '', leaseMinutes: '30', renew: false, force: true },
			release: {},
		});
	});

	it('a stored priority is the effective one and the picker value; a live lease says who, until when and how long is left', async () => {
		await post('POST /tasks/:id/priority', { priority: 'urgent' });
		await post('POST /tasks/:id/claim', { assignee: 'w1', leaseMinutes: 90 });

		const body = await detail();

		expect(body).toMatchObject({
			priority: 'urgent',
			priorityIsDefault: false,
			priorityTone: 'danger',
			assignee: 'w1',
			hasAssignee: true,
			noAssignee: false,
			leaseExpired: false,
			leaseHeld: true,
			claimOpen: false,
		});
		expect(body['leaseText']).toMatch(/^held until .* UTC, 1 h (2\d|30) min left$/);
		expect(body['forms'].priority.priority).toBe('urgent');
		expect(body['forms'].renew).toMatchObject({ assignee: 'w1', renew: true, force: false });
		expect(body['forms'].takeOver.assignee).toBe('');
		// Still no revision anywhere in the detail.
		expect(JSON.stringify(body)).not.toContain('revision');
	});

	it('the detail carries no revision key after a claim (the page has no use for it)', async () => {
		await post('POST /tasks/:id/claim', { assignee: 'w1' });
		expect(JSON.stringify(await detail())).not.toContain('"revision"');
	});
});

describe('GET /tasks: columns and filters', () => {
	let second: string;
	let third: string;
	beforeEach(async () => {
		second = await createTask('second task');
		third = await createTask('third task');
		await post('POST /tasks/:id/priority', { priority: 'urgent' }, {}, second);
		await post('POST /tasks/:id/claim', { assignee: 'w1' }, {}, second);
		await post('POST /tasks/:id/assignee', { assignee: 'w2' }, {}, third);
		h.sink.events.length = 0;
	});

	const list = async (extra: Record<string, unknown> = {}) => h.call('GET /tasks', { query: query(extra) });
	const ids = (answer: { body: Record<string, any> }) =>
		(answer.body['tasks'] as Array<{ id: string }>).map(t => t.id);

	it('every row has the effective priority, its text, the assignee ("" when nobody) and the lease text', async () => {
		const rows = (await list()).body['tasks'] as Array<Record<string, unknown>>;
		const byId = new Map(rows.map(row => [row['id'], row]));

		expect(byId.get(id)).toMatchObject({
			priority: 'medium',
			priorityText: 'medium (default)',
			priorityIsDefault: true,
			assignee: '',
			leaseText: '',
		});
		expect(byId.get(second)).toMatchObject({
			priority: 'urgent',
			priorityText: 'urgent',
			priorityIsDefault: false,
			assignee: 'w1',
		});
		expect(String(byId.get(second)!['leaseText'])).toMatch(
			/^held until .* UTC, 2\d min left$|^held until .* UTC, 30 min left$/
		);
		// An assignee set by hand has no lease: no text, never an invented one.
		expect(byId.get(third)).toMatchObject({ assignee: 'w2', leaseText: '' });
		for (const row of rows) expect(row).not.toHaveProperty('revision');
	});

	it('?priority=a,b keeps the tasks with one of these EFFECTIVE priorities', async () => {
		expect(ids(await list({ priority: 'urgent' }))).toEqual([second]);
		expect(ids(await list({ priority: 'medium' })).sort()).toEqual([id, third].sort());
		expect(ids(await list({ priority: 'urgent,medium' })).sort()).toEqual([id, second, third].sort());
	});

	it('?assignee=<name>, ?unassigned=true and ?available=true', async () => {
		expect(ids(await list({ assignee: 'w1' }))).toEqual([second]);
		expect(ids(await list({ unassigned: 'true' }))).toEqual([id]);
		// Held by nobody, or lease over: w2 holds by hand with no lease (not available), w1 has a live lease.
		expect(ids(await list({ available: 'true' }))).toEqual([id]);
	});

	it('?order=priority-then-oldest puts the most urgent first', async () => {
		const answer = await list({ order: 'priority-then-oldest' });
		expect(answer.status).toBe(200);
		expect(ids(answer)[0]).toBe(second);
	});

	it('an unknown priority, order or a blank assignee is a 400 with the service hint; two exclusive filters too', async () => {
		const priority = await list({ priority: 'huge' });
		expect(priority.status).toBe(400);
		expect(JSON.stringify(priority.body)).toContain('urgent');

		const order = await list({ order: 'nope' });
		expect(order.status).toBe(400);
		expect(order.body['hint']).toBeTruthy();

		const both = await list({ assignee: 'w1', unassigned: 'true' });
		expect(both.status).toBe(400);
		expect(String(both.body['error'])).toContain('cannot be combined');
	});

	it('an empty entry of the priority list and a flag that is not true/false are 400s', async () => {
		expect((await list({ priority: 'urgent,,high' })).status).toBe(400);
		expect((await list({ unassigned: 'maybe' })).status).toBe(400);
	});

	it('an empty value is no filter (a cleared field of a view)', async () => {
		expect(ids(await list({ priority: '', assignee: '', order: '' })).sort()).toEqual([id, second, third].sort());
	});

	it('the filters cannot narrow the all-projects list: a 400 naming the filter, never silently ignored', async () => {
		const answer = await h.call('GET /tasks', { query: { allProjects: 'true', priority: 'urgent' } });
		expect(answer.status).toBe(400);
		expect(String(answer.body['error'])).toContain('priority');
		expect(String(answer.body['error'])).toContain('allProjects');
	});

	it('the all-projects list without a filter still works', async () => {
		const answer = await h.call('GET /tasks', { query: { allProjects: 'true' } });
		expect(answer.status).toBe(200);
	});
});
