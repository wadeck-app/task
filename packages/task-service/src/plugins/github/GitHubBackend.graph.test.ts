// The write path of the github backend over the fake server: parent and children, links, comments, deletion.
import {
	BackendAuthError,
	BackendLimitError,
	CommentNotFoundError,
	InvalidCommentTextError,
	PartialWriteError,
	TaskConflictError,
	TaskNotFoundError,
	UnsupportedByBackendError,
} from '@wadeck-app/task-core';

import { FakeGitHub } from './fakeGitHub.testkit.js';
import { WRITE_STATUS_MAP, WRITE_STATUSES, makeGitHubBackend } from './githubBackend.testkit.js';
import type { TestBackend } from './githubBackend.testkit.js';

let fake: FakeGitHub;
let t: TestBackend;

const R = '/repos/acme/shop';

function make(extra: Parameters<typeof makeGitHubBackend>[1] = {}): TestBackend {
	return makeGitHubBackend(fake, {
		statuses: WRITE_STATUSES,
		...extra,
		options: { statusMap: WRITE_STATUS_MAP, ...extra.options },
	});
}

beforeEach(async () => {
	fake = await FakeGitHub.start({ repo: 'acme/shop' });
	t = make();
});

afterEach(async () => {
	await fake.stop();
});

const sent = (): string[] => fake.writes().map(request => `${request.method} ${request.path.replace(R, '')}`);

const failure = async (call: () => Promise<unknown>): Promise<Error> => {
	try {
		await call();
	} catch (error) {
		return error as Error;
	}
	throw new Error('expected a failure');
};

const seed = (...titles: string[]): void => {
	for (const title of titles) fake.addIssue({ title });
};

describe('setParent and removeParent', () => {
	beforeEach(() => seed('Parent', 'Child', 'Other'));

	it('attaches a child with one POST on the parent, by the numeric id, and moves it with replace_parent', async () => {
		const attached = await t.backend.setParent('2', '1');

		expect(sent()).toEqual(['POST /issues/1/sub_issues']);
		expect(fake.writes()[0]!.body).toEqual({ sub_issue_id: fake.issues.get(2)!.id, replace_parent: true });
		expect(attached.parentId).toBe('1');

		fake.requests.length = 0;
		const moved = await t.backend.setParent('2', '3');
		expect(sent()).toEqual(['POST /issues/3/sub_issues']);
		expect(moved.parentId).toBe('3');
	});

	it('the same parent sends nothing', async () => {
		await t.backend.setParent('2', '1');
		fake.requests.length = 0;

		const again = await t.backend.setParent('2', '1');

		expect(again.parentId).toBe('1');
		expect(fake.writes()).toEqual([]);
	});

	it('itself, a descendant (cycle) and an unknown task are refused before the write, with the cycle spelled out', async () => {
		await t.backend.setParent('2', '1');
		fake.requests.length = 0;

		const itself = await failure(() => t.backend.setParent('1', '1'));
		const cycle = await failure(() => t.backend.setParent('1', '2'));
		const unknown = await failure(() => t.backend.setParent('2', '99'));

		expect(itself).toBeInstanceOf(TaskConflictError);
		expect(itself.message).toBe('Task "1" cannot be its own parent');
		expect(cycle).toBeInstanceOf(TaskConflictError);
		expect(cycle.message).toContain('it would create a cycle');
		expect(cycle.message).toContain('"2" is a descendant of "1"');
		expect(unknown).toBeInstanceOf(TaskNotFoundError);
		expect(fake.writes()).toEqual([]);
	});

	it('the 8th level is the limit error GitHub reports, named with its limit', async () => {
		let previous = 1;
		for (let level = 2; level <= 8; level++) {
			const number = fake.addIssue({ title: `Level ${level}` });
			fake.setParent(number, previous);
			previous = number;
		}
		const deeper = fake.addIssue({ title: 'Level 9' });

		const error = await failure(() => t.backend.setParent(String(deeper), String(previous)));

		expect(error).toBeInstanceOf(BackendLimitError);
		expect((error as BackendLimitError).limit).toBe(8);
		expect((error as BackendLimitError).limitName).toBe('sub-issue depth');
	});

	it('a parent that already has 100 sub-issues is the limit error, before the write', async () => {
		for (let i = 0; i < 100; i++) fake.setParent(fake.addIssue({ title: `Sub ${i}` }), 1);
		fake.requests.length = 0;

		const error = await failure(() => t.backend.setParent('2', '1'));

		expect(error).toBeInstanceOf(BackendLimitError);
		expect((error as BackendLimitError).limit).toBe(100);
		expect(fake.writes()).toEqual([]);
	});

	it('removes the parent with a DELETE that carries the numeric id; a root task is a TaskConflictError', async () => {
		await t.backend.setParent('2', '1');
		fake.requests.length = 0;

		const detached = await t.backend.removeParent('2');

		expect(sent()).toEqual(['DELETE /issues/1/sub_issue']);
		expect(fake.writes()[0]!.body).toEqual({ sub_issue_id: fake.issues.get(2)!.id });
		expect(detached.parentId).toBeUndefined();
		const error = await failure(() => t.backend.removeParent('2'));
		expect(error).toBeInstanceOf(TaskConflictError);
		expect(error.message).toBe('Task "2" has no parent');
	});

	it('shows up in the activity of both tasks after the write', async () => {
		await t.backend.setParent('2', '1');

		const child = await t.backend.get('2');
		const parent = await t.backend.get('1');

		expect(child.activity?.map(entry => entry.kind)).toContain('parent');
		expect(parent.activity?.map(entry => entry.kind)).toContain('child-added');
	});
});

describe('blockedBy links', () => {
	beforeEach(() => seed('A', 'B', 'C'));

	it('adds and removes a dependency by the numeric id of the blocker; both sides read it', async () => {
		const linked = await t.backend.addLink('1', 'blockedBy', '2');

		expect(sent()).toEqual(['POST /issues/1/dependencies/blocked_by']);
		expect(fake.writes()[0]!.body).toEqual({ issue_id: fake.issues.get(2)!.id });
		expect(linked.links).toEqual([{ type: 'blockedBy', target: '2' }]);
		expect((await t.backend.getLinks('2')).blocks.map(task => task.id)).toEqual(['1']);

		fake.requests.length = 0;
		const unlinked = await t.backend.removeLink('1', 'blockedBy', '2');
		expect(sent()).toEqual([`DELETE /issues/1/dependencies/blocked_by/${fake.issues.get(2)!.id}`]);
		expect(unlinked.links).toBeUndefined();
	});

	it('refuses a duplicate, itself and an unknown target before the write; a cycle with the word cycle', async () => {
		await t.backend.addLink('1', 'blockedBy', '2');
		await t.backend.addLink('2', 'blockedBy', '3');
		fake.requests.length = 0;

		const duplicate = await failure(() => t.backend.addLink('1', 'blockedBy', '2'));
		const itself = await failure(() => t.backend.addLink('1', 'blockedBy', '1'));
		const unknown = await failure(() => t.backend.addLink('1', 'blockedBy', '99'));
		const direct = await failure(() => t.backend.addLink('2', 'blockedBy', '1'));
		const transitive = await failure(() => t.backend.addLink('3', 'blockedBy', '1'));

		expect(duplicate).toBeInstanceOf(TaskConflictError);
		expect(duplicate.message).toBe('Task "1" is already blockedBy "2"');
		expect(itself.message).toBe('Task "1" cannot be linked to itself');
		expect(unknown).toBeInstanceOf(TaskNotFoundError);
		for (const cycle of [direct, transitive]) {
			expect(cycle).toBeInstanceOf(TaskConflictError);
			expect(cycle.message).toContain('it would create a cycle');
		}
		expect(fake.writes().filter(request => request.status === 201)).toEqual([]);
	});

	it('removing a link that is not there is a TaskConflictError and sends nothing', async () => {
		const error = await failure(() => t.backend.removeLink('1', 'blockedBy', '2'));

		expect(error).toBeInstanceOf(TaskConflictError);
		expect(error.message).toBe('Task "1" is not blockedBy "2"');
		expect(fake.writes()).toEqual([]);
	});

	it('shows up in the activity of the task after the write', async () => {
		await t.backend.addLink('1', 'blockedBy', '2');

		expect((await t.backend.get('1')).activity).toEqual([
			expect.objectContaining({ kind: 'link-added', field: 'blockedBy', target: '2' }),
		]);
	});
});

describe('other link types', () => {
	beforeEach(() => seed('A', 'B', 'C'));

	it('causedBy has no equivalent on GitHub: UnsupportedByBackendError for linkTypes, before any request', async () => {
		const error = (await failure(() => t.backend.addLink('1', 'causedBy', '2'))) as UnsupportedByBackendError;

		expect(error).toBeInstanceOf(UnsupportedByBackendError);
		expect(error.capability).toBe('linkTypes');
		expect(error.hint).toContain('blockedBy');
		expect(fake.requests).toEqual([]);
	});

	it('an unknown link type names the type', async () => {
		const error = await failure(() => t.backend.addLink('1', 'nope' as 'blockedBy', '2'));

		expect(error.message).toContain('nope');
		expect(fake.requests).toEqual([]);
	});

	it('duplicateOf without its fill is UnsupportedByBackendError whose hint is the exact key to write', async () => {
		const error = (await failure(() => t.backend.addLink('1', 'duplicateOf', '2'))) as UnsupportedByBackendError;

		expect(error).toBeInstanceOf(UnsupportedByBackendError);
		expect(error.capability).toBe('linkTypes');
		expect(error.hint).toContain('linkTypes.duplicateOf');
		expect(error.hint).toContain('duplicate-marker');
		expect(error.hint).toContain('degrade');
		expect(fake.requests).toEqual([]);
	});

	describe('duplicateOf with fills.linkTypes.duplicateOf: duplicate-marker (degrade)', () => {
		beforeEach(() => {
			t = make({
				fidelity: 'degrade',
				fills: { 'linkTypes.duplicateOf': { use: 'duplicate-marker', fidelity: 'degrade' } },
			});
		});

		it('writes the readable marker in the managed block, then closes the issue as a duplicate of the target (numeric id)', async () => {
			fake.updateIssue(1, { body: 'Same as B' });

			const linked = await t.backend.addLink('1', 'duplicateOf', '2');

			expect(sent()).toEqual(['PATCH /issues/1', 'PATCH /issues/1']);
			expect(fake.writes()[0]!.body).toEqual({
				body: 'Same as B\n\n<!-- task:begin v1 -->{"links":[{"type":"duplicateOf","target":"2"}]}<!-- task:end -->',
			});
			expect(fake.writes()[1]!.body).toEqual({
				state: 'closed',
				state_reason: 'duplicate',
				duplicate_issue_id: fake.issues.get(2)!.id,
			});
			expect(linked.links).toEqual([{ type: 'duplicateOf', target: '2' }]);
			expect(linked.status).toBe('duplicate');
			expect(linked.description).toBe('Same as B');
		});

		it('reads both directions: the duplicate holds the link, the original lists the duplicates', async () => {
			await t.backend.addLink('1', 'duplicateOf', '2');

			expect((await t.backend.getLinks('1')).duplicateOf.map(task => task.id)).toEqual(['2']);
			expect((await t.backend.getLinks('2')).duplicates.map(task => task.id)).toEqual(['1']);
		});

		it('says that it is emulated, and that the issue was closed', async () => {
			await t.backend.addLink('1', 'duplicateOf', '2');

			const emulated = t.notices.filter(notice => notice.kind === 'emulated');
			expect(emulated).toHaveLength(1);
			expect(emulated[0]!.text).toContain('duplicate');
			expect(emulated[0]!.text).toContain('closed');
		});

		it('refuses a second target, itself, a duplicate link and a cycle with the messages of the local store', async () => {
			await t.backend.addLink('1', 'duplicateOf', '2');
			await t.backend.addLink('2', 'duplicateOf', '3');

			const second = await failure(() => t.backend.addLink('1', 'duplicateOf', '3'));
			const itself = await failure(() => t.backend.addLink('3', 'duplicateOf', '3'));
			const same = await failure(() => t.backend.addLink('1', 'duplicateOf', '2'));
			const cycle = await failure(() => t.backend.addLink('3', 'duplicateOf', '1'));

			expect(second.message).toContain('already a duplicateOf of "2"');
			expect(itself.message).toBe('Task "3" cannot be linked to itself');
			expect(same.message).toBe('Task "1" is already duplicateOf "2"');
			expect(cycle.message).toContain('it would create a cycle');
			for (const error of [second, itself, same, cycle]) expect(error).toBeInstanceOf(TaskConflictError);
		});

		it('removing the link removes the marker only; the issue stays closed, and the notice says what to do', async () => {
			await t.backend.addLink('1', 'duplicateOf', '2');
			fake.requests.length = 0;

			const unlinked = await t.backend.removeLink('1', 'duplicateOf', '2');

			expect(sent()).toEqual(['PATCH /issues/1']);
			expect(unlinked.links).toBeUndefined();
			expect(fake.issues.get(1)!.state).toBe('closed');
			expect(t.notices.map(notice => notice.text).join('\n')).toContain('task set-status');
		});

		it('needs a status that closes as a duplicate; without one it says which, before any request', async () => {
			const statuses = WRITE_STATUSES.filter(status => status.name !== 'duplicate');
			const { duplicate: _gone, ...map } = WRITE_STATUS_MAP;
			t = make({
				statuses,
				options: { statusMap: map },
				fidelity: 'degrade',
				fills: { 'linkTypes.duplicateOf': { use: 'duplicate-marker', fidelity: 'degrade' } },
			});

			const error = (await failure(() =>
				t.backend.addLink('1', 'duplicateOf', '2')
			)) as UnsupportedByBackendError;

			expect(error).toBeInstanceOf(UnsupportedByBackendError);
			expect(error.hint).toContain('reason: duplicate');
			expect(fake.writes()).toEqual([]);
		});
	});
});

describe('comments', () => {
	beforeEach(() => seed('One'));

	it('adds a trimmed comment, written by the user of the token', async () => {
		const added = await t.backend.addComment('1', '  first note  ');

		expect(sent()).toEqual(['POST /issues/1/comments']);
		expect(fake.writes()[0]!.body).toEqual({ body: 'first note' });
		expect(added.comment).toMatchObject({ text: 'first note', author: 'fake-user' });
		expect(added.task.comments).toEqual([added.comment]);
	});

	it('an author cannot be chosen: GitHub writes the comment as the token user, and the error says so', async () => {
		const error = (await failure(() =>
			t.backend.addComment('1', 'note', { author: 'ann' })
		)) as UnsupportedByBackendError;

		expect(error).toBeInstanceOf(UnsupportedByBackendError);
		expect(error.capability).toBe('comments');
		expect(error.hint).toContain('--author');
		expect(fake.writes()).toEqual([]);
	});

	it('blank and too long texts are the errors of the local store, before any request', async () => {
		expect(await failure(() => t.backend.addComment('1', '   '))).toBeInstanceOf(InvalidCommentTextError);
		expect(await failure(() => t.backend.addComment('1', 'x'.repeat(10001)))).toBeInstanceOf(
			InvalidCommentTextError
		);
		expect(fake.requests).toEqual([]);
	});

	it('edits a comment of the issue (PATCH on the comment id) and tells the old text; the same text sends nothing', async () => {
		const added = await t.backend.addComment('1', 'first');
		fake.requests.length = 0;

		const unchanged = await t.backend.editComment('1', added.comment.id, 'first');
		expect(unchanged).toMatchObject({ changed: false, oldText: 'first' });
		expect(fake.writes()).toEqual([]);

		const edited = await t.backend.editComment('1', added.comment.id, 'first, edited');
		expect(sent()).toEqual([`PATCH /issues/comments/${added.comment.id}`]);
		expect(edited).toMatchObject({ changed: true, oldText: 'first' });
		expect(edited.comment.text).toBe('first, edited');
		expect(edited.comment.editedAt).toBeTypeOf('string');
	});

	it('removes a comment (DELETE on the comment id) and returns it as it was', async () => {
		const added = await t.backend.addComment('1', 'first');
		fake.requests.length = 0;

		const removed = await t.backend.removeComment('1', added.comment.id);

		expect(sent()).toEqual([`DELETE /issues/comments/${added.comment.id}`]);
		expect(removed.comment).toEqual(added.comment);
		expect(removed.task.comments).toBeUndefined();
	});

	it('a comment id the issue does not have is CommentNotFoundError listing the ids it has, before any write', async () => {
		const added = await t.backend.addComment('1', 'first');
		fake.addIssue({ title: 'Two' });
		const foreign = fake.addComment(2, 'not on issue 1');
		fake.requests.length = 0;

		const edit = await failure(() => t.backend.editComment('1', 'zzz', 'x'));
		const remove = await failure(() => t.backend.removeComment('1', String(foreign)));

		expect(edit).toBeInstanceOf(CommentNotFoundError);
		expect((edit as CommentNotFoundError).validIds).toEqual([added.comment.id]);
		expect(remove).toBeInstanceOf(CommentNotFoundError);
		expect(fake.writes()).toEqual([]);
	});
});

describe('deleteTask', () => {
	beforeEach(() => seed('Parent', 'Child', 'Other'));

	it('by default GitHub cannot delete: UnsupportedByBackendError for delete whose hint names both fills, before any request', async () => {
		const error = (await failure(() => t.backend.deleteTask('1'))) as UnsupportedByBackendError;

		expect(error).toBeInstanceOf(UnsupportedByBackendError);
		expect(error.capability).toBe('delete');
		expect(error.hint).toContain('fills');
		expect(error.hint).toContain('delete: tombstone');
		expect(error.hint).toContain('delete: hard');
		expect(fake.requests).toEqual([]);
	});

	describe('fills.delete: tombstone (degrade)', () => {
		beforeEach(() => {
			t = make({ fidelity: 'degrade', fills: { delete: { use: 'tombstone', fidelity: 'degrade' } } });
		});

		it('creates the label, closes the issue as not planned, and only then labels it task:deleted (hidden last, so a failure can be run again)', async () => {
			const removed = await t.backend.deleteTask('1');

			expect(removed).toBe(true);
			expect(sent()).toEqual(['POST /labels', 'PATCH /issues/1', 'POST /issues/1/labels']);
			expect(fake.writes()[0]!.body).toMatchObject({ name: 'task:deleted' });
			expect(fake.writes()[1]!.body).toEqual({ state: 'closed', state_reason: 'not_planned' });
			expect(fake.issues.get(1)).toMatchObject({ state: 'closed', stateReason: 'not_planned' });
		});

		it('hides the issue from every read: list, page, get, search, labels, tree, links of the others', async () => {
			fake.setParent(2, 1);
			await t.backend.addLabel('1', 'urgent');
			await t.backend.addLink('3', 'blockedBy', '1');

			await t.backend.deleteTask('1');

			expect((await t.backend.list()).map(task => task.id)).toEqual(['2', '3']);
			expect((await t.backend.listPage()).items.map(task => task.id)).toEqual(['2', '3']);
			// By number it is still there (closed as not planned, with its label): only the lists hide it.
			expect((await t.backend.get('1')).status).toBe('cancelled');
			expect(await t.backend.listLabels()).toEqual([]);
			expect((await t.backend.getForest()).map(node => node.id)).toEqual(['2', '3']);
			expect((await t.backend.getLinks('3')).blockedBy).toEqual([]);
			expect((await t.backend.get('3')).links).toBeUndefined();
		});

		it('detaches its children (they become roots) and its own parent link', async () => {
			fake.setParent(2, 1);
			fake.setParent(1, 3);

			await t.backend.deleteTask('1');

			expect(fake.issues.get(2)!.parent).toBeNull();
			expect(fake.issues.get(1)!.parent).toBeNull();
			expect((await t.backend.get('2')).parentId).toBeUndefined();
			expect(await t.backend.getChildren('3')).toEqual([]);
		});

		it('a failure halfway says what was done and how to run it again: nothing is hidden before the closing worked', async () => {
			fake.setParent(2, 1);
			fake.failNext({ status: 422, method: 'PATCH', body: { message: 'Validation Failed' } });

			const error = (await failure(() => t.backend.deleteTask('1'))) as PartialWriteError;

			expect(error).toBeInstanceOf(PartialWriteError);
			expect(error.applied).toEqual(['detached the sub-issue #2']);
			expect(error.notApplied).toEqual(['closed the issue as not_planned', 'labelled the issue task:deleted']);
			expect(error.hint).toContain('task delete 1');
			// Still a visible, open task: the command can simply be run again.
			expect((await t.backend.list()).map(task => task.id)).toEqual(['1', '2', '3']);
			expect(await t.backend.deleteTask('1')).toBe(true);
		});

		it('a task already deleted, or unknown, is false and sends nothing', async () => {
			await t.backend.deleteTask('1');
			fake.requests.length = 0;

			expect(await t.backend.deleteTask('1')).toBe(false);
			expect(await t.backend.deleteTask('99')).toBe(false);
			expect(await t.backend.deleteTask('nope')).toBe(false);
			expect(fake.writes()).toEqual([]);
		});

		it('says it is emulated: the issue is still on GitHub, its number is used', async () => {
			await t.backend.deleteTask('1');

			const emulated = t.notices.filter(notice => notice.kind === 'emulated');
			expect(emulated).toHaveLength(1);
			expect(emulated[0]!.text).toContain('task:deleted');
			expect(emulated[0]!.text).toContain('#1');
		});
	});

	describe('fills.delete: hard', () => {
		beforeEach(() => {
			t = make({ fills: { delete: { use: 'hard', fidelity: 'strict' } } });
		});

		it('deletes with GraphQL deleteIssue on the node id of the issue; afterwards it is gone', async () => {
			const removed = await t.backend.deleteTask('1');

			expect(removed).toBe(true);
			expect(sent()).toEqual(['POST /graphql']);
			expect(JSON.stringify(fake.writes()[0]!.body)).toContain('deleteIssue');
			expect(await failure(() => t.backend.get('1'))).toBeInstanceOf(TaskNotFoundError);
			expect(await t.backend.deleteTask('1')).toBe(false);
		});

		it('without the rights of an administrator the error says so and names the other fill; the issue is untouched', async () => {
			const restricted = await FakeGitHub.start({ repo: 'acme/shop', admin: false });
			try {
				restricted.addIssue({ title: 'Mine' });
				const own = makeGitHubBackend(restricted, {
					statuses: WRITE_STATUSES,
					options: { statusMap: WRITE_STATUS_MAP },
					fills: { delete: { use: 'hard', fidelity: 'strict' } },
				});

				const error = (await failure(() => own.backend.deleteTask('1'))) as BackendAuthError;

				expect(error).toBeInstanceOf(BackendAuthError);
				expect(error.reason).toBe('forbidden');
				expect(error.hint).toContain('administrator');
				expect(error.hint).toContain('delete: tombstone');
				expect(restricted.issues.get(1)!.deleted).toBe(false);
			} finally {
				await restricted.stop();
			}
		});
	});
});
