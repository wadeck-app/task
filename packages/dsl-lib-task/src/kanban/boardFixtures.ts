import type { BoardColumnData, BoardLayoutData } from './boardModel.js';

/** A small three-column board used by the tests (and only by them): one status per column, as a project without a `board` key. */
export function sampleColumns(): BoardColumnData[] {
	return [
		{
			key: 'todo',
			label: 'To do',
			tone: 'neutral',
			terminal: false,
			statuses: [{ name: 'todo', tone: 'neutral', terminal: false, count: 2 }],
			count: 2,
			hiddenCount: 0,
			cards: [
				{
					id: 'aaa11111',
					headline: 'Write the spec',
					href: '/modules/task/tasks/p/p1/aaa11111',
					priority: 'high',
					priorityText: 'High',
					assignee: 'ann',
					type: 'bug',
					labels: ['billing', 'ui', 'api', 'docs'],
					status: 'todo',
					tone: 'neutral',
					updatedAt: '2026-11-14T10:00:00.000Z',
				},
				{
					id: 'bbb22222',
					headline: 'Plan the release',
					href: '/modules/task/tasks/p/p1/bbb22222',
					status: 'todo',
					tone: 'neutral',
					updatedAt: '2026-11-14T09:00:00.000Z',
				},
			],
		},
		{
			key: 'doing',
			label: 'In progress',
			tone: 'info',
			terminal: false,
			statuses: [{ name: 'doing', tone: 'info', terminal: false, count: 1 }],
			count: 1,
			hiddenCount: 0,
			cards: [
				{
					id: 'ccc33333',
					headline: 'Build it',
					href: '/modules/task/tasks/p/p1/ccc33333',
					priority: 'urgent',
					priorityText: 'Urgent',
					status: 'doing',
					tone: 'info',
					updatedAt: '2026-11-14T11:00:00.000Z',
				},
			],
		},
		{
			key: 'done',
			label: 'Done',
			tone: 'success',
			terminal: true,
			outcome: 'positive',
			statuses: [{ name: 'done', tone: 'success', terminal: true, outcome: 'positive', count: 5 }],
			count: 5,
			hiddenCount: 4,
			cards: [
				{
					id: 'ddd44444',
					headline: 'Ship v1',
					href: '/modules/task/tasks/p/p1/ddd44444',
					priority: 'medium',
					priorityText: 'Medium',
					status: 'done',
					tone: 'success',
					updatedAt: '2026-11-13T11:00:00.000Z',
				},
			],
		},
	];
}

/**
 * A board whose columns GROUP statuses: "To do" holds `todo`, "Doing" holds `doing` and `review`, "Closed" holds `done` and
 * `rejected`; `parked` is in no column, so it is not on the board (the answer's `hiddenNote` counts its tasks).
 */
export function groupedColumns(): BoardColumnData[] {
	return [
		{
			key: 'To do',
			label: 'To do',
			tone: 'neutral',
			terminal: false,
			statuses: [{ name: 'todo', tone: 'neutral', terminal: false, count: 1 }],
			count: 1,
			hiddenCount: 0,
			cards: [
				{ id: 'aaa11111', headline: 'Write the spec', href: '/t/aaa11111', status: 'todo', tone: 'neutral' },
			],
		},
		{
			key: 'Doing',
			label: 'Doing',
			tone: 'neutral',
			terminal: false,
			statuses: [
				{ name: 'doing', tone: 'info', terminal: false, count: 1 },
				{ name: 'review', tone: 'warning', terminal: false, count: 1 },
			],
			count: 2,
			hiddenCount: 0,
			cards: [
				{ id: 'ccc33333', headline: 'Build it', href: '/t/ccc33333', status: 'doing', tone: 'info' },
				{ id: 'eee55555', headline: 'Check it', href: '/t/eee55555', status: 'review', tone: 'warning' },
			],
		},
		{
			key: 'Closed',
			label: 'Closed',
			tone: 'neutral',
			terminal: true,
			statuses: [
				{ name: 'done', tone: 'success', terminal: true, outcome: 'positive', count: 1 },
				{ name: 'rejected', tone: 'danger', terminal: true, outcome: 'negative', count: 0 },
			],
			count: 1,
			hiddenCount: 0,
			cards: [{ id: 'ddd44444', headline: 'Ship v1', href: '/t/ddd44444', status: 'done', tone: 'success' }],
		},
	];
}

/** The layout answer (`config` and `allStatuses` of the board) that goes with {@link groupedColumns}. */
export function groupedLayout(): BoardLayoutData {
	return {
		isDefault: false,
		columns: [
			{ name: 'To do', statuses: ['todo'] },
			{ name: 'Doing', statuses: ['doing', 'review'] },
			{ name: 'Closed', statuses: ['done', 'rejected'] },
		],
		allStatuses: [
			{ name: 'todo', tone: 'neutral' },
			{ name: 'doing', tone: 'info' },
			{ name: 'review', tone: 'warning' },
			{ name: 'done', tone: 'success' },
			{ name: 'rejected', tone: 'danger' },
			{ name: 'parked', tone: 'neutral' },
		],
	};
}

/**
 * {@link groupedColumns} with sorts: "Doing" is sorted by assignee (cards carry `group`: two of ann, one of bob), "Closed" by newest
 * (no group), "To do" has no sort.
 */
export function sortedColumns(): BoardColumnData[] {
	return groupedColumns().map(column => {
		if (column.key === 'Doing') {
			return {
				...column,
				sort: 'assignee',
				count: 3,
				cards: [
					{
						id: 'ccc33333',
						headline: 'Build it',
						href: '/t/ccc33333',
						status: 'doing',
						tone: 'info',
						assignee: 'ann',
						group: 'ann',
					},
					{
						id: 'eee55555',
						headline: 'Check it',
						href: '/t/eee55555',
						status: 'review',
						tone: 'warning',
						assignee: 'ann',
						group: 'ann',
					},
					{
						id: 'fff66666',
						headline: 'Test it',
						href: '/t/fff66666',
						status: 'doing',
						tone: 'info',
						assignee: 'bob',
						group: 'bob',
					},
				],
			};
		}
		if (column.key === 'Closed') {
			return { ...column, sort: 'newest' };
		}
		return column;
	});
}

/** The layout answer that goes with {@link sortedColumns}. */
export function sortedLayout(): BoardLayoutData {
	const base = groupedLayout();
	return {
		...base,
		columns: [
			{ name: 'To do', statuses: ['todo'] },
			{ name: 'Doing', statuses: ['doing', 'review'], sort: 'assignee' },
			{ name: 'Closed', statuses: ['done', 'rejected'], sort: 'newest' },
		],
	};
}
