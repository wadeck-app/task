// Test data for the Tree page variants: the shape of `overview.projects` as the module answers it.
import type { ProjectData, ProjectRowData } from './projectTree.js';

export function row(id: string, depth: number, status = 'backlog', title = `Task ${id}`): ProjectRowData {
	return {
		id,
		title,
		status,
		tone: status === 'done' ? 'success' : 'neutral',
		depth,
		href: `/modules/task/tasks/p/x/${id}`,
	};
}

export function project(name: string, extra: Partial<ProjectData> = {}): ProjectData {
	const rows = extra.rows ?? [row(`${name}-1`, 0), row(`${name}-2`, 1, 'done')];
	const open = extra.open ?? 1;
	const total = extra.total ?? 2;
	return {
		id: `id-${name}`,
		name,
		readable: true,
		treeHref: `/modules/task/tree/p/id-${name}`,
		open,
		total,
		done: total - open,
		percent: total === 0 ? 0 : Math.round(((total - open) / total) * 100),
		empty: false,
		allDone: false,
		summaryText: `${open} open of ${total}`,
		lastAddedAt: extra.lastAddedAt === undefined ? '2026-11-01T10:00:00.000Z' : extra.lastAddedAt,
		lastAddedText:
			extra.lastAddedAt === null
				? '-'
				: (extra.lastAddedAt ?? '2026-11-01T10:00:00.000Z').slice(0, 16).replace('T', ' '),
		rowCount: rows.length,
		hiddenCount: 0,
		moreText: null,
		roots: [],
		...extra,
		rows,
	};
}

export const broken: ProjectData = {
	id: 'id-broken',
	name: 'broken',
	readable: false,
	treeHref: '/modules/task/tree/p/id-broken',
	problemText: 'config file x.yml is not valid YAML. Fix the file named in the message.',
};

export const emptyProject: ProjectData = project('void', {
	open: 0,
	total: 0,
	done: 0,
	percent: 0,
	empty: true,
	summaryText: 'No tasks',
	lastAddedAt: null,
	lastAddedText: '-',
	rows: [],
});

/** alpha (2 rows, newest), beta (1 open, biggest), a broken one and an empty one, in name order. */
export const SAMPLE: ProjectData[] = [
	project('alpha', {
		open: 2,
		total: 4,
		lastAddedAt: '2026-11-05T10:00:00.000Z',
		roots: [
			{
				id: 'alpha-1',
				title: 'Alpha root',
				status: 'backlog',
				done: 1,
				total: 3,
				href: '/modules/task/tasks/p/x/alpha-1',
			},
		],
	}),
	project('beta', { open: 9, total: 10, lastAddedAt: '2026-10-01T10:00:00.000Z' }),
	broken,
	emptyProject,
];
