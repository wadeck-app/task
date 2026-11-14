import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_VIEWS_DIR, generateTaskPage, taskPageFile } from '../../../../scripts/generate-task-page.mjs';

/*
 * The task page is ONE design (merged from the GitHub, Jira and GitLab layouts). Its seven A/B rows were baked on 2026-11-14 (the
 * first option of each is the only one left, see variants/_sections.yaml). task-page.yaml is GENERATED from
 * src/dsl-views/variants/_*.yaml. These tests are the contract the page keeps: no control is silently dropped and no fact is
 * shown twice.
 */

type Node = Record<string, unknown>;
const packageDir = join(import.meta.dirname, '../..');
const viewsDir = join(packageDir, 'src/dsl-views');

const parse = (text: string): Node => yaml.load(text) as Node;
const page = parse(readFileSync(taskPageFile(), 'utf8'));

const isNode = (value: unknown): value is Node => value !== null && typeof value === 'object' && !Array.isArray(value);
const sections = page.sections as Node[];
// The base view is the last section of the PageContent (guarded by "the task is loaded"); the nodes before it are the notices.
const base = sections[sections.length - 1] as Node;
const notices = sections.slice(0, -1);

function walk(value: unknown, visit: (node: Node, ancestors: Node[]) => void, ancestors: Node[] = []): void {
	if (Array.isArray(value)) {
		value.forEach(item => walk(item, visit, ancestors));
	} else if (isNode(value)) {
		visit(value, ancestors);
		Object.values(value).forEach(item => walk(item, visit, [...ancestors, value]));
	}
}

const nodesOf = (tree: unknown): Node[] => {
	const found: Node[] = [];
	walk(tree, node => found.push(node));
	return found;
};
const stringsOf = (tree: unknown): string[] => {
	const found: string[] = [];
	const collect = (value: unknown): void => {
		if (typeof value === 'string') found.push(value);
		else if (Array.isArray(value)) value.forEach(collect);
		else if (isNode(value)) Object.values(value).forEach(collect);
	};
	collect(tree);
	return found;
};

// The one page, named so the per-design invariants below (written for several designs) keep their shape.
const designs = [['page', base]] as const;

describe('the generated task-page.yaml', () => {
	it('is what the generator produces now (run "npm run views --workspace=packages/app-module-task" if not)', () => {
		expect(readFileSync(taskPageFile(), 'utf8').replace(/\r\n/g, '\n')).toBe(generateTaskPage());
	});

	it('has no YAML anchors or aliases (the compiler would have to expand them)', () => {
		expect(readFileSync(taskPageFile(), 'utf8')).not.toMatch(/(^|\s)[&*][A-Za-z0-9_-]+(\s|$)/m);
	});

	it('stays small: one design, not several (the eleven designs were 1 MB)', () => {
		expect(readFileSync(taskPageFile(), 'utf8').length).toBeLessThan(120_000);
	});
});

describe('the page frame', () => {
	it('has no A/B test and no design switcher left: the options were baked, the product designs are gone', () => {
		expect(nodesOf(page).filter(n => n.$type === 'AbTest')).toEqual([]);
		const text = readFileSync(taskPageFile(), 'utf8');
		for (const gone of ['AbTest', 'task-design', 'VariantSwitcher', 'github-a', 'jira-b', 'gitlab-a']) {
			expect(text, gone).not.toContain(gone);
		}
		const files = readdirSync(join(viewsDir, 'variants')).sort();
		expect(files).toEqual(['_page.yaml', '_sections.yaml', '_shared.yaml']);
	});

	it('draws nothing until the task is loaded (the notices say why when there is no task), and sets its own width', () => {
		expect(base.$if).toBe('$sources.detail.task');
		const frame = nodesOf(base).find(n => n.$type === 'task:WidthFrame');
		expect(frame, 'no WidthFrame').toBeDefined();
		expect(frame!.width).toBe('wide');
		// The PageContent must not cap the page at its own 72rem centred column.
		expect(page.maxWidth).toBe('full');
	});

	// task:Notice everywhere (same radius, padding and text as the controls; a dsl-ui Badge is a one-line 22px pill). The answer of the
	// delete comes BEFORE "task not found": once the task is gone the page cannot draw it, and the reader meets what happened first.
	it('keeps the notices OUTSIDE the view, so the page has its error and empty states (and the delete answer survives the task)', () => {
		const expected: [string, string, string][] = [
			['$sources.projects.noProjects', '$sources.projects.noProjectsText', 'info'],
			['$sources.projects.selectedProblem', '$sources.projects.selectedProblem', 'danger'],
			['$sources.projects.unknownProjectText', '$sources.projects.unknownProjectText', 'danger'],
			['$ctx.deleteResult.errorText', '$ctx.deleteResult.errorText', 'danger'],
			['$ctx.deleteResult.deletedText', '$ctx.deleteResult.deletedText', 'success'],
			['$ctx.deleteResult.undeliveredText', '$ctx.deleteResult.undeliveredText', 'warning'],
			['$sources.detail.errorText', '$sources.detail.errorText', 'danger'],
			['$sources.detail.warningText', '$sources.detail.warningText', 'warning'],
		];
		expect(notices.map(n => [n.$if, n.label, n.variant, n.$type])).toEqual(
			expected.map(([condition, label, variant]) => [condition, label, variant, 'task:Notice'])
		);
	});

	it('the project link is gone: no task:project-header slot on the detail page (the breadcrumb carries the project)', () => {
		expect(nodesOf(page).filter(n => n.$type === 'ExtensionSlot' && n.items === '$sources.projectHeader')).toEqual(
			[]
		);
		expect(Object.keys(page.$sources as Node)).not.toContain('projectHeader');
		expect(
			stringsOf(page.sections).filter(s => s.includes('project-header') || s.includes('projectHeader'))
		).toEqual([]);
		expect(JSON.stringify(page.$sources)).not.toContain('/api/slots');
	});
});

// Each fact is shown ONCE per page, where it is edited: the id in the header, the status in one control, and so on. A binding counts
// when a node DISPLAYS it (a prop other than $if, params, initialData, or the `value` that marks the current choice of a popover).
describe('every fact is shown once (single source of truth)', () => {
	const SKIP = new Set(['$type', '$if', 'params', 'initialData']);
	const shows = (node: Node, bindings: string[]): boolean =>
		Object.entries(node).some(
			([key, value]) =>
				!SKIP.has(key) &&
				!(node.$type === 'task:PropertyPopover' && key === 'value') &&
				typeof value === 'string' &&
				bindings.includes(value)
		);
	// Two nodes that can never be on screen together (a project with and without configured types, a body that adds information or not).
	const PARTITIONS = [
		'$sources.detail.hasTypes',
		'$sources.detail.noTypes',
		'$sources.detail.bodyAddsInfo',
		'$sources.detail.noBodyInfo',
	];
	const partitionOf = (ancestors: Node[], node: Node): string =>
		([...ancestors, node].map(n => n.$if).find(cond => PARTITIONS.includes(String(cond))) as string | undefined) ??
		'';
	const countsOf = (tree: unknown, bindings: string[]): Map<string, number> => {
		const counts = new Map<string, number>();
		walk(tree, (node, ancestors) => {
			if (!shows(node, bindings)) return;
			const key = partitionOf(ancestors, node);
			counts.set(key, (counts.get(key) ?? 0) + 1);
		});
		return counts;
	};

	const FACTS: Array<{ fact: string; bindings: string[]; exactlyOnce: boolean }> = [
		{ fact: 'id', bindings: ['$sources.detail.task.id'], exactlyOnce: true },
		{ fact: 'title', bindings: ['$sources.detail.headline'], exactlyOnce: true },
		{ fact: 'status', bindings: ['$sources.detail.task.status'], exactlyOnce: true },
		{ fact: 'labels', bindings: ['$sources.detail.labelList'], exactlyOnce: true },
		{
			fact: 'parent',
			bindings: ['$sources.detail.parentRow.titleText', '$sources.detail.parentRow'],
			exactlyOnce: true,
		},
		{ fact: 'created', bindings: ['$sources.detail.createdAt', '$sources.detail.createdText'], exactlyOnce: true },
		{ fact: 'updated', bindings: ['$sources.detail.updatedAt', '$sources.detail.updatedText'], exactlyOnce: true },
		{
			fact: 'sub-tasks',
			bindings: ['$sources.detail.checklistRows', '$sources.detail.children'],
			exactlyOnce: true,
		},
		{ fact: 'metadata', bindings: ['$sources.detail.metaEntries'], exactlyOnce: true },
		{ fact: 'activity', bindings: ['$sources.activity.rows'], exactlyOnce: true },
		{ fact: 'comments', bindings: ['$sources.comments.comments'], exactlyOnce: true },
		{ fact: 'blocked', bindings: ['$sources.detail.blockedText'], exactlyOnce: false },
		{ fact: 'project', bindings: ['$sources.detail.projectText', '$sources.detail.project'], exactlyOnce: false },
		{ fact: 'whole title', bindings: ['$sources.detail.task.title'], exactlyOnce: false },
	];

	it.each(designs)(
		'%s: each fact is bound by one node (two only when they cannot be on screen together)',
		(name, view) => {
			for (const { fact, bindings, exactlyOnce } of FACTS) {
				const counts = countsOf(view, bindings);
				for (const [partition, count] of counts) {
					expect(
						count,
						`${name}: "${fact}" is shown ${count} times (partition ${partition || 'always'})`
					).toBeLessThanOrEqual(1);
				}
				const total = [...counts.values()].reduce((a, b) => a + b, 0);
				if (exactlyOnce) expect(total, `${name}: "${fact}" is not shown`).toBeGreaterThanOrEqual(1);
			}
		}
	);

	it.each(designs)('%s: the project and the whole title are not repeated', (name, view) => {
		const text = JSON.stringify(view);
		for (const gone of [
			'detail.projectText',
			'detail.task.title',
			'titleShort',
			'hasShortTitle',
			'descriptionText',
		]) {
			expect(text, `${name}: ${gone}`).not.toContain(gone);
		}
	});

	it.each(designs)(
		'%s: the status is ONE task:StatusSelect pill with no label of its own (no stepper, no visible list)',
		(name, view) => {
			const nodes = nodesOf(view);
			const statusControls = nodes.filter(
				n => ['setStatus', 'setStatusTo'].includes(String(n.action)) && String(n.$type).startsWith('task:')
			);
			expect(
				statusControls.map(n => n.$type),
				name
			).toEqual(['task:StatusSelect']);
			expect(statusControls[0], name).toMatchObject({
				options: '$sources.detail.statusOptions',
				current: '$sources.detail.task.status',
				action: 'setStatus',
				bodyKey: 'status',
			});
			expect(statusControls[0], `${name}: the status pill needs no label`).not.toHaveProperty('label');
			expect(statusControls[0], name).not.toHaveProperty('appearance');
			expect(
				nodes.filter(n => n.$type === 'task:SegmentedControl'),
				name
			).toEqual([]);
			// No heading or row called Status anywhere: the pill is the whole control.
			expect(
				nodes.filter(n => n.label === 'Status' || n.title === 'Status'),
				name
			).toEqual([]);
			const text = JSON.stringify(view);
			for (const gone of ['statusChoices', 'setStatusTo', 'detail.pillTexts']) {
				expect(text, `${name}: ${gone}`).not.toContain(gone);
			}
		}
	);

	it.each(designs)(
		'%s: the type and the status are two pills of ONE row, the type to the LEFT, at the top of the sidebar',
		(name, view) => {
			const split = nodesOf(view).find(n => n.$type === 'task:SplitLayout')!;
			const sideStack = (split.side as Node[])[0]!;
			const first = (sideStack.items as Node[])[0]!;
			expect(first.$type, name).toBe('task:ChipRow');
			// Type (a pill with a list, or a free text when the project has no configured type) first, the status pill last.
			expect((first.items as Node[]).map(n => [n.$type, n.action])).toEqual([
				['task:PropertyPopover', 'setType'],
				['task:ChipRow', undefined],
				['task:StatusSelect', 'setStatus'],
			]);
			expect((first.items as Node[])[0]).toMatchObject({ label: 'Type', appearance: 'pill' });
			const types = (first.items as Node[]).slice(0, 2);
			expect(
				nodesOf(types[1]).filter(n => n.$type === 'task:InlineText' && n.action === 'setType'),
				name
			).toHaveLength(1);
			expect(
				types.map(n => n.$if),
				name
			).toEqual(['$sources.detail.hasTypes', '$sources.detail.noTypes']);
			const typePopover = nodesOf(view).filter(n => n.$type === 'task:PropertyPopover' && n.action === 'setType');
			expect(typePopover, name).toHaveLength(1);
			expect(typePopover[0]!.options).toBe('$sources.detail.typeOptions');
		}
	);
});

describe('words: nothing says "terminal", no empty text for labels and metadata', () => {
	it('no display text of the page contains "terminal" (the colour of the pill and of the dots says it)', () => {
		// Binding expressions ($sources.detail.terminalStatus) and prop names are not display texts.
		const displayed = stringsOf(page.sections).filter(s => !s.startsWith('$'));
		expect(displayed.filter(s => /terminal/i.test(s))).toEqual([]);
		const keys = nodesOf(page.sections).flatMap(n => Object.keys(n));
		expect(keys.filter(k => /^terminal$/i.test(k))).toEqual([]);
	});

	it('no "No metadata" or "No labels" text: only the chips and "+ Add" (labels and metadata are consistent)', () => {
		for (const [name, view] of designs) {
			const text = stringsOf(view).join('\n');
			expect(text, name).not.toMatch(/No metadata/i);
			expect(text, name).not.toMatch(/No labels/i);
			for (const node of nodesOf(view).filter(
				n => n.$type === 'task:MetaEditor' || n.$type === 'task:LabelCombobox'
			)) {
				expect(node, `${name}: ${String(node.$type)}`).not.toHaveProperty('emptyText');
			}
		}
	});

	it('the words of the status list come from the route: no hint about terminal statuses in the components', () => {
		const statusSelect = readFileSync(join(packageDir, '../dsl-lib-task/src/components/StatusSelect.tsx'), 'utf8');
		expect(statusSelect).not.toMatch(/hint:\s*option\.terminal/);
	});
});

// A logical control of the page -> the props that can provide it. Every resolved page keeps every control.
describe.each(designs)('page %s keeps every control of the task page', (name, view) => {
	const nodes = nodesOf(view);
	const strings = new Set(stringsOf(view));
	const actionProps = [
		'action',
		'addAction',
		'editAction',
		'removeAction',
		'setAction',
		'doneAction',
		'reopenAction',
		'detachAction',
	];
	const actionsRun = new Set<string>();
	for (const node of nodes) {
		for (const prop of actionProps) if (typeof node[prop] === 'string') actionsRun.add(node[prop] as string);
		if (Array.isArray(node.closeOnActions)) (node.closeOnActions as string[]).forEach(a => actionsRun.add(a));
		if (typeof node.onSubmit === 'string' && node.onSubmit.startsWith('$ctx.'))
			actionsRun.add(node.onSubmit.slice(5));
	}
	// removeLinkRow is run by the x of the rows the links route builds (dslNodes.ts) in the grouped list.
	if (strings.has('$sources.links.groupSections')) actionsRun.add('removeLinkRow');

	it.each([
		['change the status', ['setStatus']],
		['add a comment', ['addComment']],
		['edit a comment', ['editComment']],
		['delete a comment', ['removeComment']],
		['change the type (or clear it)', ['setType']],
		['add a label', ['addLabel']],
		['remove a label', ['removeLabelChip']],
		['add or edit a metadata entry', ['setMeta']],
		['remove a metadata entry', ['removeMetaKey']],
		['set the parent', ['setParent']],
		['detach the parent', ['removeParent']],
		['detach a sub-task from its parent', ['detachChild']],
		['add a link', ['addLink']],
		['remove a link', ['removeLinkRow']],
		['edit the title and the body', ['setText']],
		['add a sub-task', ['createSubtask']],
		['tick a sub-task', ['setChildStatus']],
		['delete the task', ['deleteTask']],
	])('can %s', (feature, names) => {
		expect(
			names.filter(n => actionsRun.has(n)),
			`${name} cannot ${feature}`
		).not.toEqual([]);
	});

	it('edits the title (body.title) and the description (body.description) with setText', () => {
		const edits = nodes.filter(n => n.$type === 'task:InlineText' && n.action === 'setText');
		expect(edits.map(n => n.valueParam).sort()).toEqual(expect.arrayContaining(['description', 'title']));
		const titleEdit = edits.find(n => n.valueParam === 'title')!;
		expect(titleEdit.value).toBe('$sources.detail.headline');
	});

	it('shows the body only when it adds information, and offers to add one otherwise', () => {
		const description = nodes.filter(n => n.$type === 'task:InlineText' && n.valueParam === 'description');
		expect(description.map(n => n.$if).sort()).toEqual([
			'$sources.detail.bodyAddsInfo',
			'$sources.detail.noBodyInfo',
		]);
		expect(description.find(n => n.$if === '$sources.detail.bodyAddsInfo')!.value).toBe('$sources.detail.body');
		expect(description.find(n => n.$if === '$sources.detail.noBodyInfo')!.value).toBe('');
	});

	it('uses the pickers: parent and link through the task search, labels through the combobox, metadata through the editor', () => {
		const pickers = nodes.filter(n => n.$type === 'task:TaskPicker');
		const parent = pickers.find(n => n.action === 'setParent')!;
		expect(parent, `${name}: parent picker`).toBeDefined();
		// A parent cannot be the task itself or one of its descendants.
		expect(parent.excludeDescendantsOf).toBe('$route.id');
		const links = pickers.filter(n => n.action === 'addLink');
		expect(links, `${name}: exactly one link picker`).toHaveLength(1);
		const link = links[0]!;
		expect(link.choices).toBe('$sources.detail.linkTypeOptions');
		expect(link.choiceKey).toBe('type');
		expect(link.bodyKey).toBe('target');
		expect(link.excludeIds).toEqual(['$route.id']);
		for (const picker of pickers)
			expect(picker.projectParam, `${name}: picker without a project`).toBe('$sources.detail.projectParam');
		expect(nodes.filter(n => n.$type === 'task:LabelCombobox')).toHaveLength(1);
		expect(nodes.filter(n => n.$type === 'task:MetaEditor')).toHaveLength(1);
		expect(nodes.find(n => n.$type === 'task:MetaEditor')).toMatchObject({
			setAction: 'setMeta',
			removeAction: 'removeMetaKey',
			entries: '$sources.detail.metaEntries',
		});
		// The popovers that hold a picker close when its action has finished.
		for (const popover of nodes.filter(
			n => n.$type === 'task:PropertyPopover' && n.items !== undefined && n.options === undefined
		)) {
			const ran = nodesOf(popover.items).flatMap(n => [
				n.action,
				n.addAction,
				n.onSubmit && String(n.onSubmit).slice('$ctx.'.length),
			]);
			const closing = (popover.closeOnActions ?? []) as string[];
			for (const action of ran.filter((a): a is string => typeof a === 'string' && closing.length > 0)) {
				expect(closing, `${name}: ${String(popover.label)} popover does not close after ${action}`).toContain(
					action
				);
			}
		}
	});

	// One checklist lists the sub-tasks (rows, boxes, detach buttons); ONE add field creates them: a row of that checklist, or the
	// form of the "Add sub-task" popup, which is a checklist without rows. The sub-tasks are never listed twice.
	it('sub-tasks: one list, one add field (title and parent in the body), a detach button on every row', () => {
		const lists = nodes.filter(n => n.$type === 'task:TaskChecklist');
		const listing = lists.filter(n => n.rows === '$sources.detail.checklistRows');
		expect(listing, name).toHaveLength(1);
		expect(listing[0]).toMatchObject({
			doneAction: 'setChildStatus',
			reopenAction: 'setChildStatus',
			detachAction: 'detachChild',
			detachIdParam: 'childId',
			terminalStatus: '$sources.detail.terminalStatus',
			reopenStatus: '$sources.detail.reopenStatus',
		});
		for (const other of lists.filter(n => n !== listing[0])) {
			expect(other.rows, `${name}: an add-only checklist has no rows`).toEqual([]);
		}
		const adders = lists.filter(n => n.addAction === 'createSubtask');
		expect(adders, `${name}: exactly one add field`).toHaveLength(1);
		expect(adders[0]).toMatchObject({ parentId: '$route.id', titleKey: 'title' });
	});

	it('the activity is ONE task:ActivityFeed (All / Comments / History) fed by the activity source, with the comments in its Comments tab', () => {
		const feeds = nodes.filter(n => n.$type === 'task:ActivityFeed');
		expect(feeds, name).toHaveLength(1);
		expect(feeds[0]).toMatchObject({ rows: '$sources.activity.rows', filters: ['all', 'comments', 'history'] });
		// The shell renders a slot prop from a LIST of nodes (a single object drew nothing: found in the browser).
		expect(Array.isArray(feeds[0]!.commentsContent), `${name}: commentsContent is a list`).toBe(true);
		expect(Array.isArray(feeds[0]!.composer), `${name}: composer is a list`).toBe(true);
		const thread = nodesOf(feeds[0]!.commentsContent).filter(n => n.$type === 'task:CommentThread');
		expect(thread, `${name}: the Comments tab holds the thread`).toHaveLength(1);
		expect(thread[0]).toMatchObject({
			comments: '$sources.comments.comments',
			editAction: 'editComment',
			removeAction: 'removeComment',
			emptyText: 'No comments yet',
		});
		expect(JSON.stringify(thread[0]!.params), name).toContain('$route.id');
		expect(
			nodes.filter(n => n.$type === 'task:Timeline'),
			name
		).toEqual([]);
		expect(JSON.stringify(view), name).not.toContain('$sources.detail.activity');
	});

	it('the comment composer is present exactly once, runs addComment, and sits inside the activity block', () => {
		const composers = nodes.filter(n => n.$type === 'task:CommentComposer');
		expect(composers, name).toHaveLength(1);
		expect(composers[0]).toMatchObject({ action: 'addComment' });
		const feed = nodes.find(n => n.$type === 'task:ActivityFeed')!;
		expect(nodesOf(feed.composer), `${name}: the composer is the feed's slot`).toContain(composers[0]);
		expect(feed.composerPosition, name).toBeUndefined();
	});

	it('the relations: the groups of the links route (an x per row), the empty text, never a second remove form', () => {
		expect(strings.has('$sources.links.groupSections'), name).toBe(true);
		expect(
			nodes.filter(n => n.$type === 'task:TaskRowList' && n.rows === '$sources.links.rows'),
			name
		).toEqual([]);
		expect(
			nodes.filter(n => n.$type === 'task:Caption' && n.$if === '$sources.links.noLinks'),
			name
		).toHaveLength(1);
		expect(nodes.filter(n => n.$type === 'Form' && n.onSubmit === '$ctx.removeLink')).toEqual([]);
	});

	it('an empty Parent never stands over nothing: it says "none"', () => {
		const parents = nodes.filter(n => n.$type === 'task:PropertyPopover' && n.label === 'Parent');
		expect(parents.length).toBe(1);
		expect(String(parents[0]!.empty).toLowerCase()).toBe('none');
	});
});

describe('the delete: a direct button with the existing confirmation dialog', () => {
	it.each(designs)(
		'%s: a danger task:ControlButton opens a dialog with the consequences, the cascade only with descendants, no id to retype',
		(name, view) => {
			const nodes = nodesOf(view);
			const dialog = nodes.filter(n => n.$type === 'Dialog');
			expect(dialog, name).toHaveLength(1);
			const [trigger] = dialog[0]!.trigger as Node[];
			expect(trigger, name).toMatchObject({
				$type: 'task:ControlButton',
				variant: 'danger',
				icon: 'trash',
				label: 'Delete',
			});
			// Never a menu for one action.
			expect(
				nodes.filter(n => n.valueText === 'Actions' || n.label === 'Menu' || n.label === 'Actions'),
				name
			).toEqual([]);
			const inside = nodesOf(dialog[0]!.items);
			expect(inside.some(n => n.label === '$sources.detail.deleteImpactText')).toBe(true);
			// No switch (a view reads no form state, so it could not change a sentence): one form per outcome, the label states it.
			expect(inside.filter(n => n.bind !== undefined)).toEqual([]);
			const forms = inside.filter(n => n.$type === 'Form');
			expect(forms).toHaveLength(2);
			expect(forms[0]).toMatchObject({
				onSubmit: '$ctx.deleteTask',
				initialData: '$sources.detail.forms.delete',
			});
			expect(forms[1]).toMatchObject({
				$if: '$sources.detail.hasDescendants',
				onSubmit: '$ctx.deleteTask',
				initialData: '$sources.detail.forms.deleteCascade',
			});
			const buttons = inside.filter(n => n.$type === 'ButtonAction' && n.type === 'submit');
			expect(buttons.map(n => n.label)).toEqual([
				'$sources.detail.deleteLabel',
				'$sources.detail.deleteCascadeLabel',
			]);
			expect(buttons[0]).toMatchObject({ variant: 'danger' });
			expect(
				nodes.filter(n => n.$type === 'ButtonLink' && n.to === '$sources.detail.taskHrefs.deleteTasks')
			).toEqual([]);
		}
	);

	it('the button sits at the right of the header line, the state and the id at its left', () => {
		const header = nodesOf(base).find(
			n =>
				n.$type === 'task:ChipRow' &&
				n.justify === 'between' &&
				Array.isArray(n.items) &&
				nodesOf(n).some(c => c.$type === 'Dialog')
		)!;
		expect(header).toBeDefined();
		const [left, right] = header.items as Node[];
		expect(right!.$type).toBe('Dialog');
		expect(
			nodesOf(left)
				.filter(n => n.$type === 'task:StatusBadge')
				.map(n => n.label)
		).toEqual(['Open', 'Closed', '$sources.detail.task.id']);
	});
});

describe('the sidebar: GitHub look without card, Jira rows (label left, value right on ONE line)', () => {
	const split = nodesOf(base).find(n => n.$type === 'task:SplitLayout')!;
	const side = nodesOf(split.side);

	it('is a sticky right column that stacks ABOVE the main column on small screens', () => {
		expect(split).toMatchObject({ sidePosition: 'right', sticky: true, sideFirstWhenStacked: true });
		expect(nodesOf(base).filter(n => n.$type === 'task:SplitLayout')).toHaveLength(1);
	});

	it('has no card, no background and no collapsible section: no task:Panel at all', () => {
		expect(side.filter(n => n.$type === 'task:Panel' || n.$type === 'Card' || n.collapsible !== undefined)).toEqual(
			[]
		);
	});

	it('is a divider under the pills, then a divided list of inline rows: Parent, Labels, Metadata, Updated', () => {
		expect(side.filter(n => n.$type === 'Divider')).toHaveLength(1);
		const list = side.find(n => n.$type === 'task:PropertyList')!;
		expect(list).toMatchObject({ labelPlacement: 'inline', dividers: true });
		const rows = (list.items as Node[]).map(n => n.label);
		expect(rows).toEqual(['Parent', 'Labels', 'Metadata', 'Updated']);
		// The first three rows hold a 32px control: the label lines up with its text.
		for (const row of (list.items as Node[]).slice(0, 3)) expect(row.align).toBe('control');
	});

	it('shows no label text above a value (no stacked rows, no section titles)', () => {
		expect(side.filter(n => n.labelPlacement === 'stacked')).toEqual([]);
		expect(side.filter(n => typeof n.title === 'string')).toEqual([]);
	});
});

// The blocks that were A/B rows until 2026-11-14: only the first option of each is left.
describe('the blocks of the main column (the former A/B rows, baked)', () => {
	const nodes = nodesOf(base);
	const panel = (title: string): Node => nodes.find(n => n.$type === 'task:Panel' && n.title === title)!;

	it('the description is a bordered card with a header strip', () => {
		expect(panel('Description')).toMatchObject({ appearance: 'strip' });
	});

	it('the sub-tasks are a checklist whose add field is the last row, with a detach button and a progress bar', () => {
		const sub = panel('Sub-tasks');
		expect(sub.actions).toBeUndefined();
		expect(sub.count).toBe('$sources.detail.childrenSummary.total');
		const list = nodesOf(sub).find(n => n.$type === 'task:TaskChecklist')!;
		expect(list.appearance).toBeUndefined();
		expect(list.addStyle).toBeUndefined();
		expect(list).toMatchObject({
			rows: '$sources.detail.checklistRows',
			addAction: 'createSubtask',
			detachAction: 'detachChild',
			detachIdParam: 'childId',
			progress: 'bar',
		});
		expect(JSON.stringify(list.params)).toContain('projectParam');
	});

	it('the relations: groups by relation, then the add row (relation select and search on one line) as the LAST thing of the panel', () => {
		const rel = panel('Relations');
		expect(rel.actions).toBeUndefined();
		const picker = nodesOf(rel).find(n => n.$type === 'task:TaskPicker')!;
		expect(picker).toMatchObject({ layout: 'row', action: 'addLink' });
		expect(picker.choiceStyle).toBeUndefined();
		const stack = (rel.items as Node[])[0]!;
		expect((stack.items as Node[]).at(-1)).toBe(picker);
	});

	it('the activity is a plain panel with tabs (no filter dropdown); the composer is on top (the only place)', () => {
		expect(panel('Activity')).toMatchObject({ appearance: 'plain' });
		const feed = nodes.find(n => n.$type === 'task:ActivityFeed')!;
		expect(feed.filterAppearance).toBeUndefined();
		expect(feed.composerPosition).toBeUndefined();
	});
});

describe('feedback: the error and the undelivered events of every action are shown, once, in a node that wraps', () => {
	const RESULT_KEYS = [
		'statusResult',
		'typeResult',
		'labelResult',
		'metaResult',
		'parentResult',
		'linkResult',
		'linkRowResult',
		'textResult',
		'subtaskResult',
		'detachResult',
		'commentResult',
	];
	it.each(designs)(
		'%s: one task:Notice for the error and one for the undelivered events of each result key',
		(name, view) => {
			const shownNotices = nodesOf(view).filter(n => n.$type === 'task:Notice' || n.$type === 'Badge');
			for (const key of RESULT_KEYS) {
				for (const [field, variant] of [
					['errorText', 'danger'],
					['undeliveredText', 'warning'],
				] as const) {
					const shown = shownNotices.filter(n => n.label === `$ctx.${key}.${field}`);
					expect(shown, `${name}: $ctx.${key}.${field}`).toHaveLength(1);
					expect(shown[0], `${name}: ${key} ${field}`).toMatchObject({
						$type: 'task:Notice',
						$if: `$ctx.${key}.${field}`,
						variant,
					});
				}
			}
			// Nothing else reads a result key: the delete answer is read by the page-level notices only.
			expect(JSON.stringify(view)).not.toContain('$ctx.deleteResult');
		}
	);

	it.each(designs)(
		'%s: the detach Notice sits in the main column feedback block, with the other answers',
		(name, view) => {
			const split = nodesOf(view).find(n => n.$type === 'task:SplitLayout')!;
			expect(
				nodesOf(split.main).filter(n => n.label === '$ctx.detachResult.errorText'),
				name
			).toHaveLength(1);
			expect(
				nodesOf(split.side).filter(n => n.$type === 'task:Notice'),
				name
			).toEqual([]);
		}
	);

	it.each(designs)(
		'%s: no plain Badge shows an answer of an action (a Badge keeps one line; the replay command is long)',
		(name, view) => {
			const result = /^\$ctx\.\w+\.(undeliveredText|errorText)$/;
			const plain = nodesOf(view).filter(
				n => n.$type !== 'task:Notice' && typeof n.label === 'string' && result.test(n.label)
			);
			expect(
				plain.map(n => `${String(n.$type)} ${String(n.label)}`),
				name
			).toEqual([]);
		}
	);

	it('every action has its answer shown by some notice (no action without a resultKey)', () => {
		const actions = page.$actions as Record<string, { resultKey?: string }>;
		for (const [action, spec] of Object.entries(actions)) {
			expect(spec.resultKey, action).toMatch(/\w+Result$/);
		}
	});
});

describe('actions', () => {
	const actions = page.$actions as Record<string, { url: string; resultKey: string; reloadSources?: boolean }>;
	const everything = [...designs.map(d => d[1]), notices];
	const used = new Set<string>();
	for (const tree of everything) {
		for (const node of nodesOf(tree)) {
			for (const prop of [
				'action',
				'addAction',
				'editAction',
				'removeAction',
				'setAction',
				'doneAction',
				'reopenAction',
				'detachAction',
			]) {
				if (typeof node[prop] === 'string') used.add(node[prop] as string);
			}
			if (Array.isArray(node.closeOnActions)) (node.closeOnActions as string[]).forEach(a => used.add(a));
		}
		for (const s of stringsOf(tree)) {
			const m = /^\$ctx\.([A-Za-z]+)$/.exec(s);
			if (m && /^(set|add|remove|create|delete|detach)[A-Z]/.test(m[1]!)) used.add(m[1]!);
		}
	}
	// removeLinkRow is run by the rows the links route builds (grouped option) and by the flat list; both are in `used` already.
	used.add('removeLinkRow');

	it('declares exactly the actions the page runs: none missing, none left over from the old designs', () => {
		for (const name of used) expect(Object.keys(actions), `${name} is run but not declared`).toContain(name);
		expect(Object.keys(actions).sort()).toEqual([...used].sort());
	});

	it('every action asks for inline errors on the project of the page and reloads the sources (the delete too: the task is gone)', () => {
		for (const [name, action] of Object.entries(actions)) {
			expect(action.url, name).toContain('project={projectParam}');
			expect(action.url, name).toContain('inlineErrors=true');
			expect(action.reloadSources, name).toBe(true);
		}
	});

	it.each([
		[
			'setStatus',
			'POST /api/modules/task/tasks/{id}/status?project={projectParam}&inlineErrors=true',
			'statusResult',
		],
		['setType', 'POST /api/modules/task/tasks/{id}/type?project={projectParam}&inlineErrors=true', 'typeResult'],
		[
			'addLabel',
			'POST /api/modules/task/tasks/{id}/labels?project={projectParam}&inlineErrors=true',
			'labelResult',
		],
		[
			'removeLabelChip',
			'DELETE /api/modules/task/tasks/{id}/label-keys/{labelKey}?project={projectParam}&inlineErrors=true',
			'labelResult',
		],
		['setMeta', 'POST /api/modules/task/tasks/{id}/meta?project={projectParam}&inlineErrors=true', 'metaResult'],
		[
			'removeMetaKey',
			'DELETE /api/modules/task/tasks/{id}/meta-keys/{keyKey}?project={projectParam}&inlineErrors=true',
			'metaResult',
		],
		[
			'setParent',
			'POST /api/modules/task/tasks/{id}/parent?project={projectParam}&inlineErrors=true',
			'parentResult',
		],
		[
			'removeParent',
			'DELETE /api/modules/task/tasks/{id}/parent?project={projectParam}&inlineErrors=true',
			'parentResult',
		],
		// {childId} is the id of the CHILD row (not {id}: a body-less action gets the page's {id}): the route detaches it from its parent.
		[
			'detachChild',
			'DELETE /api/modules/task/tasks/{childId}/parent?project={projectParam}&inlineErrors=true',
			'detachResult',
		],
		['addLink', 'POST /api/modules/task/tasks/{id}/links?project={projectParam}&inlineErrors=true', 'linkResult'],
		[
			'removeLinkRow',
			'DELETE /api/modules/task/tasks/{id}/links?project={projectParam}&type={type}&target={targetEncoded}&inlineErrors=true',
			'linkRowResult',
		],
		['setText', 'PATCH /api/modules/task/tasks/{id}?project={projectParam}&inlineErrors=true', 'textResult'],
		['createSubtask', 'POST /api/modules/task/tasks?project={projectParam}&inlineErrors=true', 'subtaskResult'],
		[
			'setChildStatus',
			'POST /api/modules/task/tasks/{id}/status?project={projectParam}&inlineErrors=true',
			'subtaskResult',
		],
		['deleteTask', 'POST /api/modules/task/tasks/delete?project={projectParam}&inlineErrors=true', 'deleteResult'],
		[
			'addComment',
			'POST /api/modules/task/tasks/{id}/comments?project={projectParam}&inlineErrors=true',
			'commentResult',
		],
		[
			'editComment',
			'PATCH /api/modules/task/tasks/{id}/comments/{commentId}?project={projectParam}&inlineErrors=true',
			'commentResult',
		],
		[
			'removeComment',
			'DELETE /api/modules/task/tasks/{id}/comments/{commentId}?project={projectParam}&inlineErrors=true',
			'commentResult',
		],
	])('%s calls %s and publishes %s', (name, url, resultKey) => {
		expect(actions[name]!.url).toBe(url);
		expect(actions[name]!.resultKey).toBe(resultKey);
	});

	it('removing a label or a metadata key goes by base64url key (a "/" or "%" cannot travel in a path), and the components are given the keys', () => {
		const nodes = designs.flatMap(d => nodesOf(d[1]));
		for (const combo of nodes.filter(n => n.$type === 'task:LabelCombobox')) {
			expect(combo).toMatchObject({
				removeAction: 'removeLabelChip',
				labelKeys: '$sources.detail.labelKeys',
				labelParam: 'label',
			});
		}
		for (const editor of nodes.filter(n => n.$type === 'task:MetaEditor')) {
			expect(editor.keyParam).toBe('key');
		}
	});
});

describe('sources', () => {
	it('are the project list, the task, its links, its activity and its comments (no slot); the four read through projectQuery (never an empty query)', () => {
		const sources = page.$sources as Record<string, { params?: Record<string, unknown> }>;
		expect(Object.keys(sources)).toEqual(['projects', 'detail', 'links', 'activity', 'comments']);
		for (const name of ['detail', 'links', 'activity', 'comments']) {
			expect(sources[name]!.params?.query, name).toBe('$source.projects.projectQuery');
		}
	});

	it.each(designs)('%s: reads its data only from the sources of the page', (name, view) => {
		for (const s of stringsOf(view)) {
			const m = /^\$sources\.([A-Za-z]+)/.exec(s);
			if (m) expect(['projects', 'detail', 'links', 'activity', 'comments'], `${name}: ${s}`).toContain(m[1]);
		}
		expect(
			nodesOf(view).some(n => '$sources' in n || '$actions' in n),
			name
		).toBe(false);
	});
});

describe('links and tabs: the tab strip carries Tasks / Tree, the breadcrumb the context', () => {
	it.each(designs)(
		'%s: the only link is "Open parent" (a forward feature); none leads back or repeats a tab',
		(name, view) => {
			const links = nodesOf(view).filter(n => n.$type === 'ButtonLink' || n.$type === 'BackLink');
			expect(
				links.map(n => [n.label, n.to]),
				name
			).toEqual([['Open parent', '$sources.detail.parentRow.href']]);
			const text = stringsOf(view).join('\n');
			for (const gone of [
				'taskHrefs.history',
				'taskHrefs.childrenList',
				'taskHrefs.deleteTasks',
				'hrefs.tree',
				'hrefs.tasks',
				'allProjectsHref',
				'globalHrefs',
				'tasksHref',
				'taskHrefs.detail',
			]) {
				expect(text, `${name}: ${gone}`).not.toContain(gone);
			}
		}
	);

	it.each(designs)('%s: no PageHeader (the title is the InlineText) and no giant heading', (name, view) => {
		const nodes = nodesOf(view);
		expect(
			nodes.filter(n => n.$type === 'PageHeader'),
			name
		).toEqual([]);
		const title = nodes.find(n => n.$type === 'task:InlineText' && n.valueParam === 'title')!;
		expect(String(title.textClass)).toContain('text-xl');
		expect(String(title.textClass)).not.toMatch(/text-(2xl|3xl|4xl)/);
	});
});

describe('constructs of the shell', () => {
	it.each(designs)(
		'%s: forms and fields are valid for the shell (bind only inside a Form, no negation, no empty-array tests)',
		(name, view) => {
			walk(view, (node, ancestors) => {
				if ('bind' in node) {
					expect(
						ancestors.some(a => a.$type === 'Form'),
						`${name}: bind outside a Form`
					).toBe(true);
				}
				if (node.$type === 'FieldSelect') {
					const form = [...ancestors].reverse().find(a => a.$type === 'Form');
					expect(
						form?.$if,
						`${name}: FieldSelect "${String(node.label)}" is not inside a Form with $if`
					).toBeTruthy();
				}
			});
			for (const s of stringsOf(view)) {
				if (s.startsWith('$')) expect(s, `${name}: negation expression`).not.toMatch(/(^|[\s(&|])!(?!=)/);
			}
		}
	);

	it.each(designs)(
		'%s: the title and the long texts cannot widen the page (everything sits in a WidthFrame, which breaks words)',
		(name, view) => {
			const root = nodesOf(view).find(n => n.$type === 'task:WidthFrame')!;
			const outside = nodesOf(view).filter(n => !nodesOf(root).includes(n) && n.$type !== undefined);
			// Only the guard stack around the frame is outside it.
			expect(
				outside.map(n => n.$type),
				name
			).toEqual(['VerticalStack']);
		}
	);

	it.each(designs)('%s: a row of several chips is a task:ChipRow (a HorizontalStack never wraps)', (name, view) => {
		const CHIPS = ['Badge', 'task:StatusBadge', 'RelativeDate', 'Tag'];
		for (const node of nodesOf(view)) {
			if (node.$type !== 'HorizontalStack' || !Array.isArray(node.items)) continue;
			const chips = (node.items as Node[]).filter(item => CHIPS.includes(String(item.$type)));
			expect(chips.length, name).toBeLessThanOrEqual(1);
		}
	});

	it.each(designs)(
		'%s: the state badges and the id are task:StatusBadge of size control, none a dsl-ui Badge',
		(name, view) => {
			const header = nodesOf(view).filter(
				n => n.$use === undefined && (n.$type === 'Badge' || n.$type === 'task:StatusBadge')
			);
			const feedback = (n: Node): boolean => String(n.label ?? '').startsWith('$ctx.');
			const badges = header.filter(n => !feedback(n));
			const ids = badges.filter(n => n.label === '$sources.detail.task.id');
			const states = badges.filter(n => n.label === 'Open' || n.label === 'Closed');
			expect(ids, name).toHaveLength(1);
			expect(states, name).toHaveLength(2);
			for (const badge of [...ids, ...states]) {
				expect(badge.$type, `${name}: ${String(badge.label)}`).toBe('task:StatusBadge');
				expect(badge.size, `${name}: ${String(badge.label)}`).toBe('control');
			}
			// The state takes the colour of the status (red for a negative close), the id stays neutral.
			for (const badge of states) expect(badge.tone).toBe('$sources.detail.statusTone');
		}
	);
});

// Built-in node types the installed shell is known to render: the ones the pages already use plus those checked in the shell
// (dsl-ui >= 318). Adding a type here is a decision: check it in the shell first.
const BUILTIN = new Set([
	'PageContent',
	'Section',
	'Card',
	'HorizontalStack',
	'VerticalStack',
	'Collapsible',
	'Divider',
	'Badge',
	'Tag',
	'RelativeDate',
	'Popover',
	'Dialog',
	'ExtensionSlot',
	'Form',
	'FieldSelect',
	'FieldText',
	'Switch',
	'ButtonAction',
	'ButtonLink',
]);

describe('node types', () => {
	const libExpected = ((): string[] | null => {
		const file = join(import.meta.dirname, '../../../dsl-lib-task/test/libEntries.test.ts');
		const match = /const EXPECTED = \[([\s\S]*?)\];/.exec(readFileSync(file, 'utf8'));
		return match ? [...match[1]!.matchAll(/'(\w+)'/g)].map(m => m[1]!) : null;
	})();

	it('every $type is a built-in known to the shell or a task:<Name> the dsl-lib exports (the whole page, every option)', () => {
		expect(libExpected, 'packages/dsl-lib-task/test/libEntries.test.ts EXPECTED list not found').not.toBeNull();
		const problems: string[] = [];
		for (const node of nodesOf(page.sections)) {
			const type = node.$type;
			if (typeof type !== 'string') continue;
			if (type.startsWith('task:')) {
				if (!libExpected!.includes(type.slice(5))) problems.push(`${type} is not exported by dsl-lib-task`);
			} else if (!BUILTIN.has(type)) {
				problems.push(`${type} is not a known built-in (see BUILTIN in this test)`);
			}
		}
		expect([...new Set(problems)]).toEqual([]);
	});

	it('uses the components with the props they declare (a typo would be ignored by the shell), in every option', () => {
		const known: Record<string, string[]> = {};
		const entries = readFileSync(
			join(import.meta.dirname, '../../../dsl-lib-task/src/generated/entries.tsx'),
			'utf8'
		);
		for (const m of entries.matchAll(/(\w+)Entry\.knownKeys = (\[[^\]]*\])/g))
			known[m[1]!] = JSON.parse(m[2]!) as string[];
		const problems: string[] = [];
		for (const node of nodesOf(page.sections)) {
			const type = String(node.$type);
			if (!type.startsWith('task:')) continue;
			const keys = known[type.slice(5)];
			if (!keys) continue;
			for (const key of Object.keys(node)) {
				if (!['$type', '$if'].includes(key) && !keys.includes(key))
					problems.push(`${type} has no prop "${key}"`);
			}
		}
		expect(problems).toEqual([]);
	});

	it('the icons asked by name exist in the closed list of the dsl-lib', () => {
		const icons = readFileSync(join(import.meta.dirname, '../../../dsl-lib-task/src/ui/icons.ts'), 'utf8');
		const names = [...icons.matchAll(/^\t'?([\w-]+)'?: \w+,$/gm)].map(m => m[1]!);
		for (const node of nodesOf(page.sections)) {
			if (
				typeof node.icon === 'string' &&
				String(node.$type).startsWith('task:') &&
				node.$type !== 'task:StatusBadge'
			) {
				expect(names, `${String(node.$type)} icon ${node.icon}`).toContain(node.icon);
			}
		}
	});
});

describe('the generator reports what is wrong, with the fix', () => {
	const scratchDirs: string[] = [];
	afterAll(() => scratchDirs.forEach(dir => rmSync(dir, { recursive: true, force: true })));
	function scratch(files: Record<string, string>): string {
		const dir = mkdtempSync(join(tmpdir(), 'task-variants-'));
		scratchDirs.push(dir);
		mkdirSync(join(dir, 'variants'));
		const base: Record<string, string> = {
			'_page.yaml': '$sources: {}\n$type: PageContent\n$notices: []\n$view: { $use: x }\n',
			'_shared.yaml': 'x: { $type: Badge, label: x }\n',
			...files,
		};
		for (const [name, text] of Object.entries(base)) writeFileSync(join(dir, 'variants', name), text);
		return dir;
	}

	it('expands $use, keeps the verbatim head, and draws nothing until the task is loaded', () => {
		const out = generateTaskPage(scratch({}));
		expect(out).toContain('$sources: {}');
		expect(parse(out).sections).toEqual([
			{
				$type: 'VerticalStack',
				$if: '$sources.detail.task',
				gap: 'gap-0',
				items: [{ $type: 'Badge', label: 'x' }],
			},
		]);
	});

	it('expands a $use that is a list or an object inside a props, not only a node', () => {
		const out = parse(
			generateTaskPage(
				scratch({
					'_shared.yaml':
						'x: { $type: Badge, label: x }\nlist:\n  - { $type: Badge, label: l1 }\np: { id: 1 }\n',
					'_page.yaml':
						'$type: PageContent\n$notices: []\n$view: { $type: Y, params: { $use: p }, items: { $use: list } }\n',
				})
			)
		);
		const view = ((out.sections as Node[])[0]!.items as Node[])[0]!;
		expect(view.params).toEqual({ id: 1 });
		expect(view.items).toEqual([{ $type: 'Badge', label: 'l1' }]);
	});

	it('reads every fragment file _*.yaml and merges $page into the PageContent', () => {
		const out = parse(
			generateTaskPage(
				scratch({
					'_page.yaml': '$type: PageContent\n$page: { maxWidth: full }\n$notices: []\n$view: { $use: y }\n',
					'_more.yaml': 'y: { $type: Badge, label: y }\n',
				})
			)
		);
		expect(out.maxWidth).toBe('full');
		expect(JSON.stringify(out.sections)).toContain('"label":"y"');
	});

	it.each([
		[
			'an unknown $use',
			{ '_page.yaml': '$type: PageContent\n$notices: []\n$view: { $use: nope }\n' },
			/unknown \$use "nope".*Shared fragments: x/s,
		],
		['a $use cycle', { '_shared.yaml': 'x: { $use: y }\ny: { $use: x }\n' }, /cycle x -> y -> x/],
		[
			'a $use with other keys',
			{ '_page.yaml': '$type: PageContent\n$notices: []\n$view: { $use: x, label: z }\n' },
			/no other key/,
		],
		['a fragment defined twice', { '_more.yaml': 'x: { $type: Tag }\n' }, /fragment "x" is defined twice/],
		['an old design file', { 'jira.yaml': 'label: J\nhint: h\nview: {}\n' }, /jira\.yaml.*not a fragment file/s],
		['a missing $view', { '_page.yaml': '$type: PageContent\n$notices: []\n' }, /\$view must be ONE node/],
		['a missing PageContent line', { '_page.yaml': '$notices: []\n' }, /\$type: PageContent/],
	])('%s', (_label, files, message) => {
		expect(() => generateTaskPage(scratch(files))).toThrow(message);
	});

	it('every error tells where to read how the page is built', () => {
		expect(() => generateTaskPage(scratch({ 'jira.yaml': 'label: A\n' }))).toThrow(/_page\.yaml/);
	});

	it('the real folder lists exactly the fragment files it contains', () => {
		const files = readdirSync(join(DEFAULT_VIEWS_DIR, 'variants')).filter(f => f.endsWith('.yaml'));
		expect(files.sort()).toEqual(['_page.yaml', '_sections.yaml', '_shared.yaml']);
		expect(viewsDir).toContain('dsl-views');
	});
});
