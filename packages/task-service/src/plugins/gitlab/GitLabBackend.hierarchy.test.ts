// The hierarchy and the native types of the gitlab backend over the fake server. GitLab Free (VERIFIED-LIVE 2026-11-09, see
// fixtures/live-conformance.json): a parent is an Issue or an Incident, a child is a native Task, so a hierarchy has two levels;
// everything goes through GraphQL work items. The rules of each write are in the comment above `setParent` in gitlabWrites.ts.
import {
	BackendLimitError,
	BackendRejectedError,
	PartialWriteError,
	TaskConflictError,
	TaskNotFoundError,
} from '@wadeck-app/task-core';

import { FakeGitLab } from './fakeGitLab.testkit.js';
import { WRITE_STATUSES, makeGitLabBackend, writeStatusMap } from './gitlabBackend.testkit.js';
import type { TestBackend } from './gitlabBackend.testkit.js';

let fake: FakeGitLab;
let t: TestBackend;

async function start(types: Record<string, unknown> = {}) {
	fake = await FakeGitLab.start();
	t = makeGitLabBackend(fake, {
		statuses: WRITE_STATUSES,
		projectTypes: ['bug', 'chore'],
		options: { statusMap: writeStatusMap(), ...(Object.keys(types).length === 0 ? {} : { typeMap: types }) },
	});
}

beforeEach(() => start());

afterEach(async () => {
	await fake.stop();
});

const failure = async (call: () => Promise<unknown>): Promise<Error> => {
	try {
		await call();
	} catch (error) {
		return error as Error;
	}
	throw new Error('expected a failure');
};

/** The GraphQL requests that reached the fake, as `kind` + the variables that matter. */
const graphql = (): Array<{ kind: string; body: { query: string; variables?: Record<string, unknown> } }> =>
	fake.requests
		.filter(request => request.path === '/api/graphql')
		.map(request => {
			const body = request.body as { query: string; variables?: Record<string, unknown> };
			const kind = body.query.includes('workItemUpdate')
				? 'parent'
				: body.query.includes('workItemConvert')
					? 'convert'
					: 'read';
			return { kind, body };
		});
const kinds = (): string[] => graphql().map(request => request.kind);
const rest = (): string[] =>
	fake.requests
		.filter(request => request.path !== '/api/graphql')
		.map(request => `${request.method} ${request.path}`);

async function issue(title = 'Issue'): Promise<string> {
	return (await t.backend.create({ title, status: 'backlog' })).id;
}

describe('create under a parent', () => {
	it('creates the child as a native Task with the POST itself, then sets the parent with GraphQL', async () => {
		const parent = await issue('Parent');
		fake.requests.length = 0;

		const child = await t.backend.create({ title: 'Child', status: 'backlog', parentId: parent });

		expect(child.parentId).toBe(parent);
		expect(fake.issue(2)!.issueType).toBe('task');
		expect(fake.issue(2)!.parentIid).toBe(1);
		expect(rest().filter(line => line.startsWith('POST') || line.startsWith('PUT'))).toEqual([
			'POST /projects/42/issues',
		]);
		expect(fake.writes().find(request => request.path.endsWith('/issues'))!.body).toEqual({
			title: 'Child',
			issue_type: 'task',
		});
		expect(kinds().filter(kind => kind !== 'read')).toEqual(['parent']);
	});

	it('accepts an Incident as the parent', async () => {
		fake.seedIssue({ title: 'Outage', issueType: 'incident' });

		const child = await t.backend.create({ title: 'Fix it', status: 'backlog', parentId: '1' });

		expect(child.parentId).toBe('1');
	});

	it('refuses a native Task as the parent, with the reason, before creating anything', async () => {
		fake.seedIssue({ title: 'A task', issueType: 'task' });
		fake.requests.length = 0;

		const error = await failure(() => t.backend.create({ title: 'Child', status: 'backlog', parentId: '1' }));

		expect(error).toBeInstanceOf(BackendRejectedError);
		expect(error.message).toContain('native Task');
		expect((error as BackendRejectedError).hint).toContain('Issue or an Incident');
		expect(fake.writes()).toEqual([]);
	});

	it('creates a child in a terminal status with the parent set BEFORE the closing', async () => {
		const parent = await issue('Parent');
		fake.requests.length = 0;

		const child = await t.backend.create({ title: 'Child', status: 'cancelled', parentId: parent });

		expect(child).toMatchObject({ parentId: parent, status: 'cancelled' });
		const trace = fake
			.writes()
			.map(request =>
				request.path === '/api/graphql'
					? `graphql ${JSON.stringify(request.body).includes('workItemUpdate') ? 'parent' : 'read'}`
					: `${request.method} ${request.path}`
			)
			.filter(line => line !== 'graphql read');
		expect(trace).toEqual(['POST /projects/42/issues', 'graphql parent', 'PUT /projects/42/issues/2']);
	});

	it('says what GitLab holds when the parent cannot be set after the creation (PartialWriteError with the command)', async () => {
		const parent = await issue('Parent');
		// the two reads before the creation are REST; the first GraphQL call is the parent update
		fake.failNext({
			status: 403,
			method: 'POST',
			pathPrefix: '/api/graphql',
			body: { error: 'insufficient_granular_scope', error_description: 'Work Item: Update' },
		});

		const error = (await failure(() =>
			t.backend.create({ title: 'Child', status: 'backlog', parentId: parent })
		)) as PartialWriteError;

		expect(error).toBeInstanceOf(PartialWriteError);
		expect(error.applied).toEqual(['created issue #2']);
		expect(error.notApplied).toEqual(['set the parent #1']);
		expect(error.hint).toContain('task set-parent 2 1');
	});
});

describe('setParent', () => {
	it('converts an Issue to a native Task first, then attaches it; nothing else is sent', async () => {
		const parent = await issue('Parent');
		const child = await issue('Child');
		fake.requests.length = 0;

		const moved = await t.backend.setParent(child, parent);

		expect(moved.parentId).toBe(parent);
		expect(fake.issue(2)!.issueType).toBe('task');
		expect(kinds().filter(kind => kind !== 'read')).toEqual(['convert', 'parent']);
		expect(rest().filter(line => line.startsWith('PUT') || line.startsWith('POST'))).toEqual([]);
	});

	it('leaves a task that is already a native Task as it is (no conversion)', async () => {
		const parent = await issue('Parent');
		fake.seedIssue({ title: 'Task', issueType: 'task' });
		fake.requests.length = 0;

		await t.backend.setParent('2', parent);

		expect(kinds().filter(kind => kind !== 'read')).toEqual(['parent']);
	});

	it('replaces the parent with one call, and does nothing for the parent it already has', async () => {
		const a = await issue('A');
		const b = await issue('B');
		const child = (await t.backend.create({ title: 'C', status: 'backlog', parentId: a })).id;
		fake.requests.length = 0;

		await t.backend.setParent(child, a);
		expect(kinds().filter(kind => kind !== 'read')).toEqual([]);
		const moved = await t.backend.setParent(child, b);

		expect(moved.parentId).toBe(b);
		expect(kinds().filter(kind => kind !== 'read')).toEqual(['parent']);
	});

	it('refuses an Incident as the child: converting it would drop its type', async () => {
		const parent = await issue('Parent');
		fake.seedIssue({ title: 'Outage', issueType: 'incident' });
		fake.requests.length = 0;

		const error = await failure(() => t.backend.setParent('2', parent));

		expect(error).toBeInstanceOf(BackendRejectedError);
		expect(error.message).toContain('Incident');
		expect(kinds().filter(kind => kind !== 'read')).toEqual([]);
		expect(fake.issue(2)!.issueType).toBe('incident');
	});

	it('refuses a parent that is a child itself (depth), and a task that has children (depth)', async () => {
		const root = await issue('Root');
		const middle = (await t.backend.create({ title: 'Middle', status: 'backlog', parentId: root })).id;
		const other = await issue('Other');
		const lone = await issue('Lone');

		const below = await failure(() => t.backend.setParent(lone, middle));
		const above = await failure(() => t.backend.setParent(root, other));

		expect(below).toBeInstanceOf(BackendLimitError);
		expect(below.message).toContain('hierarchy depth');
		expect((below as BackendLimitError).hint).toContain('two levels');
		expect(above).toBeInstanceOf(BackendLimitError);
		expect(fake.issue(4)!.issueType).toBe('issue');
		expect(fake.issue(1)!.issueType).toBe('issue');
	});

	it('refuses a native Task that is a root as the parent: a Task cannot have children', async () => {
		fake.seedIssue({ title: 'A task', issueType: 'task' });
		const lone = await issue('Lone');

		const error = await failure(() => t.backend.setParent(lone, '1'));

		expect(error).toBeInstanceOf(BackendRejectedError);
		expect(error.message).toContain('native Task');
	});

	it('refuses itself and a descendant (cycle) with a TaskConflictError, sending no write', async () => {
		const root = await issue('Root');
		const child = (await t.backend.create({ title: 'Child', status: 'backlog', parentId: root })).id;
		fake.requests.length = 0;

		const self = await failure(() => t.backend.setParent(root, root));
		const cycle = await failure(() => t.backend.setParent(root, child));

		expect(self).toBeInstanceOf(TaskConflictError);
		expect(cycle).toBeInstanceOf(TaskConflictError);
		expect(cycle.message).toContain('cycle');
		expect(kinds().filter(kind => kind !== 'read')).toEqual([]);
		expect(fake.writes().filter(request => request.path !== '/api/graphql')).toEqual([]);
	});

	it('refuses an unknown parent as TaskNotFoundError', async () => {
		const lone = await issue('Lone');

		expect(await failure(() => t.backend.setParent(lone, '99'))).toBeInstanceOf(TaskNotFoundError);
	});

	it('a refused conversion leaves the issue as it was (nothing applied, the plain error)', async () => {
		const parent = await issue('Parent');
		const child = await issue('Child');
		// reads: child, parent; then the conversion
		fake.failNext({
			status: 403,
			method: 'POST',
			pathPrefix: '/api/graphql',
			skip: 2,
			body: { message: '403 Forbidden' },
		});

		const error = await failure(() => t.backend.setParent(child, parent));

		expect(error).not.toBeInstanceOf(PartialWriteError);
		expect(fake.issue(2)!.issueType).toBe('issue');
		expect(fake.issue(2)!.parentIid).toBeNull();
	});

	it('a parent refused after the conversion is a PartialWriteError naming what holds and the command to finish', async () => {
		const parent = await issue('Parent');
		const child = await issue('Child');
		fake.failNext({
			status: 403,
			method: 'POST',
			pathPrefix: '/api/graphql',
			skip: 3,
			body: { message: '403 Forbidden' },
		});

		const error = (await failure(() => t.backend.setParent(child, parent))) as PartialWriteError;

		expect(error).toBeInstanceOf(PartialWriteError);
		expect(error.applied[0]).toContain('converted the issue to a native Task');
		expect(error.notApplied).toEqual([`set the parent #1`]);
		expect(error.hint).toContain('task set-parent 2 1');
		expect(fake.issue(2)!.issueType).toBe('task');
	});

	it('sends exactly the documents the conformance scenario recorded', async () => {
		const parent = await issue('Parent');
		const child = await issue('Child');
		fake.requests.length = 0;

		await t.backend.setParent(child, parent);

		const { GQL_CONVERT, GQL_READ, GQL_SET_PARENT } = await import('./gitlabWorkItems.js');
		const scenario = (await import('../../../../../scripts/gitlab-conformance-scenario.mjs')) as {
			GQL_READ: string;
			GQL_SET_PARENT: string;
			GQL_CONVERT: string;
		};
		expect([GQL_READ, GQL_SET_PARENT, GQL_CONVERT]).toEqual([
			scenario.GQL_READ,
			scenario.GQL_SET_PARENT,
			scenario.GQL_CONVERT,
		]);
		// (the batched read of the parents of a page, `query { w0: workItem(...) }`, is the only other document)
		const queries = new Set(
			graphql()
				.map(request => request.body.query)
				.filter(query => !query.startsWith('query {'))
		);
		expect([...queries].sort()).toEqual([GQL_CONVERT, GQL_READ, GQL_SET_PARENT].sort());
	});
});

describe('removeParent', () => {
	it('sends parentId null, keeps the native type Task, and refuses a task that has no parent', async () => {
		const parent = await issue('Parent');
		const child = (await t.backend.create({ title: 'Child', status: 'backlog', parentId: parent })).id;
		fake.requests.length = 0;

		const detached = await t.backend.removeParent(child);

		expect(detached.parentId).toBeUndefined();
		const update = graphql().find(request => request.kind === 'parent')!;
		expect(update.body.variables).toMatchObject({ input: { hierarchyWidget: { parentId: null } } });
		// the type is not touched: no conversion, no PUT
		expect(kinds()).not.toContain('convert');
		expect(fake.issue(2)!.issueType).toBe('task');
		expect(await failure(() => t.backend.removeParent(child))).toBeInstanceOf(TaskConflictError);
		expect(await failure(() => t.backend.removeParent(parent))).toBeInstanceOf(TaskConflictError);
	});
});

describe('reads', () => {
	async function family() {
		const root = await issue('Root');
		const first = (await t.backend.create({ title: 'First', status: 'backlog', parentId: root })).id;
		const second = (await t.backend.create({ title: 'Second', status: 'in-progress', parentId: root })).id;
		const loose = await issue('Loose');
		return { root, first, second, loose };
	}

	it('lists the parent of each task with ONE GraphQL request for the page, and none when no issue can have a parent', async () => {
		const { first, second } = await family();
		fake.requests.length = 0;

		const summaries = await t.backend.list();

		expect(summaries.find(task => task.id === first)?.parentId).toBe('1');
		expect(summaries.find(task => task.id === second)?.parentId).toBe('1');
		expect(summaries.find(task => task.id === '1')?.parentId).toBeUndefined();
		expect(graphql()).toHaveLength(1);
		expect(graphql()[0]!.body.query).toContain('w0: workItem(');
		// only the native Tasks are asked for (an Issue cannot have a parent)
		expect(graphql()[0]!.body.query).not.toContain('w2');

		await fake.stop();
		await start();
		await issue('A');
		await issue('B');
		fake.requests.length = 0;
		await t.backend.list();
		expect(graphql()).toEqual([]);
	});

	it('batches 50 reads per request', async () => {
		const parent = await issue('Parent');
		for (let index = 0; index < 120; index++) fake.seedIssue({ title: `T${index}`, issueType: 'task' });
		fake.seedParent(2, Number(parent));
		fake.requests.length = 0;

		const summaries = await t.backend.list();

		expect(graphql()).toHaveLength(3);
		expect(summaries.find(task => task.id === '2')?.parentId).toBe('1');
		expect(summaries).toHaveLength(121);
	});

	it('filters a page by parent: null = the roots, an id = its children, with a cursor', async () => {
		const { root, first, second, loose } = await family();

		const roots = await t.backend.listPage({ parentId: null });
		const children = await t.backend.listPage({ parentId: root });
		const firstPage = await t.backend.listPage({ parentId: root, limit: 1 });
		const secondPage = await t.backend.listPage({ parentId: root, limit: 1, cursor: firstPage.nextCursor! });

		expect(roots.items.map(task => task.id)).toEqual([root, loose]);
		expect(children.items.map(task => task.id)).toEqual([first, second]);
		expect(children.items.every(task => task.parentId === root)).toBe(true);
		expect(firstPage.items.map(task => task.id)).toEqual([first]);
		expect(secondPage.items.map(task => task.id)).toEqual([second]);
		expect(secondPage.nextCursor).toBeUndefined();
		expect(
			(await t.backend.listPage({ parentId: root, statusIn: ['in-progress'] })).items.map(task => task.id)
		).toEqual([second]);
		expect(await failure(() => t.backend.listPage({ parentId: '99' }))).toBeInstanceOf(TaskNotFoundError);
	});

	it('degrades the list with a warning when the token cannot read work items, and never fails it', async () => {
		const { first } = await family();
		fake.failNext({
			status: 403,
			method: 'POST',
			pathPrefix: '/api/graphql',
			body: { error: 'insufficient_granular_scope', error_description: 'requires Work Item: Read' },
		});

		const summaries = await t.backend.list();

		expect(summaries.map(task => task.id)).toEqual(['1', '2', '3', '4']);
		expect(summaries.find(task => task.id === first)?.parentId).toBeUndefined();
		const warning = t.notices.find(notice => notice.text.includes('parent of a task is not shown'));
		expect(warning).toMatchObject({ kind: 'ignored' });
		expect(warning!.text).toContain('Work Item: Read');
	});

	it('reads children, ancestors, the tree, the full tree and the descendants', async () => {
		const { root, first, second } = await family();

		expect((await t.backend.getChildren(root)).map(task => task.id)).toEqual([first, second]);
		expect((await t.backend.getAncestors(first)).map(task => task.id)).toEqual([root]);
		expect(await t.backend.getAncestors(root)).toEqual([]);
		const tree = await t.backend.getTree(root);
		expect(tree.children.map(node => node.id)).toEqual([first, second]);
		expect(tree.children.every(node => node.children.length === 0 && node.parentId === root)).toBe(true);
		expect((await t.backend.getDescendants(root)).map(task => task.id)).toEqual([first, second]);
		const full = await t.backend.getFullTree(second);
		expect(full.id).toBe(root);
		expect(full.children.find(node => node.selected)?.id).toBe(second);
		const forest = await t.backend.getForest({ parentId: root });
		expect(forest.map(node => node.id)).toEqual([first, second]);
		expect(await failure(() => t.backend.getChildren('99'))).toBeInstanceOf(TaskNotFoundError);
	});

	it('the record of a child carries its parent and the system note of the hierarchy is in the activity', async () => {
		const { root, first } = await family();

		const record = await t.backend.get(first);
		const parentRecord = await t.backend.get(root);

		expect(record.parentId).toBe(root);
		expect(record.activity?.some(entry => entry.kind === 'parent' && entry.newValue === root)).toBe(true);
		expect(parentRecord.parentId).toBeUndefined();
		expect(parentRecord.activity?.filter(entry => entry.kind === 'child-added').map(entry => entry.target)).toEqual(
			[first, '3']
		);
		expect(parentRecord.activity?.every(entry => entry.kind !== 'child-added' || entry.inverse === true)).toBe(
			true
		);
	});

	it('a deleted parent leaves its children as roots (hard delete)', async () => {
		await fake.stop();
		fake = await FakeGitLab.start();
		t = makeGitLabBackend(fake, {
			statuses: WRITE_STATUSES,
			options: { statusMap: writeStatusMap() },
			fills: { delete: { use: 'hard', fidelity: 'strict' } },
		});
		const parent = await issue('Parent');
		const child = (await t.backend.create({ title: 'Child', status: 'backlog', parentId: parent })).id;

		expect(await t.backend.deleteTask(parent)).toBe(true);

		expect((await t.backend.get(child)).parentId).toBeUndefined();
	});
});

describe('a tombstoned parent (fills.delete: tombstone)', () => {
	it('detaches its children first, so they become roots instead of pointing at a hidden task', async () => {
		await fake.stop();
		fake = await FakeGitLab.start();
		t = makeGitLabBackend(fake, {
			statuses: WRITE_STATUSES,
			options: { statusMap: writeStatusMap() },
			fills: { delete: { use: 'tombstone', fidelity: 'degrade' } },
		});
		const parent = await issue('Parent');
		const child = (await t.backend.create({ title: 'Child', status: 'backlog', parentId: parent })).id;

		expect(await t.backend.deleteTask(parent)).toBe(true);

		expect((await t.backend.get(child)).parentId).toBeUndefined();
		expect((await t.backend.list()).map(task => [task.id, task.parentId])).toEqual([[child, undefined]]);
	});
});

describe('native types', () => {
	it('never converts to a native Task for a task type: typeMap issueType task is refused by setType, nothing is sent', async () => {
		await fake.stop();
		await start();
		// the configuration refuses it at load (gitlabOptions.test.ts); set it by hand to prove the writer refuses it too
		(t.settings.typeMap as Record<string, { issueType?: string }>)['chore'] = { issueType: 'task' };
		const id = await issue('Chore');
		fake.requests.length = 0;

		const error = await failure(() => t.backend.setType(id, 'chore'));

		expect(error).toBeInstanceOf(BackendRejectedError);
		expect((error as BackendRejectedError).hint).toContain('hierarchy child');
		expect(fake.requests).toEqual([]);
		expect(fake.issue(1)!.issueType).toBe('issue');
	});

	it('a native Task (hierarchy child) has no task type, and cannot be given the Incident type: refused with the reason', async () => {
		await fake.stop();
		await start({ bug: { issueType: 'incident' } });
		const parent = await issue('Parent');
		const child = (await t.backend.create({ title: 'Child', status: 'backlog', parentId: parent })).id;

		expect((await t.backend.get(child)).type).toBeUndefined();
		const error = await failure(() => t.backend.setType(child, 'bug'));

		expect(error).toBeInstanceOf(BackendRejectedError);
		expect(error.message).toContain('native Task');
		expect(fake.issue(2)!.issueType).toBe('task');
	});

	it('maps a type to the native Incident with one PUT and gives it back to Issue', async () => {
		await fake.stop();
		await start({ bug: { issueType: 'incident' } });
		const id = await issue('Outage');
		fake.requests.length = 0;

		const typed = await t.backend.setType(id, 'bug');
		expect(typed.type).toBe('bug');
		expect(fake.issue(1)!.issueType).toBe('incident');
		expect(kinds()).toEqual([]);

		const cleared = await t.backend.clearType(id);
		expect(cleared.type).toBeUndefined();
		expect(fake.issue(1)!.issueType).toBe('issue');
	});

	it('keeps a child a native Task when its task type becomes a label', async () => {
		const parent = await issue('Parent');
		const child = (await t.backend.create({ title: 'Child', status: 'backlog', parentId: parent })).id;

		const typed = await t.backend.setType(child, 'bug');

		expect(typed.type).toBe('bug');
		expect(typed.parentId).toBe(parent);
		expect(fake.issue(2)!.issueType).toBe('task');
	});

	it('refuses test_case before sending anything: GitLab turns it into issue on create and ignores it on update', async () => {
		await fake.stop();
		await start();
		(t.settings.typeMap as Record<string, { issueType?: string }>)['bug'] = { issueType: 'test_case' };
		const id = await issue('T');
		fake.requests.length = 0;

		const error = await failure(() => t.backend.setType(id, 'bug'));

		expect(error).toBeInstanceOf(BackendRejectedError);
		expect(error.message).toContain('test_case');
		expect((error as BackendRejectedError).hint).toContain('ignores it when updating');
		expect(fake.writes()).toEqual([]);
	});

	it('throws BackendRejectedError when GitLab answers 200 but keeps another native type', async () => {
		await fake.stop();
		await start({ bug: { issueType: 'incident' } });
		const id = await issue('T');
		// an update that does nothing, whatever it was asked
		fake.failNext({
			status: 200,
			method: 'PUT',
			body: { ...fake.issue(1), issue_type: 'issue', labels: [] },
			applyWrite: false,
		});

		const error = await failure(() => t.backend.setType(id, 'bug'));

		expect(error).toBeInstanceOf(BackendRejectedError);
		expect(error.message).toContain('ignored the issue type "incident"');
	});
});
