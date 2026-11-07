import { describe, expect, it } from 'vitest';
import type { TaskTreeNode } from '@wadeck-app/task-core';

import { buildTreeProjects, countForest, ROW_CAP, unreadableSummary } from './treeProjects.js';

function node(id: string, status: string, children: TaskTreeNode[] = [], title = `Task ${id}`): TaskTreeNode {
	return { id, title, status, createdAt: '2026-11-01T10:00:00.000Z', children };
}

function readable(name: string, forest: TaskTreeNode[], extra: { open?: number; total?: number } = {}) {
	return {
		project: { id: `id-${name}`, name, path: `/work/${name}` },
		value: {
			forest,
			terminalStatuses: ['done'],
			figures: { open: extra.open ?? forest.length, total: extra.total ?? forest.length },
		},
	};
}

const none = { unreadableProjects: [] as Array<{ id: string; name: string; path: string; error: string }> };

describe('buildTreeProjects', () => {
	it('lists readable and unreadable projects together, sorted by name', () => {
		const projects = buildTreeProjects({
			entries: [
				readable('zeta', [node('a1', 'backlog')], { open: 1, total: 4 }),
				readable('alpha', [node('b1', 'backlog'), node('b2', 'done')], { open: 1, total: 2 }),
			],
			unreadableProjects: [
				{ id: 'bad1', name: 'middle', path: '/work/middle', error: 'config is not valid YAML' },
			],
		});
		expect(projects.map(p => p['name'])).toEqual(['alpha', 'middle', 'zeta']);
	});

	it('an unreadable project keeps its name, its tree link and the reason, and has no figures', () => {
		const [broken] = buildTreeProjects({
			entries: [],
			unreadableProjects: [
				{ id: 'bad1', name: 'broken', path: '/work/broken', error: 'config is not valid YAML' },
			],
		});
		expect(broken).toMatchObject({
			id: 'bad1',
			name: 'broken',
			readable: false,
			treeHref: '/modules/task/tree/p/bad1',
			problemText: 'config is not valid YAML',
		});
		expect(broken).not.toHaveProperty('rows');
		expect(broken).not.toHaveProperty('open');
	});

	it('figures: open, total, percent and a summary text; an empty project says so', () => {
		const projects = buildTreeProjects({
			entries: [
				readable('busy', [node('t1', 'backlog')], { open: 3, total: 4 }),
				readable('void', [], { open: 0, total: 0 }),
				readable('finished', [], { open: 0, total: 5 }),
			],
			...none,
		});
		const byName = Object.fromEntries(projects.map(p => [p['name'] as string, p]));
		expect(byName['busy']).toMatchObject({ open: 3, total: 4, percent: 25, empty: false, allDone: false });
		expect(byName['busy']?.['summaryText']).toBe('3 open of 4');
		expect(byName['void']).toMatchObject({ empty: true, allDone: false, summaryText: 'No tasks' });
		expect(byName['finished']).toMatchObject({ empty: false, allDone: true, percent: 100 });
		expect(byName['finished']?.['summaryText']).toBe('All 5 done');
	});

	it('rows are depth first with depth, link and a truncated title, cut at ROW_CAP with the hidden count and a link', () => {
		const leaves = Array.from({ length: ROW_CAP + 4 }, (_, i) => node(`l${i}`, 'backlog'));
		const forest = [
			node(
				'p1',
				'backlog',
				[node('c1', 'done', [node('g1', 'backlog')]), node('c2', 'backlog')],
				'T'.repeat(200)
			),
			...leaves,
		];
		const [project] = buildTreeProjects({ entries: [readable('alpha', forest)], ...none });
		const rows = project!['rows'] as Array<Record<string, unknown>>;
		expect(rows).toHaveLength(ROW_CAP);
		expect(rows.slice(0, 4).map(r => [r['id'], r['depth']])).toEqual([
			['p1', 0],
			['c1', 1],
			['g1', 2],
			['c2', 1],
		]);
		expect(rows[0]).toMatchObject({ href: '/modules/task/tasks/p/id-alpha/p1', status: 'backlog' });
		expect(String(rows[0]?.['titleText']).length).toBeLessThan(200);
		// c1 is `done` (terminal in the fixture): its tone says so.
		expect(rows.slice(0, 3).map(r => r['tone'])).toEqual(['neutral', 'success', 'neutral']);
		// 4 tasks in the first tree + ROW_CAP + 4 leaves, minus the ROW_CAP rows kept.
		expect(project).toMatchObject({ hiddenCount: 8 });
		expect(project!['moreText']).toBe('8 more tasks: open the tree of alpha');
	});

	it('nothing hidden gives no moreText', () => {
		const [project] = buildTreeProjects({ entries: [readable('alpha', [node('p1', 'backlog')])], ...none });
		expect(project).toMatchObject({ hiddenCount: 0, moreText: null });
	});

	it('answers only what the accordion reads (no leftovers of the removed designs)', () => {
		const [project] = buildTreeProjects({ entries: [readable('alpha', [node('p1', 'backlog')])], ...none });
		for (const gone of ['roots', 'lastAddedAt', 'lastAddedText', 'rowCount', 'done']) {
			expect(project, gone).not.toHaveProperty(gone);
		}
	});

	it('zero projects is an empty list', () => {
		expect(buildTreeProjects({ entries: [], ...none })).toEqual([]);
	});
});

describe('countForest', () => {
	it('counts every task of the forest and the closed ones among them', () => {
		const forest = [node('p', 'done', [node('c', 'backlog'), node('d', 'done')]), node('q', 'backlog')];
		expect(countForest(forest, ['done'])).toEqual({ tasks: 4, closed: 2 });
		expect(countForest([], ['done'])).toEqual({ tasks: 0, closed: 0 });
	});
});

describe('unreadableSummary', () => {
	const bad = (name: string) => ({
		id: `id-${name}`,
		name,
		path: `C:\\work\\${name}`,
		error: `config file C:\\x\\${name}.yml is not valid YAML`,
	});

	it('is null when every project could be read', () => {
		expect(unreadableSummary([])).toBeNull();
	});

	it('is ONE line: how many, which (by name), where the reason and fix are; no path, no raw error', () => {
		const text = unreadableSummary([bad('mailer'), bad('queue')])!;
		expect(text).toBe(
			'2 projects cannot be read: mailer, queue. Open one in the list below for its reason and fix.'
		);
		expect(text).not.toContain('C:');
		expect(text).not.toContain('YAML');
		expect(text).not.toContain('\n');
	});

	it('is singular for one, and names at most 5 projects before counting the rest', () => {
		expect(unreadableSummary([bad('mailer')])).toBe(
			'1 project cannot be read: mailer. Open it in the list below for its reason and fix.'
		);
		const many = unreadableSummary(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(bad))!;
		expect(many).toBe(
			'7 projects cannot be read: a, b, c, d, e and 2 more. Open one in the list below for its reason and fix.'
		);
	});
});
