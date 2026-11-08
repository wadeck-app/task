import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EventSink } from '@wadeck-app/task-service';

import { setup, STATUSES_YML, type Harness } from './routeHarness.js';

// Comments: GET/POST /tasks/:id/comments, PATCH/DELETE /tasks/:id/comments/:commentId.
let h: Harness;
let project: string;
let projectDir: string;
let id: string;

beforeEach(async () => {
	h = setup();
	project = await h.world.createProject('alpha', { configYml: STATUSES_YML });
	projectDir = h.world.dirOf(project);
	const created = await h.call('POST /tasks', { query: { project }, body: { description: 'task' } });
	id = created.body['task'].id as string;
	h.sink.events.length = 0;
});
afterEach(() => h.world.cleanup());

const env = () => ({ taskProjectId: project, taskProjectName: 'alpha', taskProjectPath: projectDir });
const query = (extra: Record<string, unknown> = {}) => ({ project, ...extra });

async function addComment(text: string, author?: string): Promise<string> {
	const answer = await h.call('POST /tasks/:id/comments', {
		params: { id },
		query: query(),
		body: { text, ...(author === undefined ? {} : { author }) },
	});
	expect(answer.status).toBe(201);
	h.sink.events.length = 0;
	return answer.body['comment'].id as string;
}

describe('route table', () => {
	it('registers the four comment routes', () => {
		for (const route of [
			'GET /tasks/:id/comments',
			'POST /tasks/:id/comments',
			'PATCH /tasks/:id/comments/:commentId',
			'DELETE /tasks/:id/comments/:commentId',
		]) {
			expect(h.routes.has(route), route).toBe(true);
		}
	});
});

describe('POST /tasks/:id/comments', () => {
	it('adds the comment (201), emits onTaskCommentAdded with the full text, and answers like the other mutations', async () => {
		const text = `${'long words '.repeat(80)}end\nsecond line`;

		const answer = await h.call('POST /tasks/:id/comments', {
			params: { id: id.slice(0, 8) },
			query: query(),
			body: { text, author: 'alice' },
		});

		expect(answer.status).toBe(201);
		expect(answer.body['taskId']).toBe(id);
		expect(answer.body['comment']).toMatchObject({ text: text.trim(), author: 'alice' });
		expect(answer.body['comment'].id).toMatch(/^[0-9a-z]{6}$/);
		expect(answer.body['commentCount']).toBe(1);
		expect(answer.body['undelivered']).toEqual([]);
		expect(answer.body['undeliveredText']).toBeNull();
		expect(h.sink.events).toEqual([
			{
				name: 'onTaskCommentAdded',
				payload: {
					taskId: id,
					commentId: answer.body['comment'].id,
					text: text.trim(),
					author: 'alice',
					...env(),
				},
			},
		]);
	});

	it('author is optional and absent from the comment when not given or blank', async () => {
		const first = await h.call('POST /tasks/:id/comments', { params: { id }, query: query(), body: { text: 'a' } });
		const second = await h.call('POST /tasks/:id/comments', {
			params: { id },
			query: query(),
			body: { text: 'b', author: '  ' },
		});

		expect(first.body['comment']).not.toHaveProperty('author');
		expect(second.body['comment']).not.toHaveProperty('author');
		expect(second.body['commentCount']).toBe(2);
	});

	it('reports the events the queue did not get, the comment is saved', async () => {
		const unreachable: EventSink = { deliver: () => Promise.resolve({ delivered: false, reason: 'exit 3' }) };
		const failing = setup(unreachable);
		try {
			const dir = await failing.world.createProject('beta');
			const created = await failing.call('POST /tasks', { query: { project: dir }, body: { description: 'a' } });
			const taskId = created.body['task'].id as string;
			const params = { id: taskId };

			const added = await failing.call('POST /tasks/:id/comments', {
				params,
				query: { project: dir },
				body: { text: 'a' },
			});
			const commentId = added.body['comment'].id as string;
			const edited = await failing.call('PATCH /tasks/:id/comments/:commentId', {
				params: { ...params, commentId },
				query: { project: dir },
				body: { text: 'b' },
			});
			const removed = await failing.call('DELETE /tasks/:id/comments/:commentId', {
				params: { ...params, commentId },
				query: { project: dir },
			});

			expect(added.status).toBe(201);
			expect(added.body['undelivered']).toMatchObject([{ event: 'onTaskCommentAdded', reason: 'exit 3' }]);
			expect(added.body['undeliveredText']).toContain('onTaskCommentAdded');
			expect(edited.body['undeliveredText']).toContain('onTaskCommentEdited');
			expect(removed.body['undeliveredText']).toContain('onTaskCommentRemoved');
		} finally {
			failing.world.cleanup();
		}
	});

	it.each([
		['no body', undefined, /JSON object body/],
		['no text', {}, /text/],
		['a text that is not a string', { text: 3 }, /text/],
		['a blank text', { text: '   ' }, /blank/],
		['an author that is not a string', { text: 'x', author: 5 }, /author/],
	])('400 for %s, nothing saved, no event', async (_label, body, message) => {
		const answer = await h.call('POST /tasks/:id/comments', { params: { id }, query: query(), body });

		expect(answer.status).toBe(400);
		expect(String(answer.body['error'])).toMatch(message);
		expect(h.sink.events).toEqual([]);
		const list = await h.call('GET /tasks/:id/comments', { params: { id }, query: query() });
		expect(list.body['commentCount']).toBe(0);
	});

	it('400 for a text over 10000 characters, the hint names the limit', async () => {
		const answer = await h.call('POST /tasks/:id/comments', {
			params: { id },
			query: query(),
			body: { text: 'x'.repeat(10001) },
		});

		expect(answer.status).toBe(400);
		expect(answer.body['error']).toContain('10000');
		expect(answer.body['hint']).toContain('10000');
	});

	it('404 for an unknown task, and for an unknown project', async () => {
		const unknownTask = await h.call('POST /tasks/:id/comments', {
			params: { id: 'zzzzzz' },
			query: query(),
			body: { text: 'a' },
		});
		const unknownProject = await h.call('POST /tasks/:id/comments', {
			params: { id },
			query: { project: 'other' },
			body: { text: 'a' },
		});

		expect(unknownTask.status).toBe(404);
		expect(unknownProject.status).toBe(404);
	});

	it('inlineErrors answers a failure as 200 with failed, httpStatus and errorText', async () => {
		const answer = await h.call('POST /tasks/:id/comments', {
			params: { id },
			query: query({ inlineErrors: 'true' }),
			body: { text: ' ' },
		});

		expect(answer.status).toBe(200);
		expect(answer.body).toMatchObject({ failed: true, httpStatus: 400 });
		expect(answer.body['errorText']).toContain('blank');
	});
});

describe('GET /tasks/:id/comments', () => {
	it('lists the comments oldest first with display fields, count and flags', async () => {
		const first = await addComment('first', 'alice');
		const second = await addComment('second\nline');

		const answer = await h.call('GET /tasks/:id/comments', { params: { id: id.slice(0, 4) }, query: query() });

		expect(answer.status).toBe(200);
		expect(answer.body['id']).toBe(id);
		expect(answer.body['project']).toEqual({ id: project, name: 'alpha', path: projectDir });
		expect(answer.body['commentCount']).toBe(2);
		expect(answer.body['hasComments']).toBe(true);
		expect(answer.body['noComments']).toBe(false);
		const rows = answer.body['comments'] as Array<Record<string, unknown>>;
		expect(rows.map(r => r['id'])).toEqual([first, second]);
		expect(rows[0]).toMatchObject({ text: 'first', author: 'alice', edited: false });
		expect(rows[0]!['at']).toMatch(/^\d{4}-\d\d-\d\dT/);
		expect(rows[0]!['atText']).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
		expect(rows[1]).toMatchObject({ text: 'second\nline' });
		expect(rows[1]).not.toHaveProperty('author');
	});

	it('an edited comment carries editedAt and edited: true', async () => {
		const commentId = await addComment('old');
		await h.call('PATCH /tasks/:id/comments/:commentId', {
			params: { id, commentId },
			query: query(),
			body: { text: 'new' },
		});

		const rows = (await h.call('GET /tasks/:id/comments', { params: { id }, query: query() })).body['comments'];

		expect(rows[0]).toMatchObject({ text: 'new', edited: true });
		expect(rows[0].editedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
		expect(rows[0].editedText).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
	});

	it('a task without comments: empty list, noComments true', async () => {
		const answer = await h.call('GET /tasks/:id/comments', { params: { id }, query: query() });

		expect(answer.body).toMatchObject({ comments: [], commentCount: 0, hasComments: false, noComments: true });
	});

	it('?blank=true answers {blank: true}, a read emits nothing', async () => {
		const answer = await h.call('GET /tasks/:id/comments', { params: { id }, query: query({ blank: 'true' }) });

		expect(answer).toEqual({ status: 200, body: { blank: true } });
		expect(h.sink.events).toEqual([]);
	});

	it('404 for an unknown task', async () => {
		expect((await h.call('GET /tasks/:id/comments', { params: { id: 'zzzzzz' }, query: query() })).status).toBe(
			404
		);
	});
});

describe('PATCH /tasks/:id/comments/:commentId', () => {
	it('edits the text, emits onTaskCommentEdited with both full texts', async () => {
		const commentId = await addComment('old text');

		const answer = await h.call('PATCH /tasks/:id/comments/:commentId', {
			params: { id, commentId },
			query: query(),
			body: { text: 'new text' },
		});

		expect(answer.status).toBe(200);
		expect(answer.body).toMatchObject({ taskId: id, changed: true, commentCount: 1, undelivered: [] });
		expect(answer.body['comment']).toMatchObject({ id: commentId, text: 'new text' });
		expect(answer.body['comment'].editedAt).toBeDefined();
		expect(h.sink.events).toEqual([
			{
				name: 'onTaskCommentEdited',
				payload: { taskId: id, commentId, oldText: 'old text', newText: 'new text', ...env() },
			},
		]);
	});

	it('the same text answers changed: false and emits nothing', async () => {
		const commentId = await addComment('same');

		const answer = await h.call('PATCH /tasks/:id/comments/:commentId', {
			params: { id, commentId },
			query: query(),
			body: { text: ' same ' },
		});

		expect(answer.status).toBe(200);
		expect(answer.body['changed']).toBe(false);
		expect(h.sink.events).toEqual([]);
	});

	it('404 for an unknown comment id, the hint lists the valid ones', async () => {
		const commentId = await addComment('a');

		const answer = await h.call('PATCH /tasks/:id/comments/:commentId', {
			params: { id, commentId: 'nope00' },
			query: query(),
			body: { text: 'x' },
		});

		expect(answer.status).toBe(404);
		expect(answer.body['error']).toContain('nope00');
		expect(answer.body['hint']).toContain(commentId);
		expect(answer.body['validIds']).toEqual([commentId]);
	});

	it('400 for a blank or missing text', async () => {
		const commentId = await addComment('a');

		for (const body of [{ text: '  ' }, {}, undefined]) {
			const answer = await h.call('PATCH /tasks/:id/comments/:commentId', {
				params: { id, commentId },
				query: query(),
				body,
			});
			expect(answer.status).toBe(400);
		}
	});
});

describe('DELETE /tasks/:id/comments/:commentId', () => {
	it('removes it, emits onTaskCommentRemoved, answers the removed comment and the new count', async () => {
		const first = await addComment('a');
		await addComment('b');

		const answer = await h.call('DELETE /tasks/:id/comments/:commentId', {
			params: { id, commentId: first },
			query: query(),
		});

		expect(answer.status).toBe(200);
		expect(answer.body).toMatchObject({ taskId: id, commentCount: 1, undelivered: [] });
		expect(answer.body['comment']).toMatchObject({ id: first, text: 'a' });
		expect(h.sink.events).toEqual([
			{ name: 'onTaskCommentRemoved', payload: { taskId: id, commentId: first, ...env() } },
		]);
	});

	it('404 for an unknown comment id, no event', async () => {
		const answer = await h.call('DELETE /tasks/:id/comments/:commentId', {
			params: { id, commentId: 'nope00' },
			query: query(),
		});

		expect(answer.status).toBe(404);
		expect(h.sink.events).toEqual([]);
	});
});

describe('every comment route resolves the project first', () => {
	it('answers 404 for an unknown project', async () => {
		const calls: Array<[string, Record<string, string>, unknown]> = [
			['GET /tasks/:id/comments', { id: 'x' }, undefined],
			['POST /tasks/:id/comments', { id: 'x' }, { text: 'a' }],
			['PATCH /tasks/:id/comments/:commentId', { id: 'x', commentId: 'abcdef' }, { text: 'a' }],
			['DELETE /tasks/:id/comments/:commentId', { id: 'x', commentId: 'abcdef' }, undefined],
		];
		for (const [route, params, body] of calls) {
			const answer = await h.call(route, { params, query: { project: 'other' }, body });
			expect(answer.status, route).toBe(404);
		}
	});
});

describe('the detail and the activity feed carry the comments', () => {
	it('GET /tasks/:id has commentCount and hasComments', async () => {
		const empty = await h.call('GET /tasks/:id', { params: { id }, query: query() });
		expect(empty.body).toMatchObject({ commentCount: 0, hasComments: false });

		await addComment('a');
		const filled = await h.call('GET /tasks/:id', { params: { id }, query: query() });
		expect(filled.body).toMatchObject({ commentCount: 1, hasComments: true });
	});

	it('GET /tasks/:id/activity lists the comment with its FULL text, filters and counts include comments', async () => {
		const text = `${'word '.repeat(120)}end`;
		const commentId = await addComment(text, 'alice');

		const all = await h.call('GET /tasks/:id/activity', { params: { id }, query: query() });
		expect(all.body['filters']).toEqual(['all', 'comments', 'history']);
		expect(all.body['counts']).toEqual({ all: 2, comments: 1, history: 1 });
		const row = (all.body['rows'] as Array<Record<string, unknown>>).find(r => r['kind'] === 'comment');
		expect(row).toMatchObject({
			text: text.trim(),
			commentId,
			actor: 'alice',
			source: 'comments',
			icon: 'message-square',
		});

		const only = await h.call('GET /tasks/:id/activity', { params: { id }, query: query({ filter: 'comments' }) });
		expect((only.body['rows'] as unknown[]).length).toBe(1);
		expect(only.body['filter']).toBe('comments');

		const history = await h.call('GET /tasks/:id/activity', {
			params: { id },
			query: query({ filter: 'history' }),
		});
		expect((history.body['rows'] as Array<{ kind: string }>).map(r => r.kind)).toEqual(['created']);
	});

	it('an edit and a removal appear as their own rows, in the all list', async () => {
		const commentId = await addComment('old');
		await h.call('PATCH /tasks/:id/comments/:commentId', {
			params: { id, commentId },
			query: query(),
			body: { text: 'new' },
		});
		await h.call('DELETE /tasks/:id/comments/:commentId', { params: { id, commentId }, query: query() });

		const all = await h.call('GET /tasks/:id/activity', { params: { id }, query: query() });

		const kinds = (all.body['rows'] as Array<{ kind: string }>).map(r => r.kind);
		expect(kinds).toContain('comment-edited');
		expect(kinds).toContain('comment-removed');
		expect(kinds).not.toContain('comment');
	});

	it('the detail Timeline entry of a comment is titled as a comment, the text is its detail', async () => {
		await addComment('please check the logs', 'alice');

		const detail = await h.call('GET /tasks/:id', { params: { id }, query: query() });

		const entry = (detail.body['activity'] as Array<Record<string, unknown>>).find(
			e => e['activityKind'] === 'comment'
		);
		expect(entry).toMatchObject({ title: 'Comment by alice', detail: 'please check the logs' });
	});
});
