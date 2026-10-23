import {
	allProjectsPageHref,
	detailHref,
	encodedProject,
	historyHref,
	pageHrefs,
	pageLink,
	selectedQuery,
	showAllToggle,
	tasksPageHref,
} from './hrefs.js';
import { projectSlug } from './projectRef.js';

const project = { path: '/p/my proj' };
const slug = projectSlug(project.path);

describe('hrefs: the project of a page is a segment of its address (the breadcrumb keeps path parameters, not the query)', () => {
	it('encodes the project for the API in the forms (the actions still use ?project=<dir>)', () => {
		expect(encodedProject(project)).toBe('%2Fp%2Fmy%20proj');
	});

	it('puts the slug of the project in every per-project page address, never ?project=', () => {
		expect(tasksPageHref(project.path)).toBe(`/modules/task/tasks/p/${slug}`);
		expect(detailHref(project, 'abc')).toBe(`/modules/task/tasks/p/${slug}/abc`);
		expect(historyHref(project, 'abc')).toBe(`/modules/task/tasks/p/${slug}/abc/history`);
		expect(pageLink(project, 'tree')).toBe(`/modules/task/tree/p/${slug}`);
		expect(pageLink(project, 'types')).toBe(`/modules/task/types/p/${slug}`);
		expect(pageLink(project, 'new')).toBe(`/modules/task/tasks/p/${slug}/new`);
		expect(pageLink(project, 'delete')).toBe(`/modules/task/tasks/p/${slug}/delete`);
	});

	it('appends the extra parameters encoded, as the query of the page', () => {
		expect(pageLink(project, 'tasks', { parent: 'a b', showAll: 'true' })).toBe(
			`/modules/task/tasks/p/${slug}?parent=a%20b&showAll=true`
		);
	});

	it('links the pages that act on the project, plus the project list', () => {
		expect(pageHrefs(project)).toEqual({
			newTask: `/modules/task/tasks/p/${slug}/new`,
			deleteTasks: `/modules/task/tasks/p/${slug}/delete`,
			projects: '/modules/task/projects',
		});
	});

	it('addresses the global pages without a project', () => {
		expect(allProjectsPageHref('tasks')).toBe('/modules/task/tasks');
		expect(allProjectsPageHref('tree', true)).toBe('/modules/task/tree?showAll=true');
	});

	it('flips showAll while keeping the other parameters', () => {
		expect(showAllToggle(project, 'tasks', false, { parent: 'p1' })).toEqual({
			label: 'Show closed tasks',
			href: `/modules/task/tasks/p/${slug}?parent=p1&showAll=true`,
		});
		expect(showAllToggle(project, 'tasks', true, { parent: 'p1' })).toEqual({
			label: 'Hide closed tasks',
			href: `/modules/task/tasks/p/${slug}?parent=p1`,
		});
	});

	it('builds the source query: empty without project, else the project directory (API) and the page filters', () => {
		expect(selectedQuery(undefined, { showAll: 'true' })).toBe('');
		expect(selectedQuery(project.path, { showAll: 'true', parent: '', id: 'x y', other: 'ignored' })).toBe(
			'project=%2Fp%2Fmy%20proj&showAll=true&id=x%20y'
		);
	});
});
