import { describe, expect, it } from 'vitest';

import { diffHistoryEntries, diffTaskListSnapshot } from './HistoryFollower';

describe('diffTaskListSnapshot', () => {
	it('reports every task as changed against an empty snapshot', () => {
		const current = [{ id: 'a', title: 'Task A', status: 'backlog', createdAt: '2026-01-01T00:00:00.000Z' }];
		const { changed, snapshot } = diffTaskListSnapshot(new Map(), current);

		expect(changed).toEqual(current);
		expect(snapshot.get('a')).toBe(JSON.stringify(current[0]));
	});

	it('does not report unchanged tasks', () => {
		const current = [{ id: 'a', title: 'Task A', status: 'backlog', createdAt: '2026-01-01T00:00:00.000Z' }];
		const first = diffTaskListSnapshot(new Map(), current);
		const second = diffTaskListSnapshot(first.snapshot, current);

		expect(second.changed).toEqual([]);
	});

	it('reports a status change as changed, not just new ids', () => {
		const before = [{ id: 'a', title: 'Task A', status: 'backlog', createdAt: '2026-01-01T00:00:00.000Z' }];
		const after = [{ id: 'a', title: 'Task A', status: 'in-progress', createdAt: '2026-01-01T00:00:00.000Z' }];

		const first = diffTaskListSnapshot(new Map(), before);
		const second = diffTaskListSnapshot(first.snapshot, after);

		expect(second.changed).toEqual(after);
	});

	it('reports newly added tasks alongside unchanged ones', () => {
		const before = [{ id: 'a', title: 'Task A', status: 'backlog', createdAt: '2026-01-01T00:00:00.000Z' }];
		const after = [
			...before,
			{ id: 'b', title: 'Task B', status: 'backlog', createdAt: '2026-01-01T00:00:01.000Z' },
		];

		const first = diffTaskListSnapshot(new Map(), before);
		const second = diffTaskListSnapshot(first.snapshot, after);

		expect(second.changed).toEqual([after[1]]);
	});
});

describe('diffHistoryEntries', () => {
	it('reports every entry as changed against a zero count', () => {
		const current = [{ status: 'backlog', timestamp: '2026-01-01T00:00:00.000Z' }];
		const { changed, count } = diffHistoryEntries(0, current);

		expect(changed).toEqual(current);
		expect(count).toBe(1);
	});

	it('reports only entries appended after the previous count', () => {
		const current = [
			{ status: 'backlog', timestamp: '2026-01-01T00:00:00.000Z' },
			{ status: 'in-progress', timestamp: '2026-01-01T00:00:01.000Z' },
		];
		const { changed, count } = diffHistoryEntries(1, current);

		expect(changed).toEqual([current[1]]);
		expect(count).toBe(2);
	});

	it('reports nothing new when the count is unchanged', () => {
		const current = [{ status: 'backlog', timestamp: '2026-01-01T00:00:00.000Z' }];
		const { changed } = diffHistoryEntries(1, current);

		expect(changed).toEqual([]);
	});
});
