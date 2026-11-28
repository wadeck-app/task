import { NOW } from './taskListFixtures.js';
import type { ProjectInfo, TaskListRow } from './taskListModel.js';

/** The projects of the global list with favorites and priority: seven favorites, one high, two normal (mango has no task), one low. */
export const PROJECT_INFOS: Array<Required<ProjectInfo>> = [
	...['apple', 'banana', 'cherry', 'damson', 'elder', 'fig', 'grape'].map(name => ({
		id: `id-${name}`,
		name,
		favorite: true,
		priority: 'normal' as const,
		count: 1,
	})),
	{ id: 'id-hotel', name: 'hotel', favorite: false, priority: 'high', count: 1 },
	{ id: 'id-mango', name: 'mango', favorite: false, priority: 'normal', count: 0 },
	{ id: 'id-nine', name: 'nine', favorite: false, priority: 'normal', count: 2 },
	{ id: 'id-lemon', name: 'lemon', favorite: false, priority: 'low', count: 1 },
];

/** Short UTC text like the route's `shortUtcTime`. */
function short(iso: string): string {
	return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** One task per project that has one ("nine" two), the rows in PROJECT_INFOS order, each updated one hour before the previous one. */
export const FAVORITE_ROWS: TaskListRow[] = PROJECT_INFOS.flatMap(project =>
	Array.from({ length: project.count }, (_unused, index) => ({ project, index }))
).map(({ project, index }, position) => {
	const updatedAt = new Date(Date.parse(NOW) - (position + 1) * 3_600_000).toISOString();
	return {
		id: `ff${position.toString().padStart(6, '0')}`,
		title: `Task ${position} of ${project.name}`,
		titleText: `Task ${position} of ${project.name}`,
		status: index === 0 ? 'open' : 'done',
		created: short(updatedAt),
		createdAt: updatedAt,
		updatedAt,
		updated: short(updatedAt),
		href: `/modules/task/tasks/p/${project.name}/ff${position}`,
		projectId: project.id,
		projectName: project.name,
		projectPath: `/w/${project.name}`,
		projectFavorite: project.favorite,
		projectPriority: project.priority,
	};
});
