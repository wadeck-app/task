import {
	detailHref,
	encodedProject,
	pageHrefs,
	pageLink,
	selectedQuery,
	showAllToggle,
	tasksPageHref,
} from './hrefs.js';

const project = { path: '/p/my proj' };

describe('hrefs', () => {
	it('encodes the project in every link', () => {
		expect(encodedProject(project)).toBe('%2Fp%2Fmy%20proj');
		expect(tasksPageHref(project.path)).toBe('/modules/task/tasks?project=%2Fp%2Fmy%20proj');
		expect(detailHref(project, 'abc')).toBe('/modules/task/tasks/abc?project=%2Fp%2Fmy%20proj');
	});

	it('appends the extra parameters encoded', () => {
		expect(pageLink(project, 'tasks', { parent: 'a b', showAll: 'true' })).toBe(
			'/modules/task/tasks?project=%2Fp%2Fmy%20proj&parent=a%20b&showAll=true'
		);
	});

	it('links the pages with the project selected, except the project list', () => {
		const hrefs = pageHrefs(project);
		expect(hrefs['tree']).toBe('/modules/task/tree?project=%2Fp%2Fmy%20proj');
		expect(hrefs['projects']).toBe('/modules/task/projects');
	});

	it('flips showAll while keeping the other parameters', () => {
		expect(showAllToggle(project, 'tasks', false, { parent: 'p1' })).toEqual({
			label: 'Show closed tasks',
			href: '/modules/task/tasks?project=%2Fp%2Fmy%20proj&parent=p1&showAll=true',
		});
		expect(showAllToggle(project, 'tasks', true, { parent: 'p1' })).toEqual({
			label: 'Hide closed tasks',
			href: '/modules/task/tasks?project=%2Fp%2Fmy%20proj&parent=p1',
		});
	});

	it('builds the source query: empty without project, else the project and the page filters', () => {
		expect(selectedQuery(undefined, { showAll: 'true' })).toBe('');
		expect(selectedQuery(project.path, { showAll: 'true', parent: '', id: 'x y', other: 'ignored' })).toBe(
			'project=%2Fp%2Fmy%20proj&showAll=true&id=x%20y'
		);
	});
});
