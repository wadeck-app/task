import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { taskPageFile } from '../../../../scripts/generate-task-page.mjs';

import { setup } from './routeHarness.js';
import type { Harness } from './routeHarness.js';

// The page's `createSubtask` action, the props of every task:TaskChecklist that runs it, and the route behind it must agree:
// the component builds the body from `titleKey` / `parentKey` / `parentId` and the url from `params`; this test sends exactly
// that request to the route and reads the answer the way the shell does (a JSON object, 201).

type Node = Record<string, unknown>;
const isNode = (value: unknown): value is Node => value !== null && typeof value === 'object' && !Array.isArray(value);
const page = yaml.load(readFileSync(taskPageFile(), 'utf8')) as Node;

function nodesOf(tree: unknown, found: Node[] = []): Node[] {
	if (Array.isArray(tree)) tree.forEach(item => nodesOf(item, found));
	else if (isNode(tree)) {
		found.push(tree);
		Object.values(tree).forEach(item => nodesOf(item, found));
	}
	return found;
}

// The defaults of the component (TaskChecklist.tsx): a prop left out of the yaml takes these.
const COMPONENT_TITLE_KEY = 'description';
const COMPONENT_PARENT_KEY = 'parent';

const actions = page['$actions'] as Record<string, { url: string; resultKey: string; reloadSources?: boolean }>;
const adders = nodesOf(page).filter(n => n.$type === 'task:TaskChecklist' && n.addAction === 'createSubtask');

let h: Harness;
let project: string;
let parent: string;
beforeEach(async () => {
	h = setup();
	project = await h.world.createProject('alpha');
	const created = await h.call('POST /tasks', { query: { project }, body: { description: 'parent' } });
	parent = created.body['task'].id as string;
});
afterEach(() => h.world.cleanup());

describe('createSubtask: action, component props and route agree', () => {
	it('is declared once, as a POST of /tasks with the project and inline errors, and reloads the sources', () => {
		const action = actions['createSubtask']!;
		expect(action.url).toBe('POST /api/modules/task/tasks?project={projectParam}&inlineErrors=true');
		expect(action.resultKey).toBe('subtaskResult');
		expect(action.reloadSources).toBe(true);
	});

	it('is run by at least one TaskChecklist, and every one gives the parent and the project', () => {
		expect(adders.length).toBeGreaterThan(0);
		for (const adder of adders) {
			expect(adder.parentId, 'the sub-task needs its parent').toBe('$route.id');
			expect(adder.params, 'the url needs {projectParam}').toMatchObject({
				projectParam: '$sources.detail.projectParam',
			});
		}
	});

	it('the route behind the url exists', () => {
		const [method, rest] = actions['createSubtask']!.url.split(' ') as [string, string];
		const subPath = rest.replace('/api/modules/task', '').split('?')[0]!;
		expect(h.routes.has(`${method} ${subPath}`)).toBe(true);
	});

	it.each(adders.map((adder, index) => [index, adder] as const))(
		'the request built by TaskChecklist #%s is a sub-task of the page task (201, JSON, parent set)',
		async (_index, adder) => {
			const titleKey = (adder.titleKey as string | undefined) ?? COMPONENT_TITLE_KEY;
			const parentKey = (adder.parentKey as string | undefined) ?? COMPONENT_PARENT_KEY;
			// What add() sends: { [titleKey]: text, [parentKey]: parentId } (TaskChecklist.tsx).
			const body = { [titleKey]: 'a sub-task typed in the row', [parentKey]: parent };

			const answer = await h.call('POST /tasks', {
				query: { project, inlineErrors: 'true' },
				body,
			});

			expect(answer.status).toBe(201);
			expect(JSON.parse(JSON.stringify(answer.body))).toMatchObject({
				task: { parentId: parent },
				undelivered: [],
			});
			expect(answer.body['failed']).toBeUndefined();
		}
	);
});
