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

const project = { id: 'a1b2c3d4', path: '/p/my proj' };

describe('hrefs: the project of a page is a segment of its address (the breadcrumb keeps path parameters, not the query)', () => {
	it('encodes the project for the API in the forms: the registry id (the actions use ?project=<id>)', () => {
		expect(encodedProject(project)).toBe('a1b2c3d4');
	});

	it('puts the registry id of the project in every per-project page address, never ?project= and never the directory', () => {
		expect(tasksPageHref(project)).toBe('/modules/task/tasks/p/a1b2c3d4');
		expect(detailHref(project, 'abc')).toBe('/modules/task/tasks/p/a1b2c3d4/abc');
		expect(historyHref(project, 'abc')).toBe('/modules/task/tasks/p/a1b2c3d4/abc/history');
		expect(pageLink(project, 'tree')).toBe('/modules/task/tree/p/a1b2c3d4');
		expect(pageLink(project, 'types')).toBe('/modules/task/types/p/a1b2c3d4');
		expect(pageLink(project, 'new')).toBe('/modules/task/tasks/p/a1b2c3d4/new');
		expect(pageLink(project, 'delete')).toBe('/modules/task/tasks/p/a1b2c3d4/delete');
		for (const href of [tasksPageHref(project), pageLink(project, 'tree'), detailHref(project, 'abc')]) {
			expect(href).not.toContain('?project');
			expect(href).not.toContain('proj');
			expect(href).not.toContain('~');
		}
	});

	it('appends the extra parameters encoded, as the query of the page', () => {
		expect(pageLink(project, 'tasks', { parent: 'a b', showAll: 'true' })).toBe(
			'/modules/task/tasks/p/a1b2c3d4?parent=a%20b&showAll=true'
		);
	});

	it('links the pages that act on the project, plus the project list', () => {
		expect(pageHrefs(project)).toEqual({
			newTask: '/modules/task/tasks/p/a1b2c3d4/new',
			deleteTasks: '/modules/task/tasks/p/a1b2c3d4/delete',
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
			href: '/modules/task/tasks/p/a1b2c3d4?parent=p1&showAll=true',
		});
		expect(showAllToggle(project, 'tasks', true, { parent: 'p1' })).toEqual({
			label: 'Hide closed tasks',
			href: '/modules/task/tasks/p/a1b2c3d4?parent=p1',
		});
	});

	it('builds the source query: empty without project, else the project id (API) and the page filters', () => {
		expect(selectedQuery(undefined, { showAll: 'true' })).toBe('');
		expect(selectedQuery('a1b2c3d4', { showAll: 'true', parent: '', id: 'x y', other: 'ignored' })).toBe(
			'project=a1b2c3d4&showAll=true&id=x%20y'
		);
	});
});
