import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_VIEWS_DIR, generateTaskPage, taskPageFile } from '../../../../scripts/generate-task-page.mjs';

/*
 * The task page is an experiment between THREE designs, layout clones (from knowledge of the products, no access to them) of
 * GitHub (initial), Jira and GitLab: task-page.yaml is GENERATED from src/dsl-views/variants/* and holds one AbTest. These
 * tests are the contract every design keeps, so that no design silently drops a control of the page or shows a fact twice.
 * See variants/_page.yaml.
 */

type Node = Record<string, unknown>;
const packageDir = join(import.meta.dirname, '../..');
const viewsDir = join(packageDir, 'src/dsl-views');

const parse = (text: string): Node => yaml.load(text) as Node;
const page = parse(readFileSync(taskPageFile(), 'utf8'));

const isNode = (value: unknown): value is Node => value !== null && typeof value === 'object' && !Array.isArray(value);
const sections = page.sections as Node[];
// The experiment is the last section of the PageContent; the nodes before it are the notices shared by every design.
const switcher = sections[sections.length - 1] as Node;
const notices = sections.slice(0, -1);
interface Fragment {
	label: string;
	hint: string;
	view: unknown;
}
const variants = switcher.variants as Record<string, Fragment>;
const designNames = Object.keys(variants);

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

const designs = designNames.map(name => [name, variants[name]!.view] as const);

describe('the generated task-page.yaml', () => {
	it('is what the generator produces now (run "npm run views --workspace=packages/app-module-task" if not)', () => {
		expect(readFileSync(taskPageFile(), 'utf8').replace(/\r\n/g, '\n')).toBe(generateTaskPage());
	});

	it('has no YAML anchors or aliases (the compiler would have to expand them)', () => {
		expect(readFileSync(taskPageFile(), 'utf8')).not.toMatch(/(^|\s)[&*][A-Za-z0-9_-]+(\s|$)/m);
	});

	it('stays small: the three designs are not multiplied by option rows (the eleven designs were 1 MB)', () => {
		expect(readFileSync(taskPageFile(), 'utf8').length).toBeLessThan(200_000);
	});
});

describe('the experiment', () => {
	it('is ONE AbTest "Task page" at the page root: github (initial), jira, gitlab, in that order', () => {
		expect(sections.filter(s => s.$type === 'AbTest')).toHaveLength(1);
		expect(switcher.$type).toBe('AbTest');
		expect(switcher.id).toBe('task-design');
		expect(switcher.label).toBe('Task page');
		expect(switcher.initial).toBe('github');
		expect(designNames).toEqual(['github', 'jira', 'gitlab']);
		// The PageContent must not cap the designs at its own 72rem centred column: each design sets its width.
		expect(page.maxWidth).toBe('full');
	});

	it('has no other row in the dock: none of the old dimensions and no nested option (the designs are decided, not tuned)', () => {
		const ids: unknown[] = [];
		walk(
			designs.map(d => d[1]),
			node => {
				if (node.$type === 'AbTest') ids.push(node.id);
			}
		);
		expect(ids).toEqual([]);
		const text = readFileSync(taskPageFile(), 'utf8');
		for (const gone of [
			'task-title',
			'task-header',
			'task-controls',
			'task-width',
			'dim.title',
			'VariantSwitcher',
		]) {
			expect(text, gone).not.toContain(gone);
		}
		// The eleven old designs and the three that replaced them (issue, bar, flow).
		for (const gone of [
			'github-a',
			'github-b',
			'gitlab-a',
			'jira-b',
			'linear-a',
			'notion-b',
			'current',
			'issue',
			'bar',
			'flow',
		]) {
			expect(designNames).not.toContain(gone);
			expect(existsSync(join(viewsDir, 'variants', `${gone}.yaml`)), gone).toBe(false);
		}
	});

	it('names every design with a label and a hint', () => {
		for (const name of designNames) {
			expect(variants[name]!.label, `${name} label`).toMatch(/\S/);
			expect(variants[name]!.hint, `${name} hint`).toMatch(/\S/);
		}
	});

	it('draws nothing until the task is loaded (the notices say why when there is no task), and sets its own width', () => {
		for (const [name, view] of designs) {
			const root = view as Node;
			expect(root.$if, `${name}: the root needs $if: $sources.detail.task`).toBe('$sources.detail.task');
			const frame = nodesOf(root).find(n => n.$type === 'task:WidthFrame');
			expect(frame, `${name}: no WidthFrame`).toBeDefined();
			expect(['wide', 'full'], `${name}: width`).toContain(frame!.width);
		}
	});

	// The extension point task:project-header sits OUTSIDE the switcher: every design has it by construction.
	it('has the slot task:project-header outside the switcher, once, whatever the design', () => {
		const slots = nodesOf(notices).filter(n => n.$type === 'ExtensionSlot');
		expect(slots).toEqual([
			{ $type: 'ExtensionSlot', $if: '$sources.projectHeader', items: '$sources.projectHeader' },
		]);
		expect(notices[0]).toMatchObject({ $type: 'task:ChipRow', $if: '$route.project' });
		expect(page.$sources).toHaveProperty('projectHeader.url', 'GET /api/slots/task:project-header');
		for (const [name, view] of designs) {
			expect(
				nodesOf(view).filter(n => n.$type === 'ExtensionSlot' && n.items === '$sources.projectHeader'),
				name
			).toEqual([]);
		}
	});

	// task:Notice everywhere (same radius, padding and text as the controls; a dsl-ui Badge is a one-line 22px pill). The answer of the
	// delete comes BEFORE "task not found": once the task is gone the page cannot draw it, and the reader meets what happened first.
	it('keeps the notices OUTSIDE the switcher, so every design has the same error and empty states (and the delete answer survives the task)', () => {
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
		expect(notices.slice(1).map(n => [n.$if, n.label, n.variant, n.$type])).toEqual(
			expected.map(([condition, label, variant]) => [condition, label, variant, 'task:Notice'])
		);
	});
});

// Each fact is shown ONCE per design, where it is edited: the id in the header, the status in one control, and so on. A binding
// counts when a node DISPLAYS it (a prop other than $if, params, initialData, or the `value` that marks the current choice of a popover).
describe('every fact is shown once per design (single source of truth)', () => {
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
		{
			fact: 'status',
			bindings: ['$sources.detail.task.status', '$sources.detail.pillTexts.status'],
			exactlyOnce: true,
		},
		{
			fact: 'labels',
			bindings: ['$sources.detail.labelList', '$sources.detail.pillTexts.labels'],
			exactlyOnce: true,
		},
		{
			fact: 'parent',
			bindings: [
				'$sources.detail.parentRow.titleText',
				'$sources.detail.pillTexts.parent',
				'$sources.detail.parentRow',
			],
			exactlyOnce: true,
		},
		{ fact: 'created', bindings: ['$sources.detail.createdAt', '$sources.detail.createdText'], exactlyOnce: true },
		// GitHub shows when the issue was opened, not when it was last updated.
		{ fact: 'updated', bindings: ['$sources.detail.updatedAt', '$sources.detail.updatedText'], exactlyOnce: false },
		{
			fact: 'sub-tasks',
			bindings: ['$sources.detail.checklistRows', '$sources.detail.children'],
			exactlyOnce: true,
		},
		{
			fact: 'metadata',
			bindings: ['$sources.detail.metaEntries', '$sources.detail.metaList', '$sources.detail.metaRows'],
			exactlyOnce: true,
		},
		// The activity (one feed, filtered by its tabs) and the comments (the Comments tab) come from their own sources; the
		// old Timeline of the detail answer is not drawn any more.
		{ fact: 'activity', bindings: ['$sources.activity.rows'], exactlyOnce: true },
		{ fact: 'comments', bindings: ['$sources.comments.comments'], exactlyOnce: true },
		{
			fact: 'blocked',
			bindings: ['$sources.detail.blockedText', '$sources.detail.pillTexts.blocked'],
			exactlyOnce: false,
		},
		// The project is in the shell crumb; the whole task is the title and the body.
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

	it.each(designs)(
		'%s: the project and the whole title are not repeated (the crumb names the project, the headline is the title)',
		(name, view) => {
			const text = JSON.stringify(view);
			for (const gone of [
				'detail.projectText',
				'detail.task.title',
				'titleShort',
				'hasShortTitle',
				'descriptionText',
				'hasDescription',
			]) {
				expect(text, `${name}: ${gone}`).not.toContain(gone);
			}
		}
	);

	it.each(designs)(
		'%s: the status is ONE compact task:StatusSelect (no stepper, no visible list of statuses), the type a popover with a "None" choice',
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
			// A stepper or any always-visible list of the statuses is pollution: the list only matters at transition time.
			expect(
				nodes.filter(n => n.$type === 'task:SegmentedControl'),
				name
			).toEqual([]);
			const text = JSON.stringify(view);
			for (const gone of ['statusChoices', 'setStatusTo', 'detail.pillTexts']) {
				expect(text, `${name}: ${gone}`).not.toContain(gone);
			}
			const typePopovers = nodes.filter(n => n.$type === 'task:PropertyPopover' && n.action === 'setType');
			for (const popover of typePopovers) expect(popover.options, name).toBe('$sources.detail.typeOptions');
		}
	);
});

// A logical control of the page -> the props that can provide it. A design keeps every control.
describe.each(designs)('design %s keeps every control of the task page', (name, view) => {
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
	];
	const actionsRun = new Set<string>();
	for (const node of nodes) {
		for (const prop of actionProps) if (typeof node[prop] === 'string') actionsRun.add(node[prop] as string);
		if (Array.isArray(node.closeOnActions)) (node.closeOnActions as string[]).forEach(a => actionsRun.add(a));
		if (typeof node.onSubmit === 'string' && node.onSubmit.startsWith('$ctx.'))
			actionsRun.add(node.onSubmit.slice(5));
	}
	// removeLinkRow is run by the x of the rows the links route builds (dslNodes.ts), which the design draws as a slot.
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
		['add a link', ['addLink']],
		['remove a link', ['removeLinkRow']],
		['edit the title and the body', ['setText']],
		['add a sub-task', ['createSubtask']],
		['tick a sub-task', ['setChildStatus']],
		['delete the task', ['deleteTask']],
	])('can %s', (_feature, names) => {
		expect(
			names.filter(n => actionsRun.has(n)),
			`${name} cannot ${_feature}`
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
		const link = pickers.find(n => n.action === 'addLink')!;
		expect(link, `${name}: link picker`).toBeDefined();
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

	// The list of the sub-tasks is ONE checklist (rows, boxes, statuses of the config); the add row (title and parent in the
	// body) is either in it or, in an "Add sub-task" popover, in a checklist without rows: the sub-tasks are never listed twice.
	it('sub-tasks: one checklist lists them, one add row creates them (title and parent in the body)', () => {
		const lists = nodes.filter(n => n.$type === 'task:TaskChecklist');
		const listing = lists.filter(n => n.rows === '$sources.detail.checklistRows');
		expect(listing, name).toHaveLength(1);
		expect(listing[0]).toMatchObject({
			doneAction: 'setChildStatus',
			reopenAction: 'setChildStatus',
			terminalStatus: '$sources.detail.terminalStatus',
			reopenStatus: '$sources.detail.reopenStatus',
		});
		const others = lists.filter(n => n !== listing[0]);
		for (const other of others) expect(other.rows, `${name}: an add-only checklist has no rows`).toEqual([]);
		const adders = lists.filter(n => n.addAction === 'createSubtask');
		expect(adders, `${name}: exactly one add row`).toHaveLength(1);
		expect(adders[0]).toMatchObject({ parentId: '$route.id', titleKey: 'title' });
	});

	it('the activity is ONE task:ActivityFeed (All / Comments / History) fed by the activity source, with the comments in its Comments tab', () => {
		const feeds = nodes.filter(n => n.$type === 'task:ActivityFeed');
		expect(feeds, name).toHaveLength(1);
		expect(feeds[0]).toMatchObject({
			rows: '$sources.activity.rows',
			filters: ['all', 'comments', 'history'],
		});
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
		// The old Timeline is gone.
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
		expect(['top', 'bottom'], name).toContain(feed.composerPosition);
	});

	it('the relations are the groups of the links route (an x per row), never a second remove form', () => {
		expect(strings.has('$sources.links.groupSections'), name).toBe(true);
		expect(nodes.filter(n => n.$type === 'Form' && n.onSubmit === '$ctx.removeLink')).toEqual([]);
	});

	it('the delete dialog shows the consequences, offers the cascade only with descendants, and never asks for the id', () => {
		const dialog = nodes.find(n => n.$type === 'Dialog')!;
		expect(dialog, `${name}: no delete dialog`).toBeDefined();
		const inside = nodesOf(dialog);
		expect(inside.some(n => n.label === '$sources.detail.deleteImpactText')).toBe(true);
		const form = inside.find(n => n.$type === 'Form')!;
		expect(form).toMatchObject({ onSubmit: '$ctx.deleteTask', initialData: '$sources.detail.forms.delete' });
		const fields = inside.filter(n => n.bind !== undefined);
		expect(fields).toEqual([
			{
				$type: 'Switch',
				$if: '$sources.detail.hasDescendants',
				label: '$sources.detail.deleteCascadeLabel',
				bind: 'cascade',
			},
		]);
		const submit = inside.find(n => n.$type === 'ButtonAction' && n.type === 'submit')!;
		expect(submit).toMatchObject({ variant: 'danger' });
		// The dialog sits behind a menu, not in the toolbar.
		expect(nodes.some(n => n.$type === 'task:PropertyPopover' && nodesOf(n).includes(dialog))).toBe(true);
		expect(nodes.filter(n => n.$type === 'ButtonLink' && n.to === '$sources.detail.taskHrefs.deleteTasks')).toEqual(
			[]
		);
	});

	it('an empty Parent never stands over nothing: it says "none"', () => {
		const parents = nodes.filter(n => n.$type === 'task:PropertyPopover' && n.label === 'Parent');
		expect(parents.length).toBe(1);
		const pill = parents[0]!;
		// A pill carries "Parent: none" itself (pillTexts); a row says `empty: none`.
		expect(
			String(pill.empty).toLowerCase() === 'none' || pill.valueText === '$sources.detail.pillTexts.parent',
			name
		).toBe(true);
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
		'commentResult',
	];
	it.each(designs)(
		'%s: one task:Notice for the error and one for the undelivered events of each result key',
		(name, view) => {
			const notices = nodesOf(view).filter(n => n.$type === 'task:Notice' || n.$type === 'Badge');
			for (const key of RESULT_KEYS) {
				for (const [field, variant] of [
					['errorText', 'danger'],
					['undeliveredText', 'warning'],
				] as const) {
					const shown = notices.filter(n => n.label === `$ctx.${key}.${field}`);
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

	it('every action has its answer shown by some design or notice (no action without a resultKey)', () => {
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
			]) {
				if (typeof node[prop] === 'string') used.add(node[prop] as string);
			}
			if (Array.isArray(node.closeOnActions)) (node.closeOnActions as string[]).forEach(a => used.add(a));
		}
		for (const s of stringsOf(tree)) {
			const m = /^\$ctx\.([A-Za-z]+)$/.exec(s);
			if (m && /^(set|add|remove|create|delete)[A-Z]/.test(m[1]!)) used.add(m[1]!);
		}
	}
	used.add('removeLinkRow');

	it('declares exactly the actions the designs run: none missing, none left over from the old designs', () => {
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
	it('are the project list, the task, its links, its activity, its comments and the slot; the four read through projectQuery (never an empty query: the shell keeps the last answer of a skipped source)', () => {
		const sources = page.$sources as Record<string, { params?: Record<string, unknown> }>;
		expect(Object.keys(sources)).toEqual(['projects', 'detail', 'links', 'activity', 'comments', 'projectHeader']);
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

describe('links and tabs: the tab strip carries History / Tasks / Tree, the breadcrumb the context', () => {
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
});

// The layouts are clones of the products (from knowledge, no access to them), adapted to our data.
describe('the layouts of the products', () => {
	const side = (name: string): Node[] => {
		const split = nodesOf(variants[name]!.view).find(n => n.$type === 'task:SplitLayout')!;
		return nodesOf(split.side);
	};
	const main = (name: string): Node[] => {
		const split = nodesOf(variants[name]!.view).find(n => n.$type === 'task:SplitLayout')!;
		return nodesOf(split.main);
	};
	const panelTitles = (nodes: Node[]): unknown[] => nodes.filter(n => n.$type === 'task:Panel').map(n => n.title);
	const feedOf = (name: string): Node => nodesOf(variants[name]!.view).find(n => n.$type === 'task:ActivityFeed')!;

	it.each(designNames)(
		'%s: a main column and a sticky right sidebar that stacks ABOVE the main column on small screens',
		name => {
			const splits = nodesOf(variants[name]!.view).filter(n => n.$type === 'task:SplitLayout');
			expect(splits, name).toHaveLength(1);
			expect(splits[0]).toMatchObject({ sidePosition: 'right', sticky: true, sideFirstWhenStacked: true });
		}
	);

	it.each(designNames)(
		'%s: the delete dialog is behind an "Actions" overflow menu, the feedback block is in the main column',
		name => {
			const menu = nodesOf(variants[name]!.view).find(
				n => n.$type === 'task:PropertyPopover' && n.valueText === 'Actions'
			)!;
			expect(menu, name).toMatchObject({ appearance: 'pill', align: 'end' });
			expect(
				nodesOf(menu).some(n => n.$type === 'Dialog'),
				name
			).toBe(true);
			expect(
				main(name).filter(n => n.$type === 'task:Notice' && n.label === '$ctx.statusResult.errorText'),
				name
			).toHaveLength(1);
			expect(
				side(name).filter(n => n.$type === 'task:Notice'),
				name
			).toEqual([]);
		}
	);

	describe('jira', () => {
		it('has the Details panel on the right: the status as a prominent button first, then Type, Parent, Labels, Metadata, the dates', () => {
			const details = side('jira').find(n => n.$type === 'task:Panel')!;
			expect(details.title).toBe('Details');
			const inside = nodesOf(details.items);
			const status = inside.find(n => n.$type === 'task:StatusSelect')!;
			expect(status.appearance).toBe('button');
			const order = inside
				.filter(n =>
					[
						'task:StatusSelect',
						'task:PropertyPopover',
						'task:LabelCombobox',
						'task:MetaEditor',
						'RelativeDate',
					].includes(String(n.$type))
				)
				.map(n => (n.$type === 'task:PropertyPopover' ? n.label : n.$type));
			expect(order).toEqual([
				'task:StatusSelect',
				'Type',
				'Parent',
				'task:LabelCombobox',
				'task:MetaEditor',
				'RelativeDate',
				'RelativeDate',
			]);
		});

		it('has an action row under the title (Add sub-task, Link, Actions), the description, Child items with a progress bar, Linked items', () => {
			const strings = stringsOf(variants.jira!.view);
			for (const label of ['Add sub-task', 'Add link', 'Actions']) expect(strings, label).toContain(label);
			expect(panelTitles(main('jira'))).toEqual(['Description', 'Child items', 'Linked items', 'Activity']);
			const checklist = main('jira').find(
				n => n.$type === 'task:TaskChecklist' && n.rows === '$sources.detail.checklistRows'
			)!;
			expect(checklist.progress).toBe('bar');
		});

		it('puts the comment composer on top of the activity block, like Jira', () => {
			expect(feedOf('jira')).toMatchObject({ composerPosition: 'top' });
			expect(feedOf('jira').filterAppearance ?? 'tabs').toBe('tabs');
		});
	});

	describe('github', () => {
		it('has a header with the Open / Closed state badge in the tone of the status, the short id and when it was opened', () => {
			const badges = nodesOf(variants.github!.view).filter(n => n.$type === 'task:StatusBadge');
			expect(badges.map(n => [n.label, n.$if]).sort()).toEqual([
				['$sources.detail.task.id', undefined],
				['Closed', '$sources.detail.isTerminal'],
				['Open', '$sources.detail.isOpen'],
			]);
			// The id is neutral, the state takes the colour of the status.
			for (const badge of badges.filter(n => n.label !== '$sources.detail.task.id')) {
				expect(badge.tone).toBe('$sources.detail.statusTone');
			}
			expect(
				nodesOf(variants.github!.view).some(
					n => n.$type === 'RelativeDate' && n.date === '$sources.detail.createdAt'
				)
			).toBe(true);
		});

		it('draws the description in a bordered card with a header strip, then the sub-tasks and relations as cards', () => {
			expect(panelTitles(main('github'))).toEqual(['Description', 'Sub-tasks', 'Relations', 'Activity']);
			expect(main('github').find(n => n.$type === 'task:Panel')).toMatchObject({ appearance: 'strip' });
		});

		it('has a sidebar of sections separated by dividers, and the composer at the bottom of the activity', () => {
			const dividers = side('github').filter(n => n.$type === 'Divider');
			expect(dividers.length).toBeGreaterThanOrEqual(4);
			expect(panelTitles(side('github'))).toEqual(['Status', 'Type', 'Parent', 'Labels', 'Metadata']);
			expect(feedOf('github')).toMatchObject({ composerPosition: 'bottom' });
		});
	});

	describe('gitlab', () => {
		it('has the state badge and the actions on the right of the header, Child items with a count and a progress bar, Linked items', () => {
			const badges = nodesOf(variants.gitlab!.view).filter(n => n.$type === 'task:StatusBadge');
			expect(badges.map(n => n.label).sort()).toEqual(['$sources.detail.task.id', 'Closed', 'Open']);
			expect(panelTitles(main('gitlab'))).toEqual(['Child items', 'Linked items', 'Activity']);
			const child = main('gitlab').find(n => n.$type === 'task:Panel' && n.title === 'Child items')!;
			expect(child.count).toBe('$sources.detail.childrenSummary.total');
			expect(
				nodesOf(child).find(
					n =>
						n.$type === 'task:TaskChecklist' &&
						n.rows !== undefined &&
						n.rows !== '$sources.detail.checklistRows'
				)
			).toBeDefined();
			expect(
				main('gitlab').find(
					n => n.$type === 'task:TaskChecklist' && n.rows === '$sources.detail.checklistRows'
				)!.progress
			).toBe('bar');
		});

		it('has a filter dropdown (All activity / Comments only / History only) and the composer under the feed', () => {
			expect(feedOf('gitlab')).toMatchObject({ filterAppearance: 'select', composerPosition: 'bottom' });
		});

		it('has collapsible sidebar sections with an Edit link, and a footer with the dates', () => {
			const sections = side('gitlab').filter(n => n.$type === 'task:Panel');
			expect(sections.map(n => n.title)).toEqual(['Status', 'Type', 'Parent', 'Labels', 'Metadata']);
			for (const section of sections) expect(section.collapsible, String(section.title)).toBe(true);
			const edits = side('gitlab').filter(n => n.$type === 'task:PropertyPopover' && n.actionLabel === 'Edit');
			expect(edits.length).toBeGreaterThanOrEqual(2);
			expect(side('gitlab').filter(n => n.$type === 'RelativeDate')).toHaveLength(2);
		});
	});
});

// Built-in node types the installed shell is known to render: the ones the pages already use plus those checked in the shell
// (dsl-ui >= 318). Adding a type here is a decision: check it in the shell first.
const BUILTIN = new Set([
	'AbTest',
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
		if (!existsSync(file)) return null;
		const match = /const EXPECTED = \[([\s\S]*?)\];/.exec(readFileSync(file, 'utf8'));
		return match ? [...match[1]!.matchAll(/'(\w+)'/g)].map(m => m[1]!) : null;
	})();

	it('every $type is a built-in known to the shell or a task:<Name> the dsl-lib exports', () => {
		expect(libExpected, 'packages/dsl-lib-task/test/libEntries.test.ts EXPECTED list not found').not.toBeNull();
		const problems: string[] = [];
		for (const [name, view] of [...designs, ['notices', notices] as const]) {
			for (const node of nodesOf(view)) {
				const type = node.$type;
				if (typeof type !== 'string') continue;
				if (type.startsWith('task:')) {
					if (!libExpected!.includes(type.slice(5)))
						problems.push(
							`${name}: ${type} is not exported by dsl-lib-task (EXPECTED: ${libExpected!.join(', ')})`
						);
				} else if (!BUILTIN.has(type) && !(type === 'PageContent' || type === 'ExtensionSlot')) {
					problems.push(`${name}: ${type} is not a known built-in (see BUILTIN in this test)`);
				}
			}
		}
		expect([...new Set(problems)]).toEqual([]);
	});

	it('uses the new components with the props they declare (a typo would be ignored by the shell)', () => {
		const known: Record<string, string[]> = {};
		const entries = readFileSync(
			join(import.meta.dirname, '../../../dsl-lib-task/src/generated/entries.tsx'),
			'utf8'
		);
		for (const m of entries.matchAll(/(\w+)Entry\.knownKeys = (\[[^\]]*\])/g))
			known[m[1]!] = JSON.parse(m[2]!) as string[];
		const problems: string[] = [];
		for (const [name, view] of designs) {
			for (const node of nodesOf(view)) {
				const type = String(node.$type);
				if (!type.startsWith('task:')) continue;
				const keys = known[type.slice(5)];
				if (!keys) continue;
				for (const key of Object.keys(node)) {
					if (!['$type', '$if'].includes(key) && !keys.includes(key))
						problems.push(`${name}: ${type} has no prop "${key}"`);
				}
			}
		}
		expect(problems).toEqual([]);
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
			'_page.yaml':
				'$sources: {}\n$type: PageContent\n$notices: []\n$experiment: { id: t, label: T, initial: a, variants: [a] }\n',
			'_shared.yaml': 'x: { $type: Badge, label: x }\n',
			'a.yaml': 'label: A\nhint: h\nview: { $use: x }\n',
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
				$type: 'AbTest',
				id: 't',
				label: 'T',
				initial: 'a',
				variants: {
					a: {
						label: 'A',
						hint: 'h',
						view: {
							$type: 'VerticalStack',
							$if: '$sources.detail.task',
							gap: 'gap-0',
							items: [{ $type: 'Badge', label: 'x' }],
						},
					},
				},
			},
		]);
	});

	it('expands a $use that is a list or an object inside a props, not only a node', () => {
		const out = parse(
			generateTaskPage(
				scratch({
					'_shared.yaml':
						'x: { $type: Badge, label: x }\nlist:\n  - { $type: Badge, label: l1 }\np: { id: 1 }\n',
					'a.yaml': 'label: A\nhint: h\nview: { $type: Y, params: { $use: p }, items: { $use: list } }\n',
				})
			)
		);
		const view = ((out.sections as Node[])[0]!.variants as Record<string, Fragment>).a!.view as Node;
		const inner = (view.items as Node[])[0]!;
		expect(inner.params).toEqual({ id: 1 });
		expect(inner.items).toEqual([{ $type: 'Badge', label: 'l1' }]);
	});

	it('puts the experiment in the `items` of $wrap and merges $page into the PageContent', () => {
		const out = parse(
			generateTaskPage(
				scratch({
					'_page.yaml':
						'$type: PageContent\n$page: { maxWidth: full }\n$wrap: { $type: task:WidthFrame }\n$notices: []\n$experiment: { id: t, label: T, initial: a, variants: [a] }\n',
				})
			)
		);
		expect(out.maxWidth).toBe('full');
		const [wrapper] = out.sections as Node[];
		expect(wrapper).toMatchObject({ $type: 'task:WidthFrame' });
		expect((wrapper!.items as Node[]).map(n => n.$type)).toEqual(['AbTest']);
	});

	it.each([
		[
			'an unknown $use',
			{ 'a.yaml': 'label: A\nhint: h\nview: { $use: nope }\n' },
			/unknown \$use "nope".*Shared fragments: x/s,
		],
		[
			'a $use cycle',
			{ '_shared.yaml': 'x: { $use: y }\ny: { $use: x }\n', 'a.yaml': 'label: A\nhint: h\nview: { $use: x }\n' },
			/cycle x -> y -> x/,
		],
		['a $use with other keys', { 'a.yaml': 'label: A\nhint: h\nview: { $use: x, label: z }\n' }, /no other key/],
		['a fragment without hint', { 'a.yaml': 'label: A\nview: { $type: Badge }\n' }, /missing: hint/],
		[
			'a missing design file',
			{
				'_page.yaml':
					'$type: PageContent\n$notices: []\n$experiment: { id: t, label: T, initial: a, variants: [a, b] }\n',
			},
			/b\.yaml.*is missing/s,
		],
		[
			'a duplicate design',
			{
				'_page.yaml':
					'$type: PageContent\n$notices: []\n$experiment: { id: t, label: T, initial: a, variants: [a, a] }\n',
			},
			/listed twice/,
		],
		['an unlisted fragment file', { 'zzz.yaml': 'label: Z\nhint: h\nview: {}\n' }, /zzz\.yaml.*not listed/s],
		[
			'an initial that is not a design',
			{
				'_page.yaml':
					'$type: PageContent\n$notices: []\n$experiment: { id: t, label: T, initial: q, variants: [a] }\n',
			},
			/initial "q"/,
		],
	])('%s', (_label, files, message) => {
		expect(() => generateTaskPage(scratch(files))).toThrow(message);
	});

	it('every error tells where to read how a design is added', () => {
		expect(() => generateTaskPage(scratch({ 'a.yaml': 'label: A\n' }))).toThrow(/_page\.yaml/);
	});

	it('the real folder lists exactly the fragment files it contains', () => {
		const files = readdirSync(join(DEFAULT_VIEWS_DIR, 'variants')).filter(f => f.endsWith('.yaml'));
		expect(files.sort()).toEqual(['_page.yaml', '_shared.yaml', ...designNames.map(n => `${n}.yaml`)].sort());
		expect(viewsDir).toContain('dsl-views');
	});
});

// A badge in a row with pills and buttons is the same control: the 32px height token, not the 22px of a dsl-ui Badge nor the
// 28px of a padded badge (measured in a browser before this rule). The header row of every design holds the state badge, the
// id and the Actions menu.
describe('the header row of every design', () => {
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
			// Jira shows the status as a button of the sidebar and has no state badge.
			expect(states, name).toHaveLength(name === 'jira' ? 0 : 2);
			for (const badge of [...ids, ...states]) {
				expect(badge.$type, `${name}: ${String(badge.label)}`).toBe('task:StatusBadge');
				expect(badge.size, `${name}: ${String(badge.label)}`).toBe('control');
			}
		}
	);
});
