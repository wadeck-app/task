// Test data for ProjectAccordion: the shape of `projects` as the Tree route answers it.
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
		hiddenCount: 0,
		moreText: null,
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
	rows: [],
});

/** alpha (2 rows), beta (1 open of 10), a broken one and an empty one, in name order. */
export const SAMPLE: ProjectData[] = [
	project('alpha', { open: 2, total: 4 }),
	project('beta', { open: 9, total: 10 }),
	broken,
	emptyProject,
];
