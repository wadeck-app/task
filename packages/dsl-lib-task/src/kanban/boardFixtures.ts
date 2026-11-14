import type { BoardColumnData } from './boardModel.js';

/** A small three-column board used by the tests (and only by them). */
export function sampleColumns(): BoardColumnData[] {
	return [
		{
			status: 'todo',
			label: 'To do',
			tone: 'neutral',
			terminal: false,
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
					tone: 'neutral',
					updatedAt: '2026-11-14T10:00:00.000Z',
				},
				{
					id: 'bbb22222',
					headline: 'Plan the release',
					href: '/modules/task/tasks/p/p1/bbb22222',
					tone: 'neutral',
					updatedAt: '2026-11-14T09:00:00.000Z',
				},
			],
		},
		{
			status: 'doing',
			label: 'In progress',
			tone: 'info',
			terminal: false,
			count: 1,
			hiddenCount: 0,
			cards: [
				{
					id: 'ccc33333',
					headline: 'Build it',
					href: '/modules/task/tasks/p/p1/ccc33333',
					priority: 'urgent',
					priorityText: 'Urgent',
					tone: 'info',
					updatedAt: '2026-11-14T11:00:00.000Z',
				},
			],
		},
		{
			status: 'done',
			label: 'Done',
			tone: 'success',
			terminal: true,
			outcome: 'positive',
			count: 5,
			hiddenCount: 4,
			cards: [
				{
					id: 'ddd44444',
					headline: 'Ship v1',
					href: '/modules/task/tasks/p/p1/ddd44444',
					priority: 'medium',
					priorityText: 'Medium',
					tone: 'success',
					updatedAt: '2026-11-13T11:00:00.000Z',
				},
			],
		},
	];
}
