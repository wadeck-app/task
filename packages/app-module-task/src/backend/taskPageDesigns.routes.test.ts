// Detail fields and route behaviour the three task page designs (issue, bar, flow) bind to: checklist rows, texts of the
// delete dialog, clearing the type, the ids of the delete page address.
import { setup, STATUSES_YML } from './routeHarness.js';
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

const detail = (id: string) => h.call('GET /tasks/:id', { params: { id }, query: { project } });
const call = (route: string, id: string, body?: unknown) => h.call(route, { params: { id }, query: { project }, body });

describe('detail fields of the three task page designs', () => {
	it('no longer has the temporary titleShort / hasShortTitle fields', async () => {
		const { body } = await detail(await createTask('t'));
		expect(body).not.toHaveProperty('titleShort');
		expect(body).not.toHaveProperty('hasShortTitle');
	});

	it('checklistRows: the children as checklist rows (headline, tone, terminal, href); the done/reopen statuses come from the config', async () => {
		const id = await createTask('parent');
		const open = await createTask('open child', { parent: id });
		const closed = await createTask('closed child', { parent: id });
		await call('POST /tasks/:id/status', closed, { status: 'done' });
		const { body } = await detail(id);
		expect(body['terminalStatus']).toBe('done');
		expect(body['reopenStatus']).toBe('backlog');
		const rows = body['checklistRows'] as Array<Record<string, unknown>>;
		expect(rows.map(row => [row['id'], row['terminal']])).toEqual(
			expect.arrayContaining([
				[open, false],
				[closed, true],
			])
		);
		const row = rows.find(entry => entry['id'] === closed)!;
		expect(row).toMatchObject({
			title: 'closed child',
			headline: 'closed child',
			status: 'done',
			tone: 'success',
			terminal: true,
		});
		expect(String(row['href'])).toContain(closed);
		expect((await detail(open)).body['checklistRows']).toEqual([]);
	});

	it('noBodyInfo is the opposite of bodyAddsInfo (the DSL has no negation)', async () => {
		const short = await createTask('short');
		expect((await detail(short)).body).toMatchObject({ bodyAddsInfo: false, noBodyInfo: true });
		const long = await createTask('a sentence that goes on. '.repeat(10));
		expect((await detail(long)).body).toMatchObject({ bodyAddsInfo: true, noBodyInfo: false });
	});

	it('the texts of the delete dialog say what happens: children become roots, links removed, blocked tasks, the cascade label', async () => {
		const root = await createTask('root');
		const child = await createTask('child', { parent: root });
		await createTask('grandchild', { parent: child });
		const other = await createTask('other');
		await call('POST /tasks/:id/links', other, { type: 'blockedBy', target: root });
		const { body } = await detail(root);
		expect(body['deleteImpactText']).toBe(
			'Deleting this task: its 1 child becomes a root task, 1 link is removed, 1 task it blocks loses a blocker. This cannot be undone.'
		);
		expect(body['hasDescendants']).toBe(true);
		// The impact sentence cannot follow the switch (a view reads no form state): the label states the alternative.
		expect(body['deleteCascadeLabel']).toBe(
			'Also delete its 2 descendants (otherwise its 1 child becomes a root task)'
		);
		const blocked = await detail(other);
		expect(blocked.body['hasDescendants']).toBe(false);
		expect(blocked.body['deleteImpactText']).toBe('Deleting this task: 1 link is removed. This cannot be undone.');
		const plain = await createTask('plain');
		expect((await detail(plain)).body['deleteImpactText']).toBe(
			'Deleting this task has no other effect: no children, no links. This cannot be undone.'
		);
	});

	it('pillTexts: each property pill as one labelled text ("Type: none"), the blocked pill only while blockers are open', async () => {
		const parent = await createTask('Q4 hardening');
		const blocker = await createTask('blocker');
		const id = await createTask('the task', { parent });
		await call('POST /tasks/:id/labels', id, { label: 'billing' });
		await call('POST /tasks/:id/links', id, { type: 'blockedBy', target: blocker });
		expect((await detail(id)).body['pillTexts']).toEqual({
			status: 'Status: backlog',
			type: 'Type: none',
			labels: 'Labels: billing',
			parent: 'Parent: Q4 hardening',
			blocked: 'Blocked by: 1 open',
		});
		expect((await detail(blocker)).body['pillTexts']).not.toHaveProperty('blocked');
	});

	it('forms.delete carries the task id and confirm: true, ready for POST /tasks/delete from the dialog', async () => {
		const id = await createTask('t');
		const forms = (await detail(id)).body['forms'] as Record<string, unknown>;
		expect(forms['delete']).toMatchObject({ ids: id, cascade: false, confirm: true });
	});

	it('linkTypeOptions read as a sentence ("Blocked by", not "blockedBy"), with the stored name as the value', async () => {
		const { body } = await detail(await createTask('t'));
		const options = body['linkTypeOptions'] as Array<{ value: string; label: string }>;
		expect(options[0]).toEqual({ value: 'blockedBy', label: 'Blocked by' });
		expect(options.map(option => option.value)).toContain('duplicateOf');
		expect(options.find(option => option.value === 'duplicateOf')!.label).toBe('Duplicate of');
	});
});

describe('POST /tasks/:id/type with an empty type clears it (the "None" choice of the type picker)', () => {
	it('unsets the type and emits onTaskTypeChanged without newType', async () => {
		await h.call('POST /types', { query: { project }, body: { name: 'bug' } });
		const id = await createTask('t');
		await call('POST /tasks/:id/type', id, { type: 'bug' });
		h.sink.events.length = 0;
		const answer = await call('POST /tasks/:id/type', id, { type: '' });
		expect(answer.status).toBe(200);
		expect(answer.body['task']['type']).toBeUndefined();
		expect(h.sink.events).toMatchObject([{ name: 'onTaskTypeChanged', payload: { taskId: id, oldType: 'bug' } }]);
		expect((h.sink.events[0]!.payload as { newType?: string }).newType).toBeUndefined();
	});

	it('still refuses a missing type field', async () => {
		const id = await createTask('t');
		const answer = await call('POST /tasks/:id/type', id, {});
		expect(answer.status).toBe(400);
	});
});

describe('GET /projects ?ids= (the delete page opened from a task)', () => {
	it('puts the ids of the address in the delete form, so they are not retyped', async () => {
		const answer = await h.call('GET /projects', { query: { project, ids: 'abc12345' } });
		expect(answer.body['forms']['delete']).toMatchObject({ ids: 'abc12345', all: false, cascade: false });
	});

	it('without ids the field is empty', async () => {
		const answer = await h.call('GET /projects', { query: { project } });
		expect(answer.body['forms']['delete']).toMatchObject({ ids: '' });
	});
});
