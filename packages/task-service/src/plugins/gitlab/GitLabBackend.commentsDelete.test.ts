// Comments (notes) and deletion of the gitlab backend over the fake server. The fake is modelled on docs.gitlab.com.
import {
	BackendAuthError,
	CommentNotFoundError,
	InvalidCommentTextError,
	TaskNotFoundError,
	UnsupportedByBackendError,
} from '@wadeck-app/task-core';

import type { DeclaredFills } from '../kinds.js';
import { FakeGitLab } from './fakeGitLab.testkit.js';
import { WRITE_STATUSES, makeGitLabBackend, writeStatusMap } from './gitlabBackend.testkit.js';
import type { TestBackend } from './gitlabBackend.testkit.js';

let fake: FakeGitLab;
let t: TestBackend;

const P = '/projects/42';

async function start(fills: DeclaredFills = {}, canDelete = true) {
	fake = await FakeGitLab.start({ canDelete });
	t = makeGitLabBackend(fake, {
		statuses: WRITE_STATUSES,
		options: { statusMap: writeStatusMap() },
		fills,
	});
}

beforeEach(() => start());

afterEach(async () => {
	await fake.stop();
});

// (a GraphQL read is a POST too: it is not a change)
const sent = (): string[] =>
	fake
		.writes()
		.filter(request => request.path !== '/api/graphql')
		.map(request => `${request.method} ${request.path.replace(P, '')}`);

const failure = async (call: () => Promise<unknown>): Promise<Error> => {
	try {
		await call();
	} catch (error) {
		return error as Error;
	}
	throw new Error('expected a failure');
};

describe('comments', () => {
	it('adds a note with one POST, and the comment carries the token user, not an author chosen by the caller', async () => {
		await t.backend.create({ title: 'T', status: 'backlog' });
		fake.requests.length = 0;

		const { comment, task } = await t.backend.addComment('1', '  first note  ');

		expect(sent()).toEqual(['POST /issues/1/notes']);
		expect(fake.writes()[0]!.body).toEqual({ body: 'first note' });
		expect(comment).toMatchObject({ text: 'first note', author: 'tester' });
		expect(task.comments?.map(entry => entry.text)).toEqual(['first note']);
	});

	it('refuses an author (the token user writes it) and a blank text before any request', async () => {
		await t.backend.create({ title: 'T', status: 'backlog' });
		fake.requests.length = 0;

		const author = await failure(() => t.backend.addComment('1', 'x', { author: 'ann' }));
		const blank = await failure(() => t.backend.addComment('1', '   '));

		expect(author).toBeInstanceOf(UnsupportedByBackendError);
		expect((author as UnsupportedByBackendError).capability).toBe('comments');
		expect(blank).toBeInstanceOf(InvalidCommentTextError);
		expect(fake.requests).toEqual([]);
	});

	it('never shows the system notes (title, description, type) as comments; label and state changes write none on GitLab', async () => {
		await t.backend.create({ title: 'T', status: 'backlog' });
		await t.backend.updateStatus('1', 'in-progress');
		await t.backend.updateStatus('1', 'done');
		// VERIFIED-LIVE: label and state changes are events, not notes.
		expect(fake.systemNotes(1)).toEqual([]);
		await t.backend.setTitle('1', 'T renamed');
		await t.backend.setDescription('1', 'a body');
		await t.backend.addComment('1', 'only me');

		const notes = fake.systemNotes(1).map(note => note.body);
		expect(notes).toHaveLength(2);
		expect(notes[0]).toContain('changed title from');
		expect(notes[1]).toBe('changed the description');
		const record = await t.backend.get('1');
		expect(record.comments?.map(entry => entry.text)).toEqual(['only me']);
		expect(record.comments?.map(entry => entry.text).join(' ')).not.toContain('changed');
	});

	it('edits with a PUT on the note, reports the old text, and sends nothing for the same text', async () => {
		await t.backend.create({ title: 'T', status: 'backlog' });
		const { comment } = await t.backend.addComment('1', 'before');
		fake.requests.length = 0;

		const same = await t.backend.editComment('1', comment.id, 'before');
		const edited = await t.backend.editComment('1', comment.id, 'after');

		expect(same.changed).toBe(false);
		expect(edited).toMatchObject({ changed: true, oldText: 'before' });
		expect(edited.comment.text).toBe('after');
		expect(sent()).toEqual([`PUT /issues/1/notes/${comment.id}`]);
	});

	it('removes with a DELETE and refuses an id that is not a user note of that issue, listing the ones that are', async () => {
		await t.backend.create({ title: 'T', status: 'backlog' });
		await t.backend.create({ title: 'U', status: 'backlog' });
		const mine = (await t.backend.addComment('1', 'one')).comment;
		const other = (await t.backend.addComment('2', 'elsewhere')).comment;
		const system = fake.systemNotes(1)[0];
		fake.requests.length = 0;

		const wrongIssue = (await failure(() => t.backend.removeComment('1', other.id))) as CommentNotFoundError;
		expect(wrongIssue).toBeInstanceOf(CommentNotFoundError);
		expect(wrongIssue.validIds).toEqual([mine.id]);
		if (system !== undefined) {
			expect(await failure(() => t.backend.editComment('1', String(system.id), 'x'))).toBeInstanceOf(
				CommentNotFoundError
			);
		}
		expect(fake.writes()).toEqual([]);

		const removed = await t.backend.removeComment('1', mine.id);
		expect(removed.comment.text).toBe('one');
		expect(removed.task.comments).toBeUndefined();
		expect(sent()).toEqual([`DELETE /issues/1/notes/${mine.id}`]);
	});
});

describe('delete', () => {
	it('is refused without a fill, naming both fills', async () => {
		await t.backend.create({ title: 'T', status: 'backlog' });
		fake.requests.length = 0;

		const error = await failure(() => t.backend.deleteTask('1'));

		expect(error).toBeInstanceOf(UnsupportedByBackendError);
		expect((error as UnsupportedByBackendError).capability).toBe('delete');
		expect((error as UnsupportedByBackendError).hint).toContain('delete: hard');
		expect((error as UnsupportedByBackendError).hint).toContain('delete: tombstone');
		expect(fake.requests).toEqual([]);
	});

	it('hard: DELETE the issue (204), then it is gone; an unknown number is false', async () => {
		await fake.stop();
		await start({ delete: { use: 'hard', fidelity: 'strict' } });
		await t.backend.create({ title: 'T', status: 'backlog' });
		fake.requests.length = 0;

		expect(await t.backend.deleteTask('1')).toBe(true);
		expect(sent()).toEqual(['DELETE /issues/1']);
		expect(await failure(() => t.backend.get('1'))).toBeInstanceOf(TaskNotFoundError);
		expect(await t.backend.deleteTask('1')).toBe(false);
		expect(await t.backend.deleteTask('99')).toBe(false);
	});

	it('hard without the role (403) is a BackendAuthError whose hint names the tombstone fill', async () => {
		await fake.stop();
		await start({ delete: { use: 'hard', fidelity: 'strict' } }, false);
		await t.backend.create({ title: 'T', status: 'backlog' });

		const error = await failure(() => t.backend.deleteTask('1'));

		expect(error).toBeInstanceOf(BackendAuthError);
		expect((error as BackendAuthError).hint).toContain('Planner or Owner');
		expect((error as BackendAuthError).hint).toContain('delete: tombstone');
		expect(fake.issue(1)).toBeDefined();
	});

	it('tombstone: ONE PUT closes and labels the issue, it vanishes from every read but is still there by number, with a warning', async () => {
		await fake.stop();
		await start({ delete: { use: 'tombstone', fidelity: 'degrade' } });
		await t.backend.create({ title: 'Gone', status: 'in-progress' });
		await t.backend.create({ title: 'Stays', status: 'backlog' });
		fake.requests.length = 0;

		expect(await t.backend.deleteTask('1')).toBe(true);

		expect(sent()).toEqual(['PUT /issues/1']);
		expect(fake.writes().find(request => request.method === 'PUT')!.body).toEqual({
			state_event: 'close',
			add_labels: 'task:deleted',
		});
		expect((await t.backend.list()).map(task => task.id)).toEqual(['2']);
		expect((await t.backend.listPage()).items.map(task => task.id)).toEqual(['2']);
		expect(await t.backend.listLabels()).toEqual([]);
		expect(fake.issue(1)).toBeDefined();
		expect(t.notices.some(notice => notice.kind === 'emulated' && notice.text.includes('still on GitLab'))).toBe(
			true
		);
		// deleting it again is "already gone"
		expect(await t.backend.deleteTask('1')).toBe(false);
	});
});
