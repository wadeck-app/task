import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { COMMENT_AUTHOR_MAX, COMMENT_TEXT_MAX } from '../taskComments';
import { createLocalBackend } from './LocalFileBackend';
import { LOCAL_TRAITS } from './traits';

describe('LOCAL_TRAITS', () => {
	it('says what the local store keeps and where its limits are', () => {
		expect(LOCAL_TRAITS.keepsCreatedAt).toBe(true);
		expect(LOCAL_TRAITS.authoredComments).toBe(true);
		expect(LOCAL_TRAITS.commentTextMax).toBe(COMMENT_TEXT_MAX);
		expect(LOCAL_TRAITS.commentAuthorMax).toBe(COMMENT_AUTHOR_MAX);
		expect(LOCAL_TRAITS.labelProblem).toBeUndefined();
	});
});

describe('create with a creation instant (what a migration carries over)', () => {
	let root: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-backend-contract-'));
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('stores the given createdAt, in the record, the index and the first history entry', async () => {
		const backend = createLocalBackend(path.join(root, 'data', 'tasks'));

		const created = await backend.create({
			title: 'Old task',
			status: 'backlog',
			createdAt: '2024-03-01T10:00:00.000Z',
		});

		expect(created.createdAt).toBe('2024-03-01T10:00:00.000Z');
		expect(created.history).toEqual([{ status: 'backlog', timestamp: '2024-03-01T10:00:00.000Z' }]);
		expect((await backend.list())[0]!.createdAt).toBe('2024-03-01T10:00:00.000Z');
	});

	it('refuses an instant that is not an ISO date, naming it', async () => {
		const backend = createLocalBackend(path.join(root, 'data', 'tasks'));

		await expect(backend.create({ title: 'x', status: 'backlog', createdAt: 'yesterday' })).rejects.toThrow(
			/createdAt "yesterday" is not an ISO 8601 instant/
		);
	});

	it('uses the current time without it', async () => {
		const backend = createLocalBackend(path.join(root, 'data', 'tasks'));
		const before = Date.now();

		const created = await backend.create({ title: 'x', status: 'backlog' });

		expect(Date.parse(created.createdAt)).toBeGreaterThanOrEqual(before);
	});
});
