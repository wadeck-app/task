import type { TaskListRow } from './taskListModel.js';

/** The clock of the tests: every relative text and every "last 24 h" range is computed from it. */
export const NOW = '2026-11-22T12:00:00.000Z';

/** Short UTC text like the route's `shortUtcTime`. */
function short(iso: string): string {
	return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function row(id: string, over: Partial<TaskListRow>): TaskListRow {
	const createdAt = over.createdAt ?? '2026-11-01T08:00:00.000Z';
	return {
		id,
		title: `Title of ${id}`,
		titleText: `Title of ${id}`,
		status: 'open',
		priority: 'medium',
		priorityText: 'medium (default)',
		priorityIsDefault: true,
		assignee: '',
		leaseText: '',
		created: short(createdAt),
		createdAt,
		href: `/modules/task/tasks/p/p1/${id}`,
		...(over.updatedAt === undefined ? {} : { updated: short(over.updatedAt) }),
		...over,
	};
}

/** Six tasks, created in the order 1..6, whose last updates do NOT follow the creation order. */
export const ROWS: TaskListRow[] = [
	row('aaaa0001', {
		title: 'Alpha login page',
		titleText: 'Alpha login page',
		createdAt: '2026-11-01T08:00:00.000Z',
		updatedAt: '2026-11-10T09:00:00.000Z',
	}),
	row('aaaa0002', {
		title: 'Bravo billing export',
		titleText: 'Bravo billing export',
		status: 'in-progress',
		priority: 'high',
		priorityText: 'high',
		priorityIsDefault: false,
		assignee: 'ann',
		leaseText: 'held until 14:00 UTC, 2 h left',
		createdAt: '2026-11-02T08:00:00.000Z',
		// Edited last: first in the default order although created second.
		updatedAt: '2026-11-22T11:30:00.000Z',
	}),
	row('aaaa0003', {
		title: 'Charlie search bug',
		titleText: 'Charlie search bug',
		status: 'done',
		priority: 'low',
		priorityText: 'low',
		priorityIsDefault: false,
		assignee: 'bob',
		createdAt: '2026-11-03T08:00:00.000Z',
		updatedAt: '2026-11-21T10:00:00.000Z',
	}),
	row('aaaa0004', {
		title: 'Delta migration of the BILLING tables',
		titleText: 'Delta migration of the BILLING tables',
		status: 'in-progress',
		priority: 'urgent',
		priorityText: 'urgent',
		priorityIsDefault: false,
		assignee: 'ann',
		createdAt: '2026-11-04T08:00:00.000Z',
		updatedAt: '2026-11-16T12:00:00.000Z',
	}),
	// An old task: no updatedAt at all.
	row('aaaa0005', {
		title: 'Echo legacy importer',
		titleText: 'Echo legacy importer',
		status: 'cancelled',
		priority: 'high',
		priorityText: 'high',
		priorityIsDefault: false,
		createdAt: '2026-11-05T08:00:00.000Z',
	}),
	row('aaaa0006', {
		title: 'Foxtrot docs',
		titleText: 'Foxtrot docs',
		createdAt: '2026-11-06T08:00:00.000Z',
		updatedAt: '2026-11-10T09:00:00.000Z',
	}),
];

/** The rows of the global list: the same tasks spread over two projects (no priority nor assignee, like the route). */
export const GLOBAL_ROWS: TaskListRow[] = ROWS.map((r, index) => ({
	id: r.id,
	title: r.title,
	titleText: r.titleText ?? r.title,
	status: r.status,
	created: r.created ?? '',
	...(r.createdAt === undefined ? {} : { createdAt: r.createdAt }),
	...(r.updatedAt === undefined ? {} : { updatedAt: r.updatedAt }),
	...(r.updated === undefined ? {} : { updated: r.updated }),
	href: r.href ?? '',
	projectName: index % 2 === 0 ? 'alpha' : 'beta',
	projectPath: index % 2 === 0 ? '/w/alpha' : '/w/beta',
}));
