import { describe, expect, it } from 'vitest';
import type { TaskTreeNode } from '@wadeck-app/task-core';

import { buildTreeOverview, DEFAULT_ROW_CAP, MAX_ROW_CAP, parseRowCap, ROOT_PREVIEW } from './treeOverview.js';

function node(id: string, status: string, children: TaskTreeNode[] = [], title = `Task ${id}`): TaskTreeNode {
	return { id, title, status, createdAt: '2026-11-01T10:00:00.000Z', children };
}

function readable(
	name: string,
	forest: TaskTreeNode[],
	extra: { open?: number; total?: number; lastAddedAt?: string | null } = {}
) {
	return {
		project: { id: `id-${name}`, name, path: `/work/${name}` },
		value: {
			forest,
			terminalStatuses: ['done'],
			figures: { open: extra.open ?? forest.length, total: extra.total ?? forest.length },
			lastAddedAt: extra.lastAddedAt === undefined ? '2026-11-03T08:30:00.000Z' : extra.lastAddedAt,
		},
	};
}

const none = { unreadableProjects: [] as Array<{ id: string; name: string; path: string; error: string }> };

describe('parseRowCap', () => {
	it('defaults, accepts 1..MAX and refuses anything else loudly', () => {
		expect(parseRowCap(undefined)).toBe(DEFAULT_ROW_CAP);
		expect(parseRowCap('5')).toBe(5);
		expect(() => parseRowCap('0')).toThrow(/rowCap/);
		expect(() => parseRowCap('abc')).toThrow(/rowCap/);
		expect(() => parseRowCap(String(MAX_ROW_CAP + 1))).toThrow(/rowCap/);
	});
});

describe('buildTreeOverview', () => {
	it('lists readable and unreadable projects together, sorted by name, with totals', () => {
		const overview = buildTreeOverview(
			{
				entries: [
					readable('zeta', [node('a1', 'backlog')], { open: 1, total: 4 }),
					readable('alpha', [node('b1', 'backlog'), node('b2', 'done')], { open: 1, total: 2 }),
				],
				unreadableProjects: [
					{ id: 'bad1', name: 'middle', path: '/work/middle', error: 'config is not valid YAML' },
				],
			},
			{ rowCap: 60 }
		);
		expect(overview.projects.map(p => p['name'])).toEqual(['alpha', 'middle', 'zeta']);
		expect(overview.totals).toEqual({ projects: 3, readable: 2, unreadable: 1, open: 2, total: 6, done: 4 });
		expect(overview.rowCap).toBe(60);
	});

	it('an unreadable project keeps its name, its tree link and the reason, and has no figures', () => {
		const overview = buildTreeOverview(
			{
				entries: [],
				unreadableProjects: [
					{ id: 'bad1', name: 'broken', path: '/work/broken', error: 'config is not valid YAML' },
				],
			},
			{ rowCap: 60 }
		);
		expect(overview.projects[0]).toMatchObject({
			id: 'bad1',
			name: 'broken',
			readable: false,
			treeHref: '/modules/task/tree/p/bad1',
			problemText: 'config is not valid YAML',
		});
		expect(overview.projects[0]).not.toHaveProperty('rows');
		expect(overview.projects[0]).not.toHaveProperty('open');
	});

	it('figures: open, total, done, percent and a summary text; an empty project says so', () => {
		const overview = buildTreeOverview(
			{
				entries: [
					readable('busy', [node('t1', 'backlog')], { open: 3, total: 4 }),
					readable('void', [], { open: 0, total: 0, lastAddedAt: null }),
					readable('finished', [], { open: 0, total: 5 }),
				],
				...none,
			},
			{ rowCap: 60 }
		);
		const byName = Object.fromEntries(overview.projects.map(p => [p['name'] as string, p]));
		expect(byName['busy']).toMatchObject({ open: 3, total: 4, done: 1, percent: 25, empty: false, allDone: false });
		expect(byName['busy']?.['summaryText']).toBe('3 open of 4');
		expect(byName['void']).toMatchObject({
			empty: true,
			allDone: false,
			summaryText: 'No tasks',
			lastAddedText: '-',
		});
		expect(byName['finished']).toMatchObject({ empty: false, allDone: true, percent: 100 });
		expect(byName['finished']?.['summaryText']).toBe('All 5 done');
	});

	it('rows are depth first with depth, link and a truncated title, cut at rowCap with the hidden count and a link', () => {
		const forest = [
			node(
				'p1',
				'backlog',
				[node('c1', 'done', [node('g1', 'backlog')]), node('c2', 'backlog')],
				'T'.repeat(200)
			),
			node('p2', 'backlog'),
		];
		const overview = buildTreeOverview({ entries: [readable('alpha', forest)], ...none }, { rowCap: 3 });
		const project = overview.projects[0]!;
		expect((project['rows'] as Array<Record<string, unknown>>).map(r => [r['id'], r['depth']])).toEqual([
			['p1', 0],
			['c1', 1],
			['g1', 2],
		]);
		expect((project['rows'] as Array<Record<string, unknown>>)[0]).toMatchObject({
			href: '/modules/task/tasks/p/id-alpha/p1',
			status: 'backlog',
		});
		expect(String((project['rows'] as Array<Record<string, unknown>>)[0]?.['titleText']).length).toBeLessThan(200);
		// c1 is `done` (terminal in the fixture): its tone says so.
		expect((project['rows'] as Array<Record<string, unknown>>).map(r => r['tone'])).toEqual([
			'neutral',
			'success',
			'neutral',
		]);
		expect(project).toMatchObject({ rowCount: 5, hiddenCount: 2 });
		expect(project['moreText']).toBe('2 more tasks: open the tree of alpha');
	});

	it('nothing hidden gives no moreText', () => {
		const overview = buildTreeOverview(
			{ entries: [readable('alpha', [node('p1', 'backlog')])], ...none },
			{ rowCap: 60 }
		);
		expect(overview.projects[0]).toMatchObject({ hiddenCount: 0, moreText: null });
	});

	it('roots: the parents with children, biggest subtree first, at most ROOT_PREVIEW, with their done/total', () => {
		const forest = [
			node('leaf', 'backlog'),
			node('small', 'backlog', [node('s1', 'done')]),
			node('big', 'backlog', [
				node('b1', 'done'),
				node('b2', 'backlog'),
				node('b3', 'done', [node('b4', 'done')]),
			]),
			...Array.from({ length: 8 }, (_, i) => node(`m${i}`, 'backlog', [node(`mc${i}`, 'backlog')])),
		];
		const overview = buildTreeOverview({ entries: [readable('alpha', forest)], ...none }, { rowCap: 60 });
		const roots = overview.projects[0]!['roots'] as Array<Record<string, unknown>>;
		expect(roots).toHaveLength(ROOT_PREVIEW);
		expect(roots[0]).toMatchObject({ id: 'big', done: 3, total: 4, href: '/modules/task/tasks/p/id-alpha/big' });
		expect(roots.map(r => r['id'])).not.toContain('leaf');
	});

	it('last added is the given date, shown as UTC minutes; absent is a dash', () => {
		const overview = buildTreeOverview(
			{
				entries: [readable('alpha', [node('p1', 'backlog')], { lastAddedAt: '2026-11-03T08:30:45.000Z' })],
				...none,
			},
			{ rowCap: 60 }
		);
		expect(overview.projects[0]).toMatchObject({
			lastAddedAt: '2026-11-03T08:30:45.000Z',
			lastAddedText: '2026-11-03 08:30',
		});
	});

	it('zero projects is an empty, valid overview', () => {
		const overview = buildTreeOverview({ entries: [], ...none }, { rowCap: 60 });
		expect(overview.projects).toEqual([]);
		expect(overview.totals).toEqual({ projects: 0, readable: 0, unreadable: 0, open: 0, total: 0, done: 0 });
	});
});
